import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/pod-exec.js", () => ({ execInPod: vi.fn(() => { throw new Error("No pod exec in acquisition fixtures"); }), execInPodStreaming: vi.fn(), wrapCommandWithEnv: vi.fn() }));
vi.mock("../../src/login-pty-exec.js", () => ({ connectKubernetesLoginPty: vi.fn(() => { throw new Error("No login in acquisition fixtures"); }) }));
const kubeClientsFixture = vi.hoisted(() => ({
  networking: { createNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}) },
  custom: { createNamespacedCustomObject: vi.fn().mockResolvedValue({}) },
}));
vi.mock("../../src/kube-client.js", () => ({
  createKubeConfig: vi.fn(() => ({})),
  makeKubeClients: vi.fn(() => kubeClientsFixture),
}));
vi.mock("../../src/lease-lifecycle.js", () => ({ checkLeaseResumable: vi.fn().mockResolvedValue({ resumable: true, podName: "pod-1", phase: "Running" }), destroyLeaseResources: vi.fn() }));
vi.mock("../../src/tenant-orchestrator.js", () => ({ ensureTenant: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/secret-manager.js", () => ({ createPerRunSecret: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/sandbox-cr-orchestrator.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/sandbox-cr-orchestrator.js")>()),
  sandboxCrOrchestrator: {
    claim: vi.fn().mockResolvedValue({ uid: "uid-1" }),
    release: vi.fn().mockResolvedValue(undefined),
    findPod: vi.fn().mockResolvedValue("pod-1"),
  },
}));

import plugin from "../../src/plugin.js";
import { sandboxCrOrchestrator } from "../../src/sandbox-cr-orchestrator.js";

describe("onEnvironmentAcquireLease", () => {
  it("attests the run-selected Codex adapter and image separately from the Claude environment default", async () => {
    const lease = await plugin.definition.onEnvironmentAcquireLease!({
      driverKey: "kubernetes", config: { inCluster: true, backend: "sandbox-cr", adapterType: "claude_local" },
      adapterType: "codex_local", runId: "r-codex", companyId: "acme", environmentId: "env-1",
    });
    expect(lease.metadata).toMatchObject({ effectiveAdapterType: "codex_local", imageRef: expect.stringContaining("codex"), imageID: null });
  });
  it.each([true, false])("preserves provider identity on resume without inferring it from mutable config (%s)", async attested => {
    const receipt = attested ? { effectiveAdapterType: "codex_local", imageRef: "synthetic/codex:tag", imageID: null } : {};
    const lease = await plugin.definition.onEnvironmentResumeLease!({ driverKey: "kubernetes",
      config: { inCluster: true, backend: "sandbox-cr", adapterType: "claude_local" }, companyId: "acme", environmentId: "env-1",
      providerLeaseId: "lease-1", leaseMetadata: { ...receipt, namespace: "fixture", backend: "sandbox-cr" } });
    expect(lease.metadata).toMatchObject(attested ? receipt : { effectiveAdapterType: null, imageRef: null, imageID: null });
  });
  it.each([
    { agentId: "0b6f3c1e-7d2a-4e5b-9c8d-1a2b3c4d5e6f", expected: "0b6f3c1e-7d2a-4e5b-9c8d-1a2b3c4d5e6f" },
    { agentId: undefined, expected: "r-label" },
  ])("labels the sandbox pod with paperclip.io/agent-id=$expected", async ({ agentId, expected }) => {
    const claim = vi.mocked(sandboxCrOrchestrator.claim);
    claim.mockClear();
    await plugin.definition.onEnvironmentAcquireLease!({
      driverKey: "kubernetes",
      config: { inCluster: true, backend: "sandbox-cr" },
      runId: "r-label",
      companyId: "acme",
      environmentId: "env-1",
      ...(agentId ? { agentId } : {}),
    });
    const manifest = claim.mock.calls[0]![2] as {
      metadata: { labels: Record<string, string> };
      spec: { podTemplate: { metadata: { labels: Record<string, string> } } };
    };
    expect(manifest.metadata.labels["paperclip.io/agent-id"]).toBe(expected);
    expect(manifest.spec.podTemplate.metadata.labels["paperclip.io/agent-id"]).toBe(expected);
    expect(manifest.spec.podTemplate.metadata.labels["paperclip.io/run-id"]).toBe("r-label");
  });
  it("exposes /workspace as remoteCwd so adapter probes can native-sync before workspace realization", async () => {
    const lease = await plugin.definition.onEnvironmentAcquireLease!({
      driverKey: "kubernetes",
      config: { inCluster: true, backend: "sandbox-cr" },
      runId: "r-1",
      companyId: "acme",
      environmentId: "env-1",
    });
    expect(lease.metadata?.remoteCwd).toBe("/workspace");
  });
  describe("egress presets", () => {
    const agentId = "97ac1286-84c8-4430-8dc8-9e38505df1b5";
    const config = {
      inCluster: true,
      backend: "sandbox-cr",
      egressMode: "cilium",
      egressPresets: {
        github: { fqdns: ["github.com"], ports: [{ port: 443 }] },
        npm: { fqdns: ["registry.npmjs.org"], ports: [{ port: 443 }] },
      },
      agentEgressPresets: { [agentId]: ["npm", "github"] },
    };
    const acquire = async (id?: string) => {
      vi.mocked(sandboxCrOrchestrator.claim).mockClear();
      kubeClientsFixture.custom.createNamespacedCustomObject.mockClear();
      const lease = await plugin.definition.onEnvironmentAcquireLease!({
        driverKey: "kubernetes", config, runId: "r-preset", companyId: "acme", environmentId: "env-1",
        ...(id ? { agentId: id } : {}),
      });
      const manifest = vi.mocked(sandboxCrOrchestrator.claim).mock.calls[0]![2] as {
        spec: { podTemplate: { metadata: { labels: Record<string, string> } } };
      };
      const adapterPolicy = kubeClientsFixture.custom.createNamespacedCustomObject.mock.calls
        .map((call) => (call[0] as { body: { metadata: { name: string }; spec: { egress: unknown[] } } }).body)
        .find((body) => body.metadata.name.endsWith("-adapter-egress"))!;
      return { lease, podLabels: manifest.spec.podTemplate.metadata.labels, adapterPolicy };
    };

    it("appends the agent's presets to the per-lease policy and labels the pod", async () => {
      const { lease, podLabels, adapterPolicy } = await acquire(agentId);
      expect(podLabels["egress-preset.paperclip.io/github"]).toBe("true");
      expect(podLabels["egress-preset.paperclip.io/npm"]).toBe("true");
      expect(adapterPolicy.spec.egress.slice(-2)).toEqual([
        { toFQDNs: [{ matchName: "github.com" }], toPorts: [{ ports: [{ port: "443", protocol: "TCP" }] }] },
        { toFQDNs: [{ matchName: "registry.npmjs.org" }], toPorts: [{ ports: [{ port: "443", protocol: "TCP" }] }] },
      ]);
      expect(lease.metadata?.egressPresets).toEqual(["github", "npm"]);
    });

    it("leaves other agents' policy, labels and metadata unchanged", async () => {
      const withoutPresets = await acquire("someone-else");
      const { egressPresets: _ignored, agentEgressPresets: _alsoIgnored, ...plainConfig } = config;
      expect(Object.keys(withoutPresets.podLabels).some((k) => k.startsWith("egress-preset."))).toBe(false);
      expect(withoutPresets.lease.metadata).not.toHaveProperty("egressPresets");
      kubeClientsFixture.custom.createNamespacedCustomObject.mockClear();
      await plugin.definition.onEnvironmentAcquireLease!({
        driverKey: "kubernetes", config: plainConfig, runId: "r-preset", companyId: "acme", environmentId: "env-1", agentId: "someone-else",
      });
      const plainPolicy = (kubeClientsFixture.custom.createNamespacedCustomObject.mock.calls[0]![0] as { body: { spec: unknown } }).body;
      expect(withoutPresets.adapterPolicy.spec).toEqual(plainPolicy.spec);
    });
  });
});
