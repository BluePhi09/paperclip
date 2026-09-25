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
  egressAllowFqdns: string[];
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
 * selector), the policy is replaced. The egress allow-list is merged with the
 * FQDNs already granted rather than replaced, because the policy is shared by
 * every adapter's pods in the tenant (see mergeFqdns). If the operator has not granted
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
  const buildStandard = (egressAllowFqdns: string[]) =>
    buildNetworkPolicyManifests({
      namespace: input.namespace,
      paperclipServerNamespace: input.paperclipServerNamespace,
      paperclipServerPodSelector: input.paperclipServerPodSelector,
      egressAllowCidrs: input.egressAllowCidrs,
      egressAllowFqdns,
    });

  const [denyAll] = buildStandard(input.egressAllowFqdns);
  await ensureNetworkPolicy(clients, input.namespace, () => denyAll);

  if (input.egressMode === "cilium") {
    await ensureCiliumNetworkPolicy(clients, input.namespace, (existingFqdns) => {
      const fqdns = mergeFqdns(input.egressAllowFqdns, existingFqdns);
      return withAllowedFqdns(
        buildCiliumNetworkPolicyManifest({
          namespace: input.namespace,
          paperclipServerNamespace: input.paperclipServerNamespace,
          paperclipServerPodSelector: input.paperclipServerPodSelector,
          egressAllowFqdns: fqdns,
          egressAllowCidrs: input.egressAllowCidrs,
        }),
        fqdns,
      );
    });
  } else {
    await ensureNetworkPolicy(clients, input.namespace, (existingFqdns) => {
      const fqdns = mergeFqdns(input.egressAllowFqdns, existingFqdns);
      return withAllowedFqdns(buildStandard(fqdns)[1], fqdns);
    });
  }
}

const SPEC_HASH_ANNOTATION = "paperclip.io/spec-hash";
const ALLOWED_FQDNS_ANNOTATION = "paperclip.io/allowed-fqdns";

/**
 * The egress policy is tenant-wide, but each lease only knows the FQDNs of its
 * own adapter. Reconciling with just those would strip the hosts of another
 * adapter whose pod is still running in the same tenant (e.g. a Codex lease
 * removing Claude's OAuth hosts), so the policy only ever grows: the desired
 * FQDNs are the union of this lease's list and the ones already granted.
 * Sorted so every lease computes the same spec (and hash) for the same union.
 * Hosts are never removed automatically; delete the policy to shrink it.
 */
function mergeFqdns(desired: string[], existing: string[]): string[] {
  return [...new Set([...desired, ...existing])].sort();
}

function withAllowedFqdns(manifest: Record<string, unknown>, fqdns: string[]): Record<string, unknown> {
  const metadata = (manifest.metadata ?? {}) as { annotations?: Record<string, string> };
  return {
    ...manifest,
    metadata: { ...metadata, annotations: { ...(metadata.annotations ?? {}), [ALLOWED_FQDNS_ANNOTATION]: fqdns.join(",") } },
  };
}

function withSpecHash(manifest: Record<string, unknown>): { manifest: Record<string, unknown>; hash: string } {
  const metadata = (manifest.metadata ?? {}) as { annotations?: Record<string, string> };
  // The allowed-FQDNs annotation is hashed with the spec: a standard
  // NetworkPolicy only encodes whether any FQDN exists, so without it a grown
  // union would never be written back and later leases would not see it.
  const hash = createHash("sha256")
    .update(JSON.stringify([manifest.spec ?? null, metadata.annotations?.[ALLOWED_FQDNS_ANNOTATION] ?? null]))
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
  fqdns: string[];
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
  const annotated = (obj?.metadata?.annotations?.[ALLOWED_FQDNS_ANNOTATION] ?? "").split(",");
  // Cilium policies provisioned before the annotation existed carry their
  // hosts only in the spec.
  const inSpec = (obj?.spec?.egress ?? []).flatMap((rule) =>
    (Array.isArray(rule?.toFQDNs) ? rule.toFQDNs : []).map((f) => f?.matchName),
  );
  return {
    hash: obj?.metadata?.annotations?.[SPEC_HASH_ANNOTATION],
    resourceVersion: obj?.metadata?.resourceVersion,
    fqdns: [...annotated, ...inSpec].filter((f): f is string => typeof f === "string" && f.length > 0),
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
async function reconcilePolicy(ops: PolicyOps, desiredFor: (existingFqdns: string[]) => Record<string, unknown>): Promise<void> {
  let lastConflict: unknown;
  for (let attempt = 0; attempt < POLICY_RECONCILE_ATTEMPTS; attempt++) {
    let existing: unknown;
    try {
      existing = await ops.read();
    } catch (err) {
      if (!isNotFound(err)) throw err;
      try {
        await ops.create(withSpecHash(desiredFor([])).manifest);
        return;
      } catch (createErr) {
        if (!isConflict(createErr)) throw createErr;
        lastConflict = createErr;
        continue;
      }
    }
    const current = describeExisting(existing);
    const { manifest, hash } = withSpecHash(desiredFor(current.fqdns));
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
  desiredFor: (existingFqdns: string[]) => Record<string, unknown>,
): Promise<void> {
  const name = (desiredFor([]).metadata as { name: string }).name;
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
  desiredFor: (existingFqdns: string[]) => Record<string, unknown>,
): Promise<void> {
  const name = (desiredFor([]).metadata as { name: string }).name;
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
