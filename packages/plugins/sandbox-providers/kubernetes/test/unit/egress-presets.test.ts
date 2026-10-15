import { describe, expect, it, vi } from "vitest";
import {
  buildCiliumEgressPresetRules,
  buildStandardEgressPresetRules,
  egressPresetLabels,
  egressPresetSchema,
  resolveAgentEgressPresets,
} from "../../src/egress-presets.js";
import { kubernetesProviderConfigSchema } from "../../src/types.js";
import { buildCiliumNetworkPolicyManifest } from "../../src/cilium-network-policy.js";
import { buildNetworkPolicyManifests } from "../../src/network-policy.js";
import { createScopedNetworkEgressPolicy } from "../../src/scoped-network-egress.js";
import plugin from "../../src/plugin.js";

const PAX = "97ac1286-84c8-4430-8dc8-9e38505df1b5";
const OTTO = "ce0a2fa6-3e4a-4f72-b74f-51678ddc018a";

const presetConfig = {
  inCluster: true,
  egressMode: "cilium" as const,
  egressPresets: {
    github: { fqdns: ["github.com", "API.GitHub.com"], ports: [{ port: 443 }] },
    "nas-ssh": { cidrs: ["192.168.30.170/32"], ports: [{ port: 22, protocol: "TCP" as const }] },
  },
  agentEgressPresets: { [PAX]: ["github"], [OTTO]: ["nas-ssh", "github", "nas-ssh"] },
};

describe("egress preset config schema", () => {
  it("leaves both fields unset by default", () => {
    const cfg = kubernetesProviderConfigSchema.parse({ inCluster: true });
    expect(cfg.egressPresets).toBeUndefined();
    expect(cfg.agentEgressPresets).toBeUndefined();
  });

  it("normalizes FQDNs and defaults the port protocol to TCP", () => {
    const cfg = kubernetesProviderConfigSchema.parse(presetConfig);
    expect(cfg.egressPresets!.github).toEqual({
      fqdns: ["github.com", "api.github.com"],
      cidrs: [],
      ports: [{ port: 443, protocol: "TCP" }],
    });
  });

  it.each([
    [{ fqdns: ["github.com"], ports: [] }, "at least one port"],
    [{ ports: [{ port: 443 }] }, "at least one FQDN or CIDR"],
    [{ fqdns: ["*.github.com"], ports: [{ port: 443 }] }, "Invalid FQDN"],
    [{ cidrs: ["192.168.300.1/32"], ports: [{ port: 22 }] }, "Invalid IPv4 CIDR"],
    [{ cidrs: ["10.0.0.0/33"], ports: [{ port: 22 }] }, "Invalid IPv4 CIDR"],
    [{ cidrs: ["10.0.0.0/8"], ports: [{ port: 0 }] }, ""],
    [{ cidrs: ["10.0.0.0/8"], ports: [{ port: 70000 }] }, ""],
    [{ cidrs: ["10.0.0.0/8"], ports: [{ port: 22, protocol: "SCTP" }] }, ""],
    [{ cidrs: ["10.0.0.0/8"], ports: [{ port: 22 }], toEntities: ["world"] }, ""],
  ])("rejects invalid preset %j", (preset, message) => {
    const result = egressPresetSchema.safeParse(preset);
    expect(result.success).toBe(false);
    if (message) expect(result.error!.issues.map((i) => i.message).join("\n")).toContain(message);
  });

  it("rejects preset names that are not DNS labels", () => {
    const result = kubernetesProviderConfigSchema.safeParse({
      ...presetConfig,
      egressPresets: { GitHub_Dev: presetConfig.egressPresets.github },
      agentEgressPresets: {},
    });
    expect(result.success).toBe(false);
  });

  it("rejects an agent assignment that references an undefined preset", () => {
    const result = kubernetesProviderConfigSchema.safeParse({ ...presetConfig, agentEgressPresets: { [PAX]: ["npm"] } });
    expect(result.success).toBe(false);
    expect(result.error!.issues[0]!.message).toContain('undefined egress preset "npm"');
  });

  it("rejects preset FQDNs outside cilium mode but accepts CIDR-only presets", () => {
    const fqdn = kubernetesProviderConfigSchema.safeParse({ ...presetConfig, egressMode: "standard" });
    expect(fqdn.success).toBe(false);
    expect(fqdn.error!.issues[0]!.message).toContain('require egressMode "cilium"');
    const cidrOnly = kubernetesProviderConfigSchema.safeParse({
      inCluster: true,
      egressPresets: { "nas-ssh": presetConfig.egressPresets["nas-ssh"] },
      agentEgressPresets: { [OTTO]: ["nas-ssh"] },
    });
    expect(cidrOnly.success).toBe(true);
  });

  it("surfaces preset errors through onEnvironmentValidateConfig", async () => {
    const result = await plugin.definition.onEnvironmentValidateConfig!({
      driverKey: "kubernetes",
      config: { ...presetConfig, agentEgressPresets: { [PAX]: ["missing"] } },
    } as never);
    expect(result.ok).toBe(false);
    expect(result.errors?.join("\n")).toContain('undefined egress preset "missing"');
  });
});

describe("resolveAgentEgressPresets", () => {
  const cfg = kubernetesProviderConfigSchema.parse(presetConfig);

  it("returns nothing for an unassigned or missing agent", () => {
    expect(resolveAgentEgressPresets(cfg, "someone-else")).toEqual({ names: [], presets: [] });
    expect(resolveAgentEgressPresets(cfg, undefined)).toEqual({ names: [], presets: [] });
    expect(resolveAgentEgressPresets({}, PAX)).toEqual({ names: [], presets: [] });
  });

  it("dedupes and sorts assigned preset names", () => {
    const resolved = resolveAgentEgressPresets(cfg, OTTO);
    expect(resolved.names).toEqual(["github", "nas-ssh"]);
    expect(resolved.presets).toEqual([cfg.egressPresets!.github, cfg.egressPresets!["nas-ssh"]]);
  });

  it("fails closed on a dangling reference that bypassed validation", () => {
    expect(() => resolveAgentEgressPresets({ agentEgressPresets: { [PAX]: ["gone"] } }, PAX)).toThrow(/not defined/);
  });

  it("derives one pod label per preset", () => {
    expect(egressPresetLabels(["github", "nas-ssh"])).toEqual({
      "egress-preset.paperclip.io/github": "true",
      "egress-preset.paperclip.io/nas-ssh": "true",
    });
  });
});

describe("egress preset policy rules", () => {
  const cfg = kubernetesProviderConfigSchema.parse(presetConfig);
  const presets = resolveAgentEgressPresets(cfg, OTTO).presets;

  it("builds port-scoped Cilium FQDN and CIDR rules", () => {
    expect(buildCiliumEgressPresetRules(presets)).toEqual([
      {
        toFQDNs: [{ matchName: "github.com" }, { matchName: "api.github.com" }],
        toPorts: [{ ports: [{ port: "443", protocol: "TCP" }] }],
      },
      {
        toCIDRSet: [{ cidr: "192.168.30.170/32" }],
        toPorts: [{ ports: [{ port: "22", protocol: "TCP" }] }],
      },
    ]);
  });

  it("builds port-scoped standard NetworkPolicy rules from CIDRs only", () => {
    expect(buildStandardEgressPresetRules(presets)).toEqual([
      { to: [{ ipBlock: { cidr: "192.168.30.170/32" } }], ports: [{ protocol: "TCP", port: 22 }] },
    ]);
  });

  it("leaves policy builders unchanged without extra rules", () => {
    const input = { namespace: "ns", paperclipServerNamespace: "paperclip", egressAllowFqdns: ["a.example"], egressAllowCidrs: [] };
    expect(buildCiliumNetworkPolicyManifest({ ...input, extraEgress: [] })).toEqual(buildCiliumNetworkPolicyManifest(input));
    expect(buildNetworkPolicyManifests({ ...input, extraEgress: [] })).toEqual(buildNetworkPolicyManifests(input));
  });

  it("appends preset rules after the base and adapter rules in the per-lease Cilium policy", async () => {
    const createNamespacedCustomObject = vi.fn().mockResolvedValue({});
    await createScopedNetworkEgressPolicy({
      clients: { custom: { createNamespacedCustomObject } } as never,
      namespace: "paperclip-acme",
      mode: "cilium",
      runId: "run-1",
      workloadName: "pc-w",
      ownerReference: { kind: "Sandbox", name: "pc-w", uid: "uid-1" },
      suffix: "-adapter-egress",
      grant: { allowFqdns: ["api.anthropic.com"], allowCidrs: [] },
      baseRules: { paperclipServerNamespace: "paperclip", paperclipServerPodSelector: { app: "paperclip" } },
      presets,
    });
    const egress = createNamespacedCustomObject.mock.calls[0]![0].body.spec.egress as Record<string, unknown>[];
    expect(egress).toHaveLength(5);
    expect(egress.slice(3)).toEqual(buildCiliumEgressPresetRules(presets));
  });

  it("creates a policy for a preset-only grant", async () => {
    const createNamespacedNetworkPolicy = vi.fn().mockResolvedValue({});
    const name = await createScopedNetworkEgressPolicy({
      clients: { networking: { createNamespacedNetworkPolicy } } as never,
      namespace: "ns",
      mode: "standard",
      runId: "run-1",
      workloadName: "pc-w",
      ownerReference: {},
      grant: { allowFqdns: [], allowCidrs: [] },
      presets: [cfg.egressPresets!["nas-ssh"]!],
    });
    expect(name).toBe("pc-w-egress");
    expect(createNamespacedNetworkPolicy.mock.calls[0]![0].body.spec.egress).toEqual([
      { to: [{ ipBlock: { cidr: "192.168.30.170/32" } }], ports: [{ protocol: "TCP", port: 22 }] },
    ]);
  });
});
