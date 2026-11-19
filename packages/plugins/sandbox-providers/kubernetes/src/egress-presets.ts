import { z } from "zod";

/**
 * Named egress presets: operator-defined bundles of destinations + ports that
 * are assigned to individual agents through the environment config instead of
 * hand-written, agent-UUID-keyed cluster policies.
 *
 * The presets assigned to a lease's agent are appended to that lease's
 * `<lease>-adapter-egress` policy (selected by the run label, owned by the
 * workload), and the pod is labelled `egress-preset.paperclip.io/<name>=true`
 * so cluster-side policies (e.g. a private-network `egressDeny` exception) can
 * select agents by preset rather than by UUID.
 */

/** Preset names become a label-key name segment, so they follow DNS-1123 label syntax. */
export const EGRESS_PRESET_NAME_PATTERN = "^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$";
const presetNameRegex = new RegExp(EGRESS_PRESET_NAME_PATTERN);

/** Exact hostnames only (Cilium `matchName`); wildcards are deliberately not accepted. */
export const EGRESS_PRESET_FQDN_PATTERN =
  "^(?=.{1,253}$)[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?)+$";
const fqdnRegex = new RegExp(EGRESS_PRESET_FQDN_PATTERN);

export const EGRESS_PRESET_CIDR_PATTERN = "^(\\d{1,3}\\.){3}\\d{1,3}\\/\\d{1,2}$";
const cidrRegex = new RegExp(EGRESS_PRESET_CIDR_PATTERN);

export const EGRESS_PRESET_LABEL_PREFIX = "egress-preset.paperclip.io/";

function isValidIpv4Cidr(value: string): boolean {
  if (!cidrRegex.test(value)) return false;
  const [address, prefix] = value.split("/");
  return address!.split(".").every((octet) => Number(octet) <= 255) && Number(prefix) <= 32;
}

export const egressPresetPortSchema = z
  .object({
    port: z.number().int().min(1).max(65535),
    protocol: z.enum(["TCP", "UDP"]).default("TCP"),
  })
  .strict();

export const egressPresetSchema = z
  .object({
    fqdns: z
      .array(z.string().trim().toLowerCase().regex(fqdnRegex, "Invalid FQDN (exact hostnames only, no wildcards)"))
      .default([]),
    cidrs: z.array(z.string().trim().refine(isValidIpv4Cidr, "Invalid IPv4 CIDR")).default([]),
    ports: z.array(egressPresetPortSchema).min(1, "an egress preset needs at least one port"),
  })
  .strict()
  .refine((preset) => preset.fqdns.length > 0 || preset.cidrs.length > 0, {
    message: "an egress preset needs at least one FQDN or CIDR",
  });

export type EgressPreset = z.infer<typeof egressPresetSchema>;
export type EgressPresetPort = z.infer<typeof egressPresetPortSchema>;

export const egressPresetsSchema = z.record(
  z.string().regex(presetNameRegex, "egress preset names must be lowercase DNS labels (a-z, 0-9, -; max 63)"),
  egressPresetSchema,
);

export const agentEgressPresetsSchema = z.record(
  z.string().min(1).max(63),
  z.array(z.string().regex(presetNameRegex, "egress preset names must be lowercase DNS labels (a-z, 0-9, -; max 63)")),
);

/** Resolved egress for one lease: the preset names applied, in deterministic order. */
export interface ResolvedEgressPresets {
  names: string[];
  presets: EgressPreset[];
}

export function resolveAgentEgressPresets(
  config: {
    egressPresets?: Record<string, EgressPreset>;
    agentEgressPresets?: Record<string, string[]>;
  },
  agentId: string | undefined,
): ResolvedEgressPresets {
  if (!agentId) return { names: [], presets: [] };
  const assigned = config.agentEgressPresets?.[agentId] ?? [];
  const names = [...new Set(assigned)].sort();
  const presets = names.map((name) => {
    const preset = config.egressPresets?.[name];
    // Config validation rejects dangling references; fail closed if one slips through.
    if (!preset) throw new Error(`Egress preset "${name}" assigned to agent ${agentId} is not defined in egressPresets`);
    return preset;
  });
  return { names, presets };
}

/** Pod labels advertising the presets a run received (for cluster-side policy selection). */
export function egressPresetLabels(names: string[]): Record<string, string> {
  return Object.fromEntries(names.map((name) => [`${EGRESS_PRESET_LABEL_PREFIX}${name}`, "true"]));
}

function portList(ports: EgressPresetPort[]) {
  return ports.map((p) => ({ port: String(p.port), protocol: p.protocol }));
}

/** Cilium egress rules for presets: one FQDN rule and one CIDR rule per preset, both port-scoped. */
export function buildCiliumEgressPresetRules(presets: EgressPreset[]): Record<string, unknown>[] {
  const rules: Record<string, unknown>[] = [];
  for (const preset of presets) {
    const toPorts = [{ ports: portList(preset.ports) }];
    if (preset.fqdns.length > 0) {
      rules.push({ toFQDNs: preset.fqdns.map((fqdn) => ({ matchName: fqdn })), toPorts });
    }
    if (preset.cidrs.length > 0) {
      rules.push({ toCIDRSet: preset.cidrs.map((cidr) => ({ cidr })), toPorts });
    }
  }
  return rules;
}

/**
 * Standard NetworkPolicy egress rules for presets. NetworkPolicy is CIDR-only,
 * so only preset CIDRs are emitted; config validation rejects preset FQDNs
 * outside `egressMode: "cilium"`.
 */
export function buildStandardEgressPresetRules(presets: EgressPreset[]): Record<string, unknown>[] {
  return presets
    .filter((preset) => preset.cidrs.length > 0)
    .map((preset) => ({
      to: preset.cidrs.map((cidr) => ({ ipBlock: { cidr } })),
      ports: preset.ports.map((p) => ({ protocol: p.protocol, port: p.port })),
    }));
}

/** Errors for preset config that only make sense in combination with other fields. */
export function validateEgressPresetConfig(config: {
  egressMode: "cilium" | "standard";
  egressPresets?: Record<string, EgressPreset>;
  agentEgressPresets?: Record<string, string[]>;
}): string[] {
  const errors: string[] = [];
  const defined = new Set(Object.keys(config.egressPresets ?? {}));
  for (const [agentId, names] of Object.entries(config.agentEgressPresets ?? {})) {
    for (const name of names) {
      if (!defined.has(name)) errors.push(`agentEgressPresets.${agentId} references undefined egress preset "${name}"`);
    }
  }
  if (config.egressMode !== "cilium") {
    for (const [name, preset] of Object.entries(config.egressPresets ?? {})) {
      if (preset.fqdns.length > 0) {
        errors.push(`egressPresets.${name} lists FQDNs, which require egressMode "cilium" (standard NetworkPolicy is CIDR-only)`);
      }
    }
  }
  return errors;
}
