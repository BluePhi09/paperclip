/**
 * Kubernetes resource quantity for storage sizes: a positive decimal number
 * with an optional binary (Ki..Ei) or decimal (k, M..E) suffix, e.g. `8Gi`,
 * `512Mi`, `10G`. Exponent and milli forms are valid quantities but make no
 * sense for an emptyDir size limit, so they are rejected here.
 */
export const STORAGE_QUANTITY_PATTERN = "^(?:[0-9]+(?:\\.[0-9]+)?|\\.[0-9]+)(?:Ki|Mi|Gi|Ti|Pi|Ei|k|M|G|T|P|E)?$";
const storageQuantityRegex = new RegExp(STORAGE_QUANTITY_PATTERN);

export function isValidStorageQuantity(value: string): boolean {
  return storageQuantityRegex.test(value) && Number.parseFloat(value) > 0;
}

/** Optional per-volume emptyDir `sizeLimit` overrides (validated in `types.ts`). */
export interface SandboxVolumesConfig {
  workspaceSizeLimit?: string;
  homeSizeLimit?: string;
  cacheSizeLimit?: string;
  tmpSizeLimit?: string;
}

export interface SandboxVolumeSizeLimits {
  workspace: string;
  home: string;
  cache: string;
  tmp: string;
}

/**
 * `/tmp` defaults to 8Gi: package managers and type checkers on large
 * monorepos (e.g. `pnpm install` + `tsc`) exceeded the former 2Gi limit and
 * the kubelet evicted the sandbox pod.
 */
export const DEFAULT_SANDBOX_VOLUME_SIZE_LIMITS: Readonly<SandboxVolumeSizeLimits> = Object.freeze({
  workspace: "8Gi",
  home: "1Gi",
  cache: "1Gi",
  tmp: "8Gi",
});

export function resolveSandboxVolumeSizeLimits(config?: SandboxVolumesConfig): SandboxVolumeSizeLimits {
  return {
    workspace: config?.workspaceSizeLimit ?? DEFAULT_SANDBOX_VOLUME_SIZE_LIMITS.workspace,
    home: config?.homeSizeLimit ?? DEFAULT_SANDBOX_VOLUME_SIZE_LIMITS.home,
    cache: config?.cacheSizeLimit ?? DEFAULT_SANDBOX_VOLUME_SIZE_LIMITS.cache,
    tmp: config?.tmpSizeLimit ?? DEFAULT_SANDBOX_VOLUME_SIZE_LIMITS.tmp,
  };
}

/** The emptyDir `volumes` list shared by the Job and Sandbox CR pod templates. */
export function buildSandboxVolumes(config?: SandboxVolumesConfig): Array<{ name: string; emptyDir: { sizeLimit: string } }> {
  const limits = resolveSandboxVolumeSizeLimits(config);
  return [
    { name: "workspace", emptyDir: { sizeLimit: limits.workspace } },
    { name: "home", emptyDir: { sizeLimit: limits.home } },
    { name: "cache", emptyDir: { sizeLimit: limits.cache } },
    { name: "tmp", emptyDir: { sizeLimit: limits.tmp } },
  ];
}
