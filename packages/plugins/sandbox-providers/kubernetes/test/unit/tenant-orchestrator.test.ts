import { describe, it, expect, vi } from "vitest";
import { ensureTenant } from "../../src/tenant-orchestrator.js";

function makeMockClients() {
  const calls: { kind: string; name: string; namespace?: string; body?: unknown }[] = [];
  function track(kind: string) {
    return vi.fn(async (...args: unknown[]) => {
      const arg = (args[0] ?? {}) as { name?: string; namespace?: string; body?: unknown };
      calls.push({ kind, name: arg.name ?? "", namespace: arg.namespace, body: arg.body });
      return { body: arg.body };
    });
  }
  return {
    calls,
    core: {
      createNamespace: track("Namespace"),
      readNamespacedServiceAccount: vi.fn().mockRejectedValue({ code: 404 }),
      createNamespacedServiceAccount: track("ServiceAccount"),
      readNamespacedResourceQuota: vi.fn().mockRejectedValue({ code: 404 }),
      createNamespacedResourceQuota: track("ResourceQuota"),
      readNamespacedLimitRange: vi.fn().mockRejectedValue({ code: 404 }),
      createNamespacedLimitRange: track("LimitRange"),
      readNamespace: vi.fn().mockRejectedValue({ code: 404 }),
    },
    rbac: {
      readNamespacedRole: vi.fn().mockRejectedValue({ code: 404 }),
      createNamespacedRole: track("Role"),
      readNamespacedRoleBinding: vi.fn().mockRejectedValue({ code: 404 }),
      createNamespacedRoleBinding: track("RoleBinding"),
    },
    networking: {
      readNamespacedNetworkPolicy: vi.fn().mockRejectedValue({ code: 404 }),
      createNamespacedNetworkPolicy: track("NetworkPolicy"),
      replaceNamespacedNetworkPolicy: track("ReplaceNetworkPolicy"),
    },
    custom: {
      getNamespacedCustomObject: vi.fn().mockRejectedValue({ code: 404 }),
      createNamespacedCustomObject: track("CiliumNetworkPolicy"),
      replaceNamespacedCustomObject: track("ReplaceCiliumNetworkPolicy"),
    },
  };
}

describe("ensureTenant", () => {
  const baseInput = {
    namespace: "paperclip-acme",
    companyId: "11111111-1111-1111-1111-111111111111",
    paperclipServerNamespace: "paperclip",
    serviceAccountAnnotations: {},
    egressMode: "standard" as const,
    egressAllowFqdns: ["api.anthropic.com"],
    egressAllowCidrs: [] as string[],
    resourceQuota: { pods: "20", requestsCpu: "5", requestsMemory: "20Gi", limitsCpu: "20", limitsMemory: "80Gi" },
  };

  it("creates all required resources in the correct order on a fresh tenant", async () => {
    const clients = makeMockClients();
    await ensureTenant(clients as never, baseInput);
    const order = clients.calls.map((c) => c.kind);
    expect(order).toEqual([
      "Namespace",
      "ServiceAccount",
      "Role",
      "RoleBinding",
      "ResourceQuota",
      "LimitRange",
      "NetworkPolicy",
      "NetworkPolicy",
    ]);
  });

  it("creates a CiliumNetworkPolicy instead of standard egress when egressMode=cilium", async () => {
    const clients = makeMockClients();
    await ensureTenant(clients as never, { ...baseInput, egressMode: "cilium" });
    const cnpCall = clients.calls.find((c) => c.kind === "CiliumNetworkPolicy");
    expect(cnpCall).toBeDefined();
    const npCalls = clients.calls.filter((c) => c.kind === "NetworkPolicy");
    expect(npCalls).toHaveLength(1);
    expect((npCalls[0].body as { metadata: { name: string } }).metadata.name).toBe("paperclip-deny-all");
  });

  it.each(["standard", "cilium"] as const)("passes the callback selector through tenant provisioning (%s)", async (egressMode) => {
    const clients = makeMockClients();
    await ensureTenant(clients as never, { ...baseInput, egressMode, paperclipServerPodSelector: { app: "paperclip" } });
    if (egressMode === "standard") {
      const policy = clients.calls.find((c) => c.kind === "NetworkPolicy" && (c.body as any).metadata.name === "paperclip-egress-allow");
      expect((policy?.body as any).spec.egress[1].to[0].podSelector.matchLabels).toEqual({ app: "paperclip" });
    } else {
      const policy = clients.calls.find((c) => c.kind === "CiliumNetworkPolicy");
      expect((policy?.body as any).spec.egress[2].toEndpoints[0].matchLabels).toEqual({
        app: "paperclip", "k8s:io.kubernetes.pod.namespace": "paperclip",
      });
    }
  });

  it("applies serviceAccountAnnotations to the ServiceAccount", async () => {
    const clients = makeMockClients();
    await ensureTenant(clients as never, {
      ...baseInput,
      serviceAccountAnnotations: { "eks.amazonaws.com/role-arn": "arn:aws:iam::123:role/paperclip" },
    });
    const saCall = clients.calls.find((c) => c.kind === "ServiceAccount");
    const sa = saCall!.body as { metadata: { annotations: Record<string, string> } };
    expect(sa.metadata.annotations["eks.amazonaws.com/role-arn"]).toBe("arn:aws:iam::123:role/paperclip");
  });

  it("skips creates that already exist (idempotency)", async () => {
    const clients = makeMockClients();
    clients.core.readNamespace.mockResolvedValue({ body: { metadata: { name: baseInput.namespace } } });
    await ensureTenant(clients as never, baseInput);
    expect(clients.core.createNamespace).not.toHaveBeenCalled();
  });

  it("tolerates a 409 AlreadyExists from a concurrent ensure for the same tenant", async () => {
    const clients = makeMockClients();
    // Both racers saw the 404 read; the loser's create returns 409, which means
    // the desired state exists and must not fail the lease acquisition.
    clients.core.createNamespace.mockRejectedValue({ statusCode: 409 });
    clients.core.createNamespacedServiceAccount.mockRejectedValue({ code: 409 });
    await expect(ensureTenant(clients as never, baseInput)).resolves.not.toThrow();
  });

  describe("network policy reconciliation", () => {
    async function provisionedPolicies(egressMode: "standard" | "cilium") {
      const fresh = makeMockClients();
      await ensureTenant(fresh as never, { ...baseInput, egressMode });
      return fresh.calls.filter((c) => c.kind === "NetworkPolicy" || c.kind === "CiliumNetworkPolicy");
    }

    function metadataOf(body: unknown) {
      return (body as { metadata: { name: string; annotations?: Record<string, string> } }).metadata;
    }

    it("stamps every created policy with a spec hash", async () => {
      for (const policy of await provisionedPolicies("cilium")) {
        expect(metadataOf(policy.body).annotations?.["paperclip.io/spec-hash"]).toMatch(/^[0-9a-f]{32}$/);
      }
    });

    it("leaves an up-to-date policy untouched", async () => {
      const [denyAll, egress] = await provisionedPolicies("standard");
      const clients = makeMockClients();
      clients.networking.readNamespacedNetworkPolicy.mockImplementation(async ({ name }: { name: string }) =>
        [denyAll, egress].find((p) => metadataOf(p.body).name === name)!.body,
      );
      await ensureTenant(clients as never, baseInput);
      expect(clients.networking.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled();
      expect(clients.networking.createNamespacedNetworkPolicy).not.toHaveBeenCalled();
    });

    it("replaces a pre-existing egress policy provisioned before new adapter FQDNs (e.g. OAuth hosts)", async () => {
      const clients = makeMockClients();
      // Legacy policy: no hash annotation, older egress allow-list.
      clients.custom.getNamespacedCustomObject.mockResolvedValue({
        metadata: { name: "paperclip-egress-fqdn", resourceVersion: "42" },
        spec: { egress: [] },
      });
      await ensureTenant(clients as never, {
        ...baseInput,
        egressMode: "cilium",
        egressAllowFqdns: ["api.anthropic.com", "claude.com", "platform.claude.com"],
      });
      const replaced = clients.calls.find((c) => c.kind === "ReplaceCiliumNetworkPolicy");
      expect(replaced).toBeDefined();
      const body = replaced!.body as { metadata: { resourceVersion?: string }; spec: unknown };
      expect(body.metadata.resourceVersion).toBe("42");
      expect(JSON.stringify(body.spec)).toContain("platform.claude.com");
    });

    it("replaces an egress policy whose spec hash is stale", async () => {
      const clients = makeMockClients();
      clients.networking.readNamespacedNetworkPolicy.mockResolvedValue({
        metadata: { name: "x", resourceVersion: "7", annotations: { "paperclip.io/spec-hash": "stale" } },
      });
      await ensureTenant(clients as never, baseInput);
      expect(clients.networking.replaceNamespacedNetworkPolicy).toHaveBeenCalledTimes(2);
    });

    it("keeps the old policy and warns when the operator did not grant update", async () => {
      const clients = makeMockClients();
      clients.networking.readNamespacedNetworkPolicy.mockResolvedValue({ metadata: { name: "x" } });
      clients.networking.replaceNamespacedNetworkPolicy.mockRejectedValue({ code: 403 });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        await expect(ensureTenant(clients as never, baseInput)).resolves.toBeUndefined();
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/not allowed to update/));
      } finally {
        warn.mockRestore();
      }
    });

    it("surfaces non-permission replace failures", async () => {
      const clients = makeMockClients();
      clients.networking.readNamespacedNetworkPolicy.mockResolvedValue({ metadata: { name: "x" } });
      clients.networking.replaceNamespacedNetworkPolicy.mockRejectedValue({ code: 500 });
      await expect(ensureTenant(clients as never, baseInput)).rejects.toEqual({ code: 500 });
    });
  });
});
