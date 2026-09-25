import { createHash } from "node:crypto";
import type { KubeClients } from "./kube-client.js";
import { buildNetworkPolicyManifests } from "./network-policy.js";
import { buildCiliumNetworkPolicyManifest } from "./cilium-network-policy.js";

export interface EnsureTenantInput {
  namespace: string;
  companyId: string;
  paperclipServerNamespace: string;
  paperclipServerPodSelector?: Record<string, string>;
  serviceAccountAnnotations: Record<string, string>;
  egressMode: "standard" | "cilium";
  /** The acquiring environment; it owns one grant in the shared egress policy. */
  environmentId: string;
  egressAllowFqdns: string[];
  /**
   * Hosts another adapter's lease of this environment may have granted (every
   * adapter's default FQDNs). Only these survive a merge with the environment's
   * existing grant; any other host, e.g. one the operator removed from
   * `egressAllowFqdns`, is dropped.
   */
  retainableFqdns?: string[];
  egressAllowCidrs: string[];
  resourceQuota: {
    pods: string;
    requestsCpu: string;
    requestsMemory: string;
    limitsCpu: string;
    limitsMemory: string;
  };
}

const SERVICE_ACCOUNT_NAME = "paperclip-tenant-sa";
const ROLE_NAME = "paperclip-tenant-role";
const ROLE_BINDING_NAME = "paperclip-tenant-rb";
const RESOURCE_QUOTA_NAME = "paperclip-quota";
const LIMIT_RANGE_NAME = "paperclip-limits";

/**
 * Lazy, first-write-wins tenant provisioning. Each helper checks if the named
 * resource exists and creates it only on 404; if it already exists, it is
 * left as-is — config-driven values (quota limits, RBAC permissions, network
 * policies, egress allow-list) are FROZEN at first provisioning time.
 *
 * V1 limitation: changing KubernetesProviderConfig after a tenant namespace
 * is provisioned does NOT update most in-cluster resources. To apply config
 * changes, an operator must delete the per-tenant resources manually (or
 * the namespace itself). A future iteration should add strategic-merge
 * reconciliation here.
 *
 * Exception: the plugin-owned network policies are reconciled. Each carries
 * a hash of its desired spec in an annotation; when the hash is missing or
 * stale (new adapter egress defaults such as OAuth hosts, a changed callback
 * selector), the policy is replaced. The egress allow-list is the union of
 * per-environment grants, because the policy is shared by every environment
 * and adapter in the tenant (see mergeGrants). If the operator has not granted
 * `update` on the policy resource, the stale policy is kept and a warning is
 * logged instead of failing the lease.
 *
 * Particular gotcha: switching egressMode "standard" → "cilium" leaves the
 * old paperclip-egress-allow NetworkPolicy in place alongside the new
 * CiliumNetworkPolicy. Both apply; the effective egress is the intersection.
 */
export async function ensureTenant(clients: KubeClients, input: EnsureTenantInput): Promise<void> {
  await ensureNamespace(clients, input);
  await ensureServiceAccount(clients, input);
  await ensureRole(clients, input);
  await ensureRoleBinding(clients, input);
  await ensureResourceQuota(clients, input);
  await ensureLimitRange(clients, input);
  await ensureNetworkPolicies(clients, input);
}

async function ensureNamespace(clients: KubeClients, input: EnsureTenantInput): Promise<void> {
  try {
    await clients.core.readNamespace({ name: input.namespace });
    return;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  await createIgnoringAlreadyExists(
    clients.core.createNamespace({
        body: {
          apiVersion: "v1",
          kind: "Namespace",
          metadata: {
            name: input.namespace,
            labels: {
              "paperclip.io/company-id": input.companyId,
              "paperclip.io/managed-by": "paperclip-k8s-plugin",
              "pod-security.kubernetes.io/enforce": "restricted",
              "pod-security.kubernetes.io/audit": "restricted",
              "pod-security.kubernetes.io/warn": "restricted",
            },
          },
        },
      }),
  );
}

async function ensureServiceAccount(clients: KubeClients, input: EnsureTenantInput): Promise<void> {
  try {
    await clients.core.readNamespacedServiceAccount({ name: SERVICE_ACCOUNT_NAME, namespace: input.namespace });
    return;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  await createIgnoringAlreadyExists(
    clients.core.createNamespacedServiceAccount({
        namespace: input.namespace,
        body: {
          apiVersion: "v1",
          kind: "ServiceAccount",
          metadata: {
            name: SERVICE_ACCOUNT_NAME,
            namespace: input.namespace,
            annotations: input.serviceAccountAnnotations,
            labels: { "paperclip.io/managed-by": "paperclip-k8s-plugin" },
          },
        },
      }),
  );
}

async function ensureRole(clients: KubeClients, input: EnsureTenantInput): Promise<void> {
  try {
    await clients.rbac.readNamespacedRole({ name: ROLE_NAME, namespace: input.namespace });
    return;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  await createIgnoringAlreadyExists(
    clients.rbac.createNamespacedRole({
        namespace: input.namespace,
        body: {
          apiVersion: "rbac.authorization.k8s.io/v1",
          kind: "Role",
          metadata: { name: ROLE_NAME, namespace: input.namespace },
          rules: [
            { apiGroups: [""], resources: ["pods/log"], verbs: ["get"] },
          ],
        },
      }),
  );
}

async function ensureRoleBinding(clients: KubeClients, input: EnsureTenantInput): Promise<void> {
  try {
    await clients.rbac.readNamespacedRoleBinding({ name: ROLE_BINDING_NAME, namespace: input.namespace });
    return;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  await createIgnoringAlreadyExists(
    clients.rbac.createNamespacedRoleBinding({
        namespace: input.namespace,
        body: {
          apiVersion: "rbac.authorization.k8s.io/v1",
          kind: "RoleBinding",
          metadata: { name: ROLE_BINDING_NAME, namespace: input.namespace },
          roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: ROLE_NAME },
          subjects: [{ kind: "ServiceAccount", name: SERVICE_ACCOUNT_NAME, namespace: input.namespace }],
        },
      }),
  );
}

async function ensureResourceQuota(clients: KubeClients, input: EnsureTenantInput): Promise<void> {
  try {
    await clients.core.readNamespacedResourceQuota({ name: RESOURCE_QUOTA_NAME, namespace: input.namespace });
    return;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  await createIgnoringAlreadyExists(
    clients.core.createNamespacedResourceQuota({
        namespace: input.namespace,
        body: {
          apiVersion: "v1",
          kind: "ResourceQuota",
          metadata: { name: RESOURCE_QUOTA_NAME, namespace: input.namespace },
          spec: {
            hard: {
              pods: input.resourceQuota.pods,
              "requests.cpu": input.resourceQuota.requestsCpu,
              "requests.memory": input.resourceQuota.requestsMemory,
              "limits.cpu": input.resourceQuota.limitsCpu,
              "limits.memory": input.resourceQuota.limitsMemory,
            },
          },
        },
      }),
  );
}

async function ensureLimitRange(clients: KubeClients, input: EnsureTenantInput): Promise<void> {
  try {
    await clients.core.readNamespacedLimitRange({ name: LIMIT_RANGE_NAME, namespace: input.namespace });
    return;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  await createIgnoringAlreadyExists(
    clients.core.createNamespacedLimitRange({
        namespace: input.namespace,
        body: {
          apiVersion: "v1",
          kind: "LimitRange",
          metadata: { name: LIMIT_RANGE_NAME, namespace: input.namespace },
          spec: {
            limits: [
              {
                type: "Container",
                max: { cpu: "4", memory: "8Gi" },
                min: { cpu: "100m", memory: "128Mi" },
                // The k8s client-node type names this `_default` but the actual
                // Kubernetes API field is `default`. We produce a JSON-shape
                // manifest so the cast is safe.
                default: { cpu: "1", memory: "2Gi" },
                defaultRequest: { cpu: "250m", memory: "512Mi" },
              },
            ],
          },
        } as never,
      }),
  );
}

async function ensureNetworkPolicies(clients: KubeClients, input: EnsureTenantInput): Promise<void> {
  const buildStandard = (egressAllowFqdns: string[], egressAllowCidrs: string[]) =>
    buildNetworkPolicyManifests({
      namespace: input.namespace,
      paperclipServerNamespace: input.paperclipServerNamespace,
      paperclipServerPodSelector: input.paperclipServerPodSelector,
      egressAllowCidrs,
      egressAllowFqdns,
    });

  const [denyAll] = buildStandard(input.egressAllowFqdns, input.egressAllowCidrs);
  await ensureNetworkPolicy(clients, input.namespace, () => denyAll);

  const desiredFor = (existing: ExistingPolicy, build: (fqdns: string[], cidrs: string[]) => Record<string, unknown>) => {
    const grants = mergeGrants(input, existing);
    const union = (pick: (g: EgressGrant) => string[]) => sortedUnique(Object.values(grants).flatMap(pick));
    return withGrants(build(union((g) => g.fqdns), union((g) => g.cidrs)), grants);
  };

  if (input.egressMode === "cilium") {
    await ensureCiliumNetworkPolicy(clients, input.namespace, (existing) =>
      desiredFor(existing, (fqdns, cidrs) =>
        buildCiliumNetworkPolicyManifest({
          namespace: input.namespace,
          paperclipServerNamespace: input.paperclipServerNamespace,
          paperclipServerPodSelector: input.paperclipServerPodSelector,
          egressAllowFqdns: fqdns,
          egressAllowCidrs: cidrs,
        }),
      ),
    );
  } else {
    await ensureNetworkPolicy(clients, input.namespace, (existing) =>
      desiredFor(existing, (fqdns, cidrs) => buildStandard(fqdns, cidrs)[1]),
    );
  }
}

const SPEC_HASH_ANNOTATION = "paperclip.io/spec-hash";
const EGRESS_GRANTS_ANNOTATION = "paperclip.io/egress-grants";
/** Written by earlier revisions of this change; read once for migration. */
const LEGACY_ALLOWED_FQDNS_ANNOTATION = "paperclip.io/allowed-fqdns";

interface EgressGrant {
  fqdns: string[];
  cidrs: string[];
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

/**
 * The egress policy is shared by every environment (the tenant namespace is
 * per company) and every adapter in it, but a lease only knows its own
 * environment's config. So each environment owns a grant in the policy and the
 * policy allows the union of all grants; a lease rewrites only its own grant,
 * never another environment's hosts or CIDRs.
 *
 * Within the own grant, hosts already granted are kept only if they are some
 * adapter's defaults (`retainableFqdns`), so a Codex lease keeps a running
 * Claude pod's OAuth hosts while a host the operator removed from
 * `egressAllowFqdns` is revoked on the next acquisition. CIDRs come straight
 * from the environment's config.
 *
 * ponytail: grants of deleted environments stay until the policy is deleted;
 * add pruning if environments churn.
 */
function mergeGrants(input: EnsureTenantInput, existing: ExistingPolicy): Record<string, EgressGrant> {
  const retainable = new Set(input.retainableFqdns ?? []);
  const previous = existing.grants ? (existing.grants[input.environmentId]?.fqdns ?? []) : existing.legacyFqdns;
  const own: EgressGrant = {
    fqdns: sortedUnique([...input.egressAllowFqdns, ...previous.filter((f) => retainable.has(f))]),
    cidrs: sortedUnique(input.egressAllowCidrs),
  };
  const grants = { ...(existing.grants ?? {}), [input.environmentId]: own };
  // Sorted keys so every lease computes the same annotation (and hash).
  return Object.fromEntries(Object.entries(grants).sort(([a], [b]) => a.localeCompare(b)));
}

function withGrants(manifest: Record<string, unknown>, grants: Record<string, EgressGrant>): Record<string, unknown> {
  const metadata = (manifest.metadata ?? {}) as { annotations?: Record<string, string> };
  return {
    ...manifest,
    metadata: { ...metadata, annotations: { ...(metadata.annotations ?? {}), [EGRESS_GRANTS_ANNOTATION]: JSON.stringify(grants) } },
  };
}

function withSpecHash(manifest: Record<string, unknown>): { manifest: Record<string, unknown>; hash: string } {
  const metadata = (manifest.metadata ?? {}) as { annotations?: Record<string, string> };
  // The grants annotation is hashed with the spec: a standard NetworkPolicy
  // only encodes whether any FQDN exists, so without it a changed grant would
  // never be written back and later leases would not see it.
  const hash = createHash("sha256")
    .update(JSON.stringify([manifest.spec ?? null, metadata.annotations?.[EGRESS_GRANTS_ANNOTATION] ?? null]))
    .digest("hex")
    .slice(0, 32);
  return {
    hash,
    manifest: {
      ...manifest,
      metadata: { ...metadata, annotations: { ...(metadata.annotations ?? {}), [SPEC_HASH_ANNOTATION]: hash } },
    },
  };
}

interface ExistingPolicy {
  hash?: string;
  resourceVersion?: string;
  /** Per-environment grants; undefined for policies written before grants existed. */
  grants?: Record<string, EgressGrant>;
  /** Hosts of a pre-grants policy, attributed to the acquiring environment. */
  legacyFqdns: string[];
}

const NO_EXISTING_POLICY: ExistingPolicy = { legacyFqdns: [] };

function parseGrants(raw: string | undefined): Record<string, EgressGrant> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, Partial<EgressGrant>>;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : []);
    return Object.fromEntries(
      Object.entries(parsed).map(([env, g]) => [env, { fqdns: strings(g?.fqdns), cidrs: strings(g?.cidrs) }]),
    );
  } catch {
    return undefined;
  }
}

function describeExisting(existing: unknown): ExistingPolicy {
  // client-node v1 returns the object directly; older mocks wrap it in `body`.
  const obj = ((existing as { body?: unknown } | null)?.body ?? existing) as
    | {
        metadata?: { annotations?: Record<string, string>; resourceVersion?: string };
        spec?: { egress?: { toFQDNs?: { matchName?: unknown }[] }[] };
      }
    | null
    | undefined;
  const annotations = obj?.metadata?.annotations ?? {};
  const legacyAnnotated = (annotations[LEGACY_ALLOWED_FQDNS_ANNOTATION] ?? "").split(",");
  // Cilium policies provisioned before any annotation carry their hosts only
  // in the spec.
  const inSpec = (obj?.spec?.egress ?? []).flatMap((rule) =>
    (Array.isArray(rule?.toFQDNs) ? rule.toFQDNs : []).map((f) => f?.matchName),
  );
  return {
    hash: annotations[SPEC_HASH_ANNOTATION],
    resourceVersion: obj?.metadata?.resourceVersion,
    grants: parseGrants(annotations[EGRESS_GRANTS_ANNOTATION]),
    legacyFqdns: [...legacyAnnotated, ...inSpec].filter((f): f is string => typeof f === "string" && f.length > 0),
  };
}

const POLICY_RECONCILE_ATTEMPTS = 5;

interface PolicyOps {
  kind: string;
  namespace: string;
  name: string;
  read: () => Promise<unknown>;
  create: (body: Record<string, unknown>) => Promise<unknown>;
  replace: (body: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Read-merge-write loop for a plugin-owned policy. Concurrent lease
 * acquisitions in one tenant race here: a 409 on create (another lease created
 * it first) or on replace (another lease replaced it since our read) means our
 * view is stale, not that the lease should fail. Re-read and merge again, so
 * neither lease's FQDNs are lost, until the stored policy matches.
 */
async function reconcilePolicy(ops: PolicyOps, desiredFor: (existing: ExistingPolicy) => Record<string, unknown>): Promise<void> {
  let lastConflict: unknown;
  for (let attempt = 0; attempt < POLICY_RECONCILE_ATTEMPTS; attempt++) {
    let existing: unknown;
    try {
      existing = await ops.read();
    } catch (err) {
      if (!isNotFound(err)) throw err;
      try {
        await ops.create(withSpecHash(desiredFor(NO_EXISTING_POLICY)).manifest);
        return;
      } catch (createErr) {
        if (!isConflict(createErr)) throw createErr;
        lastConflict = createErr;
        continue;
      }
    }
    const current = describeExisting(existing);
    const { manifest, hash } = withSpecHash(desiredFor(current));
    if (current.hash === hash) return;
    // Replace requires the current resourceVersion (optimistic concurrency).
    const body = {
      ...manifest,
      metadata: { ...(manifest.metadata as object), ...(current.resourceVersion ? { resourceVersion: current.resourceVersion } : {}) },
    };
    try {
      await ops.replace(body);
      return;
    } catch (err) {
      if (isConflict(err)) {
        lastConflict = err;
        continue;
      }
      if (!isForbidden(err)) throw err;
      console.warn(
        `[plugin-kubernetes] ${ops.kind} ${ops.namespace}/${ops.name} is out of date with the provider config, but the plugin is not allowed to update it. ` +
          `Grant "update" on this resource or delete the policy so it is recreated; until then agent egress uses the old policy.`,
      );
      return;
    }
  }
  throw lastConflict;
}

async function ensureNetworkPolicy(
  clients: KubeClients,
  namespace: string,
  desiredFor: (existing: ExistingPolicy) => Record<string, unknown>,
): Promise<void> {
  const name = (desiredFor(NO_EXISTING_POLICY).metadata as { name: string }).name;
  await reconcilePolicy(
    {
      kind: "NetworkPolicy",
      namespace,
      name,
      read: () => clients.networking.readNamespacedNetworkPolicy({ name, namespace }),
      create: (body) => clients.networking.createNamespacedNetworkPolicy({ namespace, body: body as never }),
      replace: (body) => clients.networking.replaceNamespacedNetworkPolicy({ name, namespace, body: body as never }),
    },
    desiredFor,
  );
}

async function ensureCiliumNetworkPolicy(
  clients: KubeClients,
  namespace: string,
  desiredFor: (existing: ExistingPolicy) => Record<string, unknown>,
): Promise<void> {
  const name = (desiredFor(NO_EXISTING_POLICY).metadata as { name: string }).name;
  const target = { group: "cilium.io", version: "v2", namespace, plural: "ciliumnetworkpolicies" };
  await reconcilePolicy(
    {
      kind: "CiliumNetworkPolicy",
      namespace,
      name,
      read: () => clients.custom.getNamespacedCustomObject({ ...target, name }),
      create: (body) => clients.custom.createNamespacedCustomObject({ ...target, body }),
      replace: (body) => clients.custom.replaceNamespacedCustomObject({ ...target, name, body }),
    },
    desiredFor,
  );
}

function isNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: number; statusCode?: number };
  return e.code === 404 || e.statusCode === 404;
}

function isForbidden(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: number; statusCode?: number };
  return e.code === 403 || e.statusCode === 403;
}

// 409 is both AlreadyExists (create) and Conflict (stale resourceVersion on
// replace).
function isConflict(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: number; statusCode?: number };
  return e.code === 409 || e.statusCode === 409;
}

// Two concurrent lease acquisitions for a brand-new tenant can both observe
// the 404 read and race the create; a 409 AlreadyExists from the loser means
// the desired state already exists, which is exactly what ensure* wants.
async function createIgnoringAlreadyExists(create: Promise<unknown>): Promise<void> {
  try {
    await create;
  } catch (err) {
    if (!isConflict(err)) throw err;
  }
}
