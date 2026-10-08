import type { V1Pod } from "@kubernetes/client-node";
import type { KubeClients } from "./kube-client.js";

// Both manifest builders and the CR exec transport select this container.
// Never fall back to the first status: admission can prepend sidecars.
export const MAIN_CONTAINER_NAME = "agent";
export type ContainerIdentity =
  | { status: "unknown"; reason: string }
  | {
      status: "measured";
      source: "kubernetes.containerStatuses.imageID";
      providerLeaseId: string;
      backend: "job" | "sandbox-cr";
      workloadUid: string;
      namespace: string;
      podName: string;
      podUid: string;
      containerName: string;
      imageID: string;
      observedAt: string;
    };
export interface ContainerObservation {
  imageID: string | null;
  podUid: string | null;
  workloadUid: string | null;
  containerName: string;
  containerIdentity: ContainerIdentity;
}

/** Point-in-time observation, not a claim about later execution or registry contents. */
export async function observeContainerIdentity(
  clients: KubeClients,
  input: {
    providerLeaseId: string;
    namespace: string;
    backend: "job" | "sandbox-cr";
    podName: string | null;
    workloadUid: string | null;
    imageRef: string | null;
    // Resume requires the allocation binding recorded at acquire, not its old imageID.
    resumeMetadata?: Record<string, unknown>;
    expectedNamespace: string;
  },
): Promise<ContainerObservation> {
  let podUid: string | null = null;
  const unknown = (reason: string): ContainerObservation => ({
    imageID: null, podUid, workloadUid: input.workloadUid,
    containerName: MAIN_CONTAINER_NAME, containerIdentity: { status: "unknown", reason },
  });
  if (!input.podName || !input.workloadUid || input.namespace !== input.expectedNamespace
    || (input.backend !== "job" && input.backend !== "sandbox-cr")) {
    return unknown("allocation_binding_unavailable");
  }
  const previous = input.resumeMetadata;
  // Acquire usually returns before the Pod is scheduled, recording podName/podUid
  // as null with the workload binding only. Such a lease may be measured on
  // resume through the owner-UID binding; a Pod UID recorded at acquire must
  // still match exactly, so a replaced Pod never attests.
  const priorPodUid = typeof previous?.podUid === "string" && previous.podUid.trim() ? previous.podUid : null;
  if (previous && (
    previous.namespace !== input.namespace || previous.backend !== input.backend
    || previous.jobName !== input.providerLeaseId
    || (previous.podName != null && previous.podName !== input.podName)
    || (previous.podUid != null && !priorPodUid)
    || (priorPodUid !== null && previous.podName == null)
    || typeof previous.workloadUid !== "string" || previous.workloadUid !== input.workloadUid
    || previous.containerName !== MAIN_CONTAINER_NAME
  )) return unknown("resume_binding_mismatch_or_missing");

  const matches = (pod: V1Pod): boolean => {
    const meta = pod.metadata;
    const owners = meta?.ownerReferences?.filter(owner => owner.controller === true) ?? [];
    return meta?.namespace === input.namespace && meta?.name === input.podName
      && typeof meta.uid === "string" && Boolean(meta.uid.trim()) && !meta.deletionTimestamp
      && owners.length === 1 && owners[0]?.uid === input.workloadUid
      && owners[0]?.name === input.providerLeaseId
      && owners[0]?.kind === (input.backend === "job" ? "Job" : "Sandbox")
      && owners[0]?.apiVersion === (input.backend === "job" ? "batch/v1" : "agents.x-k8s.io/v1alpha1")
      && pod.spec?.containers.filter(c => c.name === MAIN_CONTAINER_NAME).length === 1
      && Boolean(input.imageRef) && pod.spec?.containers.find(c => c.name === MAIN_CONTAINER_NAME)?.image === input.imageRef;
  };
  try {
    if (previous) {
      const workload = input.backend === "job"
        ? await clients.batch.readNamespacedJobStatus({ namespace: input.namespace, name: input.providerLeaseId })
        : await clients.custom.getNamespacedCustomObject({ namespace: input.namespace, name: input.providerLeaseId,
          group: "agents.x-k8s.io", version: "v1alpha1", plural: "sandboxes" });
      if ((workload as { metadata?: { uid?: string } }).metadata?.uid !== input.workloadUid) {
        return unknown("workload_replaced_or_unbound");
      }
    }
    const request = { namespace: input.namespace, name: input.podName };
    const selected = await clients.core.readNamespacedPod(request);
    if (!matches(selected)) return unknown("pod_binding_mismatch");
    if (priorPodUid !== null && selected.metadata!.uid !== priorPodUid) return unknown("pod_replaced");
    const selectedUid: string = selected.metadata!.uid!;
    podUid = selectedUid;
    // Re-read the exact selected allocation, fencing replacement during observation.
    // No polling, exec, registry lookup or write is necessary for this evidence.
    const fresh = await clients.core.readNamespacedPod(request);
    if (!matches(fresh) || fresh.metadata!.uid !== podUid) return unknown("pod_replaced_or_mismatched");
    const statuses = fresh.status?.containerStatuses?.filter(s => s.name === MAIN_CONTAINER_NAME) ?? [];
    const imageID = statuses.length === 1 ? statuses[0]?.imageID : null;
    if (typeof imageID !== "string" || !imageID.trim()) return unknown("container_image_id_unavailable");
    return {
      imageID, podUid, workloadUid: input.workloadUid, containerName: MAIN_CONTAINER_NAME,
      containerIdentity: {
        status: "measured", source: "kubernetes.containerStatuses.imageID",
        providerLeaseId: input.providerLeaseId, backend: input.backend,
        workloadUid: input.workloadUid, namespace: input.namespace, podName: input.podName,
        podUid: selectedUid, containerName: MAIN_CONTAINER_NAME, imageID, observedAt: new Date().toISOString(),
      },
    };
  } catch {
    // Unknown includes denied/unavailable API reads. Never recycle persisted evidence
    // or leak an API error body that may contain credentials/configuration.
    return unknown("pod_observation_failed");
  }
}
