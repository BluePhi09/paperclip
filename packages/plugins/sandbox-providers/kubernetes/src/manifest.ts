import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { DEFAULT_SANDBOX_VOLUME_SIZE_LIMITS, STORAGE_QUANTITY_PATTERN } from "./sandbox-volumes.js";

const PLUGIN_ID = "paperclip.kubernetes-sandbox-provider";
const PLUGIN_VERSION = "0.1.0-alpha.1";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Kubernetes Sandbox (alpha)",
  description:
    "Built on kubernetes-sigs/agent-sandbox (v1alpha1). ALPHA — expect breaking changes as the upstream CRD evolves. First-party Paperclip sandbox-provider plugin for Kubernetes.",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: ["environment.drivers.register"],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  environmentDrivers: [
    {
      driverKey: "kubernetes",
      kind: "sandbox_provider",
      supportsLoginPty: true,
      displayName: "Kubernetes",
      description:
        "Dispatches agent runs in per-tenant Kubernetes namespaces. The sandbox-cr backend uses kubernetes-sigs/agent-sandbox for multi-command exec and managed login PTY.",
      configSchema: {
        type: "object",
        properties: {
          inCluster: {
            type: "boolean",
            description:
              "When true, the plugin uses the in-pod ServiceAccount credentials. Requires paperclip-server to be running inside the target cluster.",
          },
          kubeconfig: {
            type: "string",
            format: "secret-ref",
            description:
              "Inline kubeconfig YAML. Paste a kubeconfig or an existing Paperclip secret reference; pasted values are stored as company secrets.",
          },
          namespacePrefix: {
            type: "string",
            description: "Prefix for the per-company tenant namespace (default: paperclip-).",
          },
          companySlug: {
            type: "string",
            description: "Override the auto-derived company slug used in the tenant namespace name.",
          },
          imageRegistry: {
            type: "string",
            description: "Override the default registry for agent runtime images (default: ghcr.io/paperclipai).",
          },
          imageAllowList: {
            type: "array",
            items: { type: "string" },
            description:
              "Glob patterns of allowed `target.imageOverride` values. Empty list = no override permitted.",
          },
          preloadedImages: {
            type: "boolean",
            description:
              "Air-gapped/offline clusters only: when true, always use imagePullPolicy IfNotPresent, even for floating tags like :latest, because preloaded nodes have no registry path at pod-start time.",
          },
          imagePullSecrets: {
            type: "array",
            items: { type: "string" },
            description: "Names of pre-created Docker image pull secrets in the tenant namespace.",
          },
          egressAllowFqdns: {
            type: "array",
            items: { type: "string" },
            description:
              "Additional FQDNs to allow egress to from agent pods. Adapter-default FQDNs (e.g. api.anthropic.com) are added automatically.",
          },
          egressAllowCidrs: {
            type: "array",
            items: { type: "string" },
            description: "Additional CIDRs to allow egress to from agent pods.",
          },
          egressMode: {
            type: "string",
            enum: ["standard", "cilium"],
            description: "Network policy mode. `cilium` enables FQDN-based egress filtering via CiliumNetworkPolicy.",
          },
          paperclipServerPodSelector: {
            type: "object",
            additionalProperties: { type: "string" },
            description: "Labels on the Paperclip API pod accepting agent callbacks on port 3100 (default: app=paperclip-server).",
          },
          defaultResources: {
            type: "object",
            description:
              "CPU and memory requests/limits for the agent container. Unset requests default to cpu 250m / memory 512Mi; unset limits default to cpu 2 / memory 4Gi. Keep values within the tenant namespace LimitRange and ResourceQuota.",
            properties: {
              requests: {
                type: "object",
                description: "Resource requests (scheduling guarantee).",
                properties: {
                  cpu: { type: "string", description: "CPU request, e.g. `250m` or `1`." },
                  memory: { type: "string", description: "Memory request, e.g. `512Mi` or `2Gi`." },
                },
              },
              limits: {
                type: "object",
                description: "Resource limits (hard cap; exceeding the memory limit OOM-kills the container).",
                properties: {
                  cpu: { type: "string", description: "CPU limit, e.g. `2`." },
                  memory: { type: "string", description: "Memory limit, e.g. `4Gi`." },
                },
              },
            },
          },
          sandboxVolumes: {
            type: "object",
            description:
              "Size limits for the writable emptyDir volumes of the agent pod. Exceeding a limit makes the kubelet evict the pod. Values are Kubernetes quantities such as `8Gi` or `512Mi`.",
            properties: {
              workspaceSizeLimit: {
                type: "string",
                pattern: STORAGE_QUANTITY_PATTERN,
                description: `Size limit for /workspace (default: ${DEFAULT_SANDBOX_VOLUME_SIZE_LIMITS.workspace}).`,
              },
              homeSizeLimit: {
                type: "string",
                pattern: STORAGE_QUANTITY_PATTERN,
                description: `Size limit for /home/paperclip (default: ${DEFAULT_SANDBOX_VOLUME_SIZE_LIMITS.home}).`,
              },
              cacheSizeLimit: {
                type: "string",
                pattern: STORAGE_QUANTITY_PATTERN,
                description: `Size limit for /home/paperclip/.cache (default: ${DEFAULT_SANDBOX_VOLUME_SIZE_LIMITS.cache}).`,
              },
              tmpSizeLimit: {
                type: "string",
                pattern: STORAGE_QUANTITY_PATTERN,
                description: `Size limit for /tmp (default: ${DEFAULT_SANDBOX_VOLUME_SIZE_LIMITS.tmp}). Raise it when package installs or builds in the sandbox fill /tmp.`,
              },
            },
          },
          runtimeClassName: {
            type: "string",
            description:
              "Optional RuntimeClass for pod isolation (e.g. `kata-fc` for Firecracker-backed microVMs). Cluster must have the RuntimeClass installed.",
          },
          serviceAccountAnnotations: {
            type: "object",
            additionalProperties: { type: "string" },
            description:
              "Annotations applied to the per-tenant ServiceAccount (e.g. `eks.amazonaws.com/role-arn` for IRSA).",
          },
          jobTtlSecondsAfterFinished: {
            type: "integer",
            minimum: 0,
            description: "Seconds after a Job completes before it is garbage-collected (default: 900).",
          },
          podActivityDeadlineSec: {
            type: "integer",
            minimum: 1,
            description: "Hard ceiling on a single run's wall-clock time (default: 3600).",
          },
          adapterType: {
            type: "string",
            description:
              "The adapter type that Jobs in this environment will run (e.g. `claude_local`, `codex_local`). Defaults to `claude_local`. Each environment is bound to one adapter; create multiple environments for different adapters.",
          },
          backend: {
            type: "string",
            enum: ["sandbox-cr"],
            description:
              "sandbox-cr (default, alpha — requires kubernetes-sigs/agent-sandbox installed); job is incompatible with the advertised login PTY capability",
          },
        },
        anyOf: [
          { required: ["inCluster"] },
          { required: ["kubeconfig"] },
        ],
      },
    },
  ],
};

export default manifest;
