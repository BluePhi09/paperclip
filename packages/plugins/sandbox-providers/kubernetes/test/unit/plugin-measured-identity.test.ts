import { beforeEach, describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ clients: {} as any, name: "lease", image: "selected:tag", backend: "job", mutate: (_p: any, _n: number) => {}, reads: 0, noPod: false, crLookup: "status" }));
vi.mock("../../src/kube-client.js", () => ({ createKubeConfig: () => ({}), makeKubeClients: () => fixture.clients }));
vi.mock("../../src/tenant-orchestrator.js", () => ({ ensureTenant: vi.fn() }));
vi.mock("../../src/secret-manager.js", () => ({ createPerRunSecret: vi.fn() }));
vi.mock("../../src/pod-exec.js", () => ({ execInPod: vi.fn(), execInPodStreaming: vi.fn(), wrapCommandWithEnv: vi.fn() }));
vi.mock("../../src/login-pty-exec.js", () => ({ connectKubernetesLoginPty: vi.fn() }));
import plugin from "../../src/plugin.js";
const namespace = "identity-fixture";
const measured = "containerd://sha256:actual-agent-image";
function pod() {
  return { metadata: { name: `${fixture.name}-pod`, namespace, uid: "pod-uid", ownerReferences: [{ name: fixture.name, uid: "owner-uid", controller: true, kind: fixture.backend === "job" ? "Job" : "Sandbox", apiVersion: fixture.backend === "job" ? "batch/v1" : "agents.x-k8s.io/v1alpha1" }] }, spec: { containers: [{ name: "sidecar", image: "sidecar:tag" }, { name: "agent", image: fixture.image }] }, status: { phase: "Running", containerStatuses: [{ name: "sidecar", imageID: "sha256:wrong-sidecar" }, { name: "agent", imageID: measured }] } };
}
beforeEach(() => {
  fixture.name = "lease"; fixture.image = "selected:tag"; fixture.reads = 0; fixture.noPod = false; fixture.crLookup = "status"; fixture.mutate = () => {};
  const claim = vi.fn(async ({ body }: any) => { fixture.name = body.metadata.name; const container = body.spec?.template?.spec?.containers?.[0] ?? body.spec?.podTemplate?.spec?.containers?.[0]; expect(container.name).toBe("agent"); fixture.image = container.image; return { metadata: { uid: "owner-uid" } }; });
  fixture.clients = {
    networking: { createNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}) },
    batch: { createNamespacedJob: claim, readNamespacedJobStatus: vi.fn(async () => ({ metadata: { uid: "owner-uid" }, status: { active: 1 } })) },
    custom: { createNamespacedCustomObject: claim, getNamespacedCustomObject: vi.fn(async () => ({ metadata: { uid: "owner-uid" }, status: { phase: "Ready", ...(fixture.crLookup === "status" ? { podName: `${fixture.name}-pod` } : {}) } })) },
    core: {
      listNamespacedPod: vi.fn(async () => ({ items: fixture.noPod ? [] : [pod()] })),
      readNamespacedPod: vi.fn(async ({ namespace: ns, name }: any) => {
        expect(typeof ns).toBe("string");
        if (fixture.noPod || (fixture.crLookup === "label" && name === fixture.name)) throw { code: 404 };
        const p = pod(); if (fixture.crLookup === "exact") p.metadata.name = fixture.name;
        fixture.mutate(p, ++fixture.reads); return p;
      }),
    },
  };
});
const config = (backend: string) => ({ inCluster: true, backend, namespacePrefix: "identity-", companySlug: "fixture" });
async function acquire(backend: string) {
  fixture.backend = backend;
  return plugin.definition.onEnvironmentAcquireLease!({ driverKey: "kubernetes", config: config(backend), companyId: "company", environmentId: "env", runId: "run", adapterType: "codex_local" });
}
async function resume(backend: string, metadata: Record<string, unknown>) {
  fixture.backend = backend;
  return plugin.definition.onEnvironmentResumeLease!({ driverKey: "kubernetes", config: config(backend), companyId: "company", environmentId: "env", providerLeaseId: fixture.name, leaseMetadata: metadata });
}
function binding(backend: string) { return { namespace, backend, jobName: fixture.name, podName: `${fixture.name}-pod`, podUid: "pod-uid", workloadUid: "owner-uid", containerName: "agent", imageID: "stale-image", effectiveAdapterType: "codex_local", imageRef: "selected:tag" }; }
function assertMeasured(lease: any, backend: string) {
  expect(lease.metadata).toMatchObject({ imageID: measured, podUid: "pod-uid", workloadUid: "owner-uid", containerName: "agent", containerIdentity: { status: "measured", source: "kubernetes.containerStatuses.imageID", providerLeaseId: fixture.name, namespace, podName: lease.metadata.podName, podUid: "pod-uid", workloadUid: "owner-uid", containerName: "agent", backend, imageID: measured, observedAt: expect.any(String) } });
  expect(fixture.clients.core.readNamespacedPod).toHaveBeenCalledWith({ namespace, name: lease.metadata.podName });
}
function assertUnknown(lease: any) { expect(lease.metadata).toMatchObject({ imageID: null, containerIdentity: { status: "unknown", reason: expect.any(String) } }); }
describe.each(["job", "sandbox-cr"])("measured identity through production %s lifecycle", backend => {
  it("acquire reads the main container, binds the concrete allocation, never the sidecar or spec", async () => { assertMeasured(await acquire(backend), backend); });
  it("resume freshly observes instead of recycling persisted imageID", async () => { assertMeasured(await resume(backend, binding(backend)), backend); });
  const invalid = [
    ["changed selected image", (p: any) => { p.spec.containers[1].image = "different:tag"; }],
    ["duplicate main status", (p: any) => { p.status.containerStatuses.push(p.status.containerStatuses[1]); }],
    ["missing imageID", (p: any) => { delete p.status.containerStatuses[1].imageID; }],
    ["empty imageID", (p: any) => { p.status.containerStatuses[1].imageID = "  "; }],
    ["wrong container", (p: any) => { p.status.containerStatuses[1].name = "other"; }],
    ["missing spec container", (p: any) => { p.spec.containers.pop(); }],
    ["wrong namespace", (p: any) => { p.metadata.namespace = "foreign"; }],
    ["wrong name", (p: any) => { p.metadata.name = "foreign"; }],
    ["wrong owner UID", (p: any) => { p.metadata.ownerReferences[0].uid = "other"; }],
    ["wrong owner kind", (p: any) => { p.metadata.ownerReferences[0].kind = "Other"; }],
    ["missing UID", (p: any) => { delete p.metadata.uid; }],
    ["terminating", (p: any) => { p.metadata.deletionTimestamp = "2026-01-01"; }],
  ] as const;
  it.each(invalid)("acquire is explicitly unknown: %s", async (_name, mutate) => { fixture.mutate = mutate; assertUnknown(await acquire(backend)); });
  it("replacement between observation reads cannot attest", async () => { fixture.mutate = (p, n) => { if (n > 1) p.metadata.uid = "replacement"; }; assertUnknown(await acquire(backend)); });
  it.each(["podUid", "namespace", "containerName", "workloadUid", "jobName", "podName", "backend"])("resume rejects stale binding %s", async field => { const meta: any = binding(backend); meta[field] = "foreign"; const lease = await resume(backend, meta); if (lease.providerLeaseId !== null) assertUnknown(lease); });
  it("old resume metadata cannot attest even with a stored imageID", async () => { assertUnknown(await resume(backend, { namespace, backend, imageID: "stale-image" })); });
  it("resumed Pod replacement cannot attest", async () => { fixture.mutate = p => { p.metadata.uid = "replacement"; }; assertUnknown(await resume(backend, binding(backend))); });
  it("replaced workload with an old still-visible Pod cannot attest", async () => { const result = { metadata: { uid: "new-owner" }, status: { active: 1, phase: "Ready", podName: `${fixture.name}-pod` } }; fixture.clients.batch.readNamespacedJobStatus.mockResolvedValue(result); fixture.clients.custom.getNamespacedCustomObject.mockResolvedValue(result); assertUnknown(await resume(backend, binding(backend))); });
  it("read failure cannot turn persisted metadata into a measurement", async () => { const lease = await acquire(backend); fixture.clients.core.readNamespacedPod.mockRejectedValue({ code: 403 }); if (backend === "sandbox-cr") fixture.clients.core.readNamespacedPod.mockResolvedValueOnce(pod()); const resumed = await resume(backend, lease.metadata!); assertUnknown(resumed); });
});
it("CR exact-name fallback still produces a bound fresh observation", async () => { fixture.crLookup = "exact"; assertMeasured(await acquire("sandbox-cr"), "sandbox-cr"); });
it("CR label fallback still produces a bound fresh observation", async () => { fixture.crLookup = "label"; fixture.clients.core.listNamespacedPod.mockImplementation(async () => { const p: any = pod(); p.metadata.labels = { "agents.x-k8s.io/sandbox-name": fixture.name }; return { items: [p] }; }); assertMeasured(await acquire("sandbox-cr"), "sandbox-cr"); });
it("unscheduled Job remains explicitly unknown", async () => { fixture.noPod = true; assertUnknown(await acquire("job")); });
describe.each(["job", "sandbox-cr"])("pod not yet scheduled at acquire (%s)", backend => {
  it("acquire stays unknown, then resume measures once the owned Pod exists", async () => {
    fixture.noPod = true;
    if (backend === "sandbox-cr") fixture.crLookup = "none";
    const lease = await acquire(backend);
    assertUnknown(lease);
    expect(lease.metadata).toMatchObject({ podUid: null, workloadUid: "owner-uid", containerName: "agent" });
    fixture.noPod = false; fixture.crLookup = "status";
    assertMeasured(await resume(backend, lease.metadata!), backend);
  });
  it("an unbound acquire still rejects a Pod owned by a replaced workload on resume", async () => {
    fixture.noPod = true;
    if (backend === "sandbox-cr") fixture.crLookup = "none";
    const lease = await acquire(backend);
    fixture.noPod = false; fixture.crLookup = "status";
    fixture.mutate = p => { p.metadata.ownerReferences[0].uid = "new-owner"; };
    const resumed = await resume(backend, lease.metadata!);
    if (resumed.providerLeaseId !== null) assertUnknown(resumed);
  });
});
