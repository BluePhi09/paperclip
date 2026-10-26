import { environmentTaskResultSchema } from "@paperclipai/plugin-sdk";
import type { PluginTaskCredentialWritebackBinding } from "./plugin-task-credential-writeback.js";
import { OPENROUTER_ATTRIBUTION_HEADERS, openRouterClaudeHeaders } from "@paperclipai/shared/openrouter-attribution";
import { createHash } from "node:crypto";
import { HttpError, unprocessable } from "../errors.js";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { type Db, companySecrets, connectionGrants } from "@paperclipai/db";
import {
  AI_CONNECTION_CAPABILITIES,
  aiConnectionMetadataSchema, aiRoutingHarness,
  type AiConnectionBinding,
} from "@paperclipai/shared";
import { managedProviderRouting } from "./ai-provider-routing.js";
import { aiConnectionService } from "./ai-connections.js";
import { subscriptionService } from "./subscriptions.js";
import { refreshSubscriptionConnection } from "./subscription-refresh.js";
import { secretService } from "./secrets.js";
import { decideCodexAuthMerge, withAccountHomeSecretMutationLock } from "@paperclipai/adapter-codex-local/server";
import { WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE } from "@paperclipai/adapter-utils/workspace-restore-merge";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { runAdapterExecutionTargetProcess } from "@paperclipai/adapter-utils/execution-target";
import { decideGrokAuthMerge } from "@paperclipai/adapter-grok-local/server";

export function isAiConnectionBusy(error: unknown): error is HttpError {
  return error instanceof HttpError && error.status === 422 &&
    (error.details as { code?: unknown } | undefined)?.code === "ai_connection_busy";
}

// Blank values intentionally override inherited credentials in CLI child environments.
export const AI_AUTH_ENV_KEYS = [
  "COPILOT_GITHUB_TOKEN",
  "PAPERCLIP_AI_PROVIDER_KEY", "PAPERCLIP_AI_PROVIDER_URL", "PAPERCLIP_CODEX_PROVIDERS",
  "GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GEMINI_BASE_URL", "GOOGLE_GENAI_USE_VERTEXAI",
  "HERMES_HOME", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_BEARER_TOKEN_BEDROCK", "AWS_PROFILE", "AWS_DEFAULT_PROFILE", "AWS_SHARED_CREDENTIALS_FILE", "AWS_CONFIG_FILE", "AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_ROLE_ARN", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "ANTHROPIC_BEDROCK_BASE_URL", "ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL",

  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "OPENROUTER_API_KEY",
  "XAI_API_KEY",
  "GROK_API_KEY",
  "CODEX_HOME",
  "GROK_HOME",
  "CLAUDE_CONFIG_DIR",
  "OPENCODE_AUTH_JSON",
  "OPENCODE_CONFIG_CONTENT",
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_DIR",
  "PAPERCLIP_OPENCODE_PROVIDERS",
  "PAPERCLIP_PI_PROVIDERS",
  "ANTHROPIC_BASE_URL",
  "OPENAI_BASE_URL",
  "XAI_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
] as const;
export function stripAiAuthBindings(env: unknown): Record<string, unknown> {
  const result = {
    ...(env && typeof env === "object" ? (env as Record<string, unknown>) : {}),
  };
  for (const key of AI_AUTH_ENV_KEYS)
    if (
      ![
        "ANTHROPIC_BASE_URL",
        "OPENAI_BASE_URL",
        "XAI_BASE_URL",
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
        "CLAUDE_CODE_USE_FOUNDRY",
        "PAPERCLIP_OPENCODE_PROVIDERS",
      ].includes(key)
    )
      delete result[key];
  return result;
}
const PROJECT_AUTH_MESSAGES = {
  authOverride: "Remove authentication/configuration overrides before selecting a managed AI connection",
  conflict: "Project authentication settings conflict with the selected AI connection",
  remoteNotExecuted: "The project authentication scan could not execute; repair the environment before retrying",
  remoteIncomplete: "The project authentication scan did not complete; repair the environment before retrying",
  localUnreadable: "The project authentication scan could not read project settings; repair the workspace before retrying",
} as const;
const PROJECT_AUTH_MESSAGE_SET: ReadonlySet<string> = new Set(Object.values(PROJECT_AUTH_MESSAGES));
export function managedAiProjectAuthFailure(error: unknown, actionUrl: string) {
  // Never copy an arbitrary error message/details into persisted run evidence.
  const details = error instanceof HttpError && error.details && typeof error.details === "object"
    ? error.details as Record<string, unknown> : {};
  const reasons = ["key_detected", "scanner_failed", "remote_timeout", "remote_execution_failed", "auth_override_argument", "scanner_io_failed"];
  const reason = typeof details.reason === "string" && reasons.includes(details.reason) ? details.reason : "scanner_failed";
  const diagnostic = {
    code: "ai_connection_incompatible", reason,
    ...(details.phase === "remote_scan" || details.phase === "local_scan" || details.phase === "arguments" ? { phase: details.phase } : {}),
    ...(details.targetKind === "remote" || details.targetKind === "local" ? { targetKind: details.targetKind } : {}),
    ...(details.exitCode === null || (typeof details.exitCode === "number" && Number.isSafeInteger(details.exitCode)) ? { exitCode: details.exitCode } : {}),
    ...(typeof details.timedOut === "boolean" ? { timedOut: details.timedOut } : {}),
  };
  return {
    // The gate throws only fixed messages; report the same one on the run. Any
    // other message is never copied, so it falls back to a generic one.
    message: error instanceof HttpError && PROJECT_AUTH_MESSAGE_SET.has(error.message)
      ? error.message
      : "Project authentication could not be verified; repair the scanner or execution environment before retrying",
    resultJson: { configurationIncomplete: { reason: "ai_connection_incompatible", actionUrl, diagnostic } },
  };
}

export async function assertManagedAiProjectAuth(
  config: Record<string, unknown>,
  provider: AiConnectionBinding["provider"],
  target?: AdapterExecutionTarget | null,
) {
  const extraArgs = [
    ...(Array.isArray(config.extraArgs) ? config.extraArgs : []),
    ...(Array.isArray(config.args) ? config.args : []),
  ];
  if (
    extraArgs.some(
      (arg) =>
        typeof arg === "string" &&
        /^(--config|-c|--settings|--setting-sources|--api-key|--auth-token)(=|$)/.test(
          arg,
        ),
    )
  ) {
    throw unprocessable(
      PROJECT_AUTH_MESSAGES.authOverride,
      { code: "ai_connection_incompatible", reason: "auth_override_argument", phase: "arguments", targetKind: target?.kind ?? "local" },
    );
  }
  const files =
    provider === "anthropic"
      ? [".claude/settings.json", ".claude/settings.local.json"]
      : provider === "openai"
        ? [".codex/config.toml"]
        : [];
  const pattern =
    "apiKeyHelper|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|OPENAI_API_KEY|model_provider[[:space:]]*=|env_key[[:space:]]*=|experimental_bearer_token|cli_auth_credentials_store";
  if (target?.kind === "remote" && target.transport === "sandbox" && target.runnerTask && files.length) {
    const description = environmentTaskResultSchema.parse(await target.runnerTask({ kind: "describe" }));
    if (description.kind !== "description" || description.projectAuthCheckVersion !== 1) {
      throw unprocessable("The plugin environment cannot validate managed project authentication", { code: "ai_connection_incompatible" });
    }
    // The process owner checks the exact prepared configuration before it can submit credentials.
    return;
  }
  if (target?.kind === "remote" && files.length) {
    // Only inspect for conflicting keys; never return configuration or credential values.
    let result: Awaited<ReturnType<typeof runAdapterExecutionTargetProcess>>;
    try {
      result = await runAdapterExecutionTargetProcess(
      `ai-auth-check-${Date.now()}`,
      target,
      "sh",
      [
        "-c",
        `
directory=$1; pattern=$2; shift 2
while :; do
  test -d "$directory" && test -x "$directory" || exit 43
  for relative in "$@"; do
    file="$directory/$relative"
    settings_directory=$(dirname "$file") || exit 43
    if test -e "$settings_directory" || test -L "$settings_directory"; then
      test -d "$settings_directory" && test -x "$settings_directory" || exit 43
    fi
    if test -e "$file" || test -L "$file"; then
      test -f "$file" && test -r "$file" || exit 43
      grep -Eq "$pattern" "$file"
      result=$?
      if test "$result" -eq 0; then exit 42; fi
      if test "$result" -ne 1; then exit 43; fi
    fi
  done
  parent=$(dirname "$directory")
  if test "$parent" = "$directory"; then break; fi
  directory=$parent
done`,
        "ai-auth-check",
        target.remoteCwd,
        pattern,
        ...files,
      ],
      {
        cwd: target.remoteCwd,
        env: {},
        timeoutSec: 15,
        graceSec: 1,
        onLog: async () => {},
      },
    );
    } catch {
      throw unprocessable(PROJECT_AUTH_MESSAGES.remoteNotExecuted, {
        code: "ai_connection_incompatible", reason: "remote_execution_failed", phase: "remote_scan", targetKind: "remote",
      });
    }
    if (result.exitCode !== 0 || result.timedOut || result.signal)
      throw unprocessable(
        result.exitCode === 42 && !result.timedOut && !result.signal
          ? PROJECT_AUTH_MESSAGES.conflict
          : PROJECT_AUTH_MESSAGES.remoteIncomplete,
        { code: "ai_connection_incompatible", reason: result.timedOut ? "remote_timeout"
            : result.signal ? "remote_execution_failed" : result.exitCode === 42 ? "key_detected"
            : result.exitCode === 43 ? "scanner_failed" : "remote_execution_failed",
          phase: "remote_scan", targetKind: "remote", exitCode: result.exitCode, timedOut: result.timedOut },
      );
    return;
  }
  let directory =
    typeof config.cwd === "string" ? path.resolve(config.cwd) : process.cwd();
  for (;;) {
    for (const relative of files) {
      try {
        const content = await readFile(path.join(directory, relative), "utf8");
        if (
          /apiKeyHelper|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|OPENAI_API_KEY|model_provider\s*=|env_key\s*=|experimental_bearer_token|cli_auth_credentials_store/.test(
            content,
          )
        ) {
          throw unprocessable(
            PROJECT_AUTH_MESSAGES.conflict,
            { code: "ai_connection_incompatible", reason: "key_detected", phase: "local_scan", targetKind: "local" },
          );
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        if (error instanceof HttpError) throw error;
        throw unprocessable(PROJECT_AUTH_MESSAGES.localUnreadable, {
          code: "ai_connection_incompatible", reason: "scanner_io_failed", phase: "local_scan", targetKind: "local",
        });
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
}

function managedAiHomeEnvironment(home: string): Record<string, string> {
  const providerHome = path.join(home, "provider");
  return {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_DATA_HOME: path.join(home, "data"),
    CODEX_HOME: providerHome,
    GROK_HOME: providerHome,
    CLAUDE_CONFIG_DIR: providerHome,
    HERMES_HOME: providerHome,
  };
}

/** Only the server-created credential home is volatile; retain all other config. */
export function managedAiSessionFingerprintConfig(
  config: Record<string, unknown>,
  managedHome: string | undefined,
): Record<string, unknown> {
  if (!managedHome) return config;
  const env = { ...(config.env as Record<string, unknown> | undefined) };
  const stable = managedAiHomeEnvironment("<managed-ai-home>");
  for (const [key, value] of Object.entries(managedAiHomeEnvironment(managedHome))) {
    if (env[key] === value) env[key] = stable[key];
  }
  const managed = config.managedAiConnection as Record<string, unknown> | undefined;
  if (managed?.sessionIdentity) {
    for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY", "OPENROUTER_API_KEY", "XAI_API_KEY", "GROK_API_KEY", "OPENCODE_AUTH_JSON", "OPENCODE_CONFIG_CONTENT"]) {
      if (env[key]) env[key] = "<managed-ai-credential>";
    }
  }
  return { ...config, env, ...(managed?.sessionIdentity ? { managedAiConnection: { ...managed, identity: managed.sessionIdentity } } : {}) };
}

export async function prepareManagedAiRuntime(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    responsibleUserId: string | null;
    adapterType: string;
    binding: AiConnectionBinding;
    allowUninstalledPersonal?: boolean;
    allowUninstalledShared?: boolean;
    allowLegacyValidation?: boolean;
    config: Record<string, unknown>;
  },
) {
  const configuredEnv =
    input.config.env && typeof input.config.env === "object"
      ? (input.config.env as Record<string, unknown>)
      : {};
  for (const key of [
    "ANTHROPIC_BASE_URL",
    "OPENAI_BASE_URL",
    "XAI_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "PAPERCLIP_OPENCODE_PROVIDERS",
    "PAPERCLIP_AI_PROVIDER_URL", "PAPERCLIP_CODEX_PROVIDERS", "PAPERCLIP_PI_PROVIDERS", "OPENCODE_CONFIG_CONTENT", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "GOOGLE_GEMINI_BASE_URL", "ANTHROPIC_BEDROCK_BASE_URL",
  ]) {
    if (configuredEnv[key])
      throw unprocessable(
        "The configured provider routing is incompatible with this AI connection",
        { code: "ai_connection_incompatible" },
      );
  }
  const harness = aiRoutingHarness(input.adapterType, input.config.provider, input.config.acpxAgent);
  await assertManagedAiProjectAuth(input.config, harness === "claude_local" ? "anthropic" : harness === "codex_local" ? "openai" : input.binding.provider);
  const service = aiConnectionService(db);
  let selection = await service.select({
    ...input,
    userId: input.responsibleUserId,
    model: input.config.model,
    runnerProvider: input.config.provider,
    acpxAgent: input.config.acpxAgent,
  });
  const subscriptionFile =
    selection.attribution.method === "subscription" &&
    input.binding.provider !== "anthropic";
  let home: string | undefined;
  try {
    const selectedGrantId = selection.grant.id;
    selection = await service.select({
      ...input,
      userId: input.responsibleUserId,
      model: input.config.model,
      runnerProvider: input.config.provider,
      acpxAgent: input.config.acpxAgent,
    });
    if (selection.grant.id !== selectedGrantId)
      throw unprocessable(
        "The selected default changed. Retry this execution.",
      );
    const credentialRef = selection.grant.credentialSecretRefs.find((ref) => ref.configPath === "ai.credential");
    const routing = aiConnectionMetadataSchema.parse(selection.connection.config.ai).routing;
    const noAuth = routing?.auth === "none";
    if (!noAuth && !credentialRef) throw unprocessable("The selected AI credential is unavailable");
    const readFreshness = async () => {
      if (!credentialRef) return undefined;
      const [currentGrant] = await db.select({ refs: connectionGrants.credentialSecretRefs, status: connectionGrants.status })
        .from(connectionGrants).where(and(eq(connectionGrants.companyId, input.companyId), eq(connectionGrants.id, selection.grant.id)));
      const currentRef = currentGrant?.refs.find(ref => ref.configPath === "ai.credential");
      if (currentGrant?.status !== "active" || currentRef?.secretId !== credentialRef.secretId || currentRef.versionSelector !== credentialRef.versionSelector) return undefined;
      return (await db.select({ epoch: companySecrets.aiSessionEpoch, version: companySecrets.latestVersion })
        .from(companySecrets).where(and(eq(companySecrets.companyId, input.companyId), eq(companySecrets.id, credentialRef.secretId))).limit(1))[0];
    };
    // A Claude subscription token refresh writes a new secret version but keeps
    // the session epoch; a reconnect changes the epoch, so the epoch alone
    // detects it for that credential type.
    const refreshesToken = !noAuth && input.binding.provider === "anthropic" && selection.attribution.method === "subscription";
    const { value, freshness } = await (async () => {
      if (noAuth) return { value: "", freshness: undefined };
      // Recovering a rotated quota token can advance the secret version during
      // the first read. Re-read the saved credential, retaining the epoch guard
      // against a concurrent reconnect or explicit rotation.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const before = await readFreshness();
        const value = await service.runtimeCredential(selection);
        const after = await readFreshness();
        if (before && after && before.epoch === after.epoch && (refreshesToken || before.version === after.version)) {
          return { value, freshness: after };
        }
        if (!before || before.epoch !== after?.epoch) break;
      }
      throw unprocessable("The AI credential changed during preparation; retry this execution");
    })();
    home = await mkdtemp(
      path.join(
        os.tmpdir(),
        `paperclip-ai-${input.companyId}-${selection.grant.id}-`,
      ),
    );
    const providerHome = path.join(home, "provider");
    await mkdir(providerHome, { mode: 0o700 });
    const env: Record<string, unknown> = {
      ...stripAiAuthBindings(input.config.env),
      ...Object.fromEntries(AI_AUTH_ENV_KEYS.map((key) => [key, ""])),
      ...managedAiHomeEnvironment(home),
      ...(input.binding.provider === "github" ? { GH_TOKEN: "", GITHUB_TOKEN: "" } : {}),
    };
    const capability =
      AI_CONNECTION_CAPABILITIES[input.binding.provider].methods[
        selection.attribution.method
      ]!;
    const authFile = path.join(providerHome, "auth.json");
    if (harness === "codex_local")
      await writeFile(
        path.join(providerHome, "config.toml"),
        'cli_auth_credentials_store = "file"\n',
        { mode: 0o600 },
      );
    if (!routing && subscriptionFile) await writeFile(authFile, value, { mode: 0o600 });
    else if (!routing) env[capability.envKey] = value;
    if (
      !routing && input.binding.provider === "openai" && harness === "codex_local" &&
      selection.attribution.method === "api_key"
    ) {
      env.CODEX_API_KEY = value;
      await writeFile(authFile, JSON.stringify({ OPENAI_API_KEY: value }), {
        mode: 0o600,
      });
    }
    if (!routing && input.binding.provider === "openrouter" && harness === "opencode_local") {
      env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
        provider: { openrouter: { options: { apiKey: value, headers: OPENROUTER_ATTRIBUTION_HEADERS } } },
      });
      env.OPENCODE_DISABLE_PROJECT_CONFIG = "true";
    }
    if (!routing && input.binding.provider === "google" && harness === "gemini_local") {
      // Gemini headless CLI requires an explicit auth choice even with an API key.
      // Seed only the disposable connection home, never the operator's settings.
      const geminiHome = path.join(home, ".gemini");
      await mkdir(geminiHome, { mode: 0o700 });
      await writeFile(path.join(geminiHome, "settings.json"), JSON.stringify({
        selectedAuthType: "gemini-api-key",
        security: { auth: { selectedType: "gemini-api-key" } },
      }), { mode: 0o600 });
    }
    const projected = routing ? managedProviderRouting(routing, harness, value, typeof input.config.model === "string" ? input.config.model : "") : undefined;
    if (projected) {
      const customHeaders = env.ANTHROPIC_CUSTOM_HEADERS ?? process.env.ANTHROPIC_CUSTOM_HEADERS;
      Object.assign(env, projected.env);
      if (projected.env.ANTHROPIC_CUSTOM_HEADERS && customHeaders !== undefined) {
        // Preserve secret references until adapter resolution; the adapter merges
        // attribution after resolving them. Ordinary gateway headers survive too.
        env.ANTHROPIC_CUSTOM_HEADERS = typeof customHeaders === "string"
          ? openRouterClaudeHeaders(customHeaders)
          : customHeaders;
      }
      if (projected.hermesConfig) await writeFile(path.join(providerHome, "config.yaml"), projected.hermesConfig, { mode: 0o600 });
      if (projected.codexConfig) await writeFile(path.join(providerHome, "config.toml"), 'cli_auth_credentials_store = "file"\n' + projected.codexConfig, { mode: 0o600 });
    }
    const attribution = { ...selection.attribution } as typeof selection.attribution & { subscriptionId?: string };
    if (attribution.method === "subscription") {
      const subscription = {
        companyId: input.companyId, connectionId: selection.connection.id, grantId: selection.grant.id,
        provider: selection.attribution.provider, name: selection.connection.name,
        ownerUserId: selection.grant.subjectUserId, credential: value,
        session: credentialRef && freshness ? { secretId: credentialRef.secretId, epoch: freshness.epoch } : null,
      };
      attribution.subscriptionId = await subscriptionService(db).register(subscription);
      void refreshSubscriptionConnection(db, subscription, attribution.subscriptionId);
    }
    const generation = createHash("sha256")
      .update(value)
      .digest("hex")
      .slice(0, 16);
    const identity = `${selection.grant.id}:${input.responsibleUserId ?? "shared"}:${generation}`;
    const sessionIdentity = `${selection.grant.id}:${input.responsibleUserId ?? "shared"}:${noAuth ? "no-auth" : `${credentialRef!.secretId}:${freshness!.epoch}`}`;
    return {
      sessionIdentity,
      ...(subscriptionFile && input.binding.provider === "openai" && credentialRef && freshness ? {
        credentialWriteback: { grantId: selection.grant.id, secretId: credentialRef.secretId, sessionEpoch: freshness.epoch,
          versionSelector: credentialRef.versionSelector ?? "latest" } satisfies PluginTaskCredentialWritebackBinding,
      } : {}),
      config: {
        ...input.config,
        ...projected?.config,
        ...(routing ? { managedAiRouting: routing } : {}),
        env,
        managedAiConnection: { ...attribution, identity, sessionIdentity },
      },
      attribution,
      accountName: selection.connection.name,
      accountOwnerUserId: selection.grant.subjectUserId,
      identity,
      home,
      cleanup: async () => {
        if (subscriptionFile) {
          const refreshed = await readFile(authFile, "utf8");
          if (refreshed !== value) {
            // A quota exchange can hold this company lock for 60 seconds.
            // Retry its 30-second acquisition timeout without discarding the
            // provider's only copy of a rotated, single-use refresh token.
            const writeBack = () => withAccountHomeSecretMutationLock(undefined, input.companyId, () => db.transaction(async (tx) => {
              const [grant] = await tx
                .select()
                .from(connectionGrants)
                .where(
                  and(
                    eq(connectionGrants.id, selection.grant.id),
                    eq(connectionGrants.companyId, input.companyId),
                  ),
                )
                .for("update");
              // A missing or revoked grant blocks the write-back. Among
              // active copies, the merge decision below keeps the
              // credential with the newest provider freshness field.
              if (!grant || grant.status !== "active") return;
              const ref = grant.credentialSecretRefs.find(
                (r) => r.configPath === "ai.credential",
              );
              if (!ref) return;
              // Lock the referenced secret row for the rest of this
              // transaction. The grant-row lock above does not cover it,
              // so an authorized rotation of this secret could otherwise
              // land between the read and the write below and be
              // overwritten by this stale write-back.
              await tx
                .select({ id: companySecrets.id })
                .from(companySecrets)
                .where(
                  and(
                    eq(companySecrets.id, ref.secretId),
                    eq(companySecrets.companyId, input.companyId),
                  ),
                )
                .for("update");
              const current = await aiConnectionService(
                tx as unknown as Db,
              ).credential({ ...selection, grant });
              const destination = path.join(
                providerHome,
                "current-auth.json",
              );
              await writeFile(destination, current, { mode: 0o600 });
              const decision =
                input.binding.provider === "openai"
                  ? await decideCodexAuthMerge(authFile, destination, {
                      errorLabel: "AI account refresh",
                    })
                  : await decideGrokAuthMerge(authFile, destination, {
                      errorLabel: "AI account refresh",
                    });
              if (decision !== 10) return;
              await secretService(tx).rotate(
                ref.secretId,
                { value: refreshed, preserveAiSessionEpoch: true },
                { userId: grant.subjectUserId },
              );
              // Keep grant.updatedAt for explicit account/access changes.
              // The rotated secret revision invalidates quota caches without
              // rejecting an otherwise valid in-flight reconnect.
            }));
            for (let attempt = 0; ; attempt++) {
              try { await writeBack(); break; }
              catch (error) {
                if (attempt >= 2 || (error as NodeJS.ErrnoException)?.code !== WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE) throw error;
              }
            }
          }
        }
        // Preserve the private home on any failed write-back, including an
        // exhausted lock retry or database failure. The caller can retry the
        // same cleanup; only a committed save or an intentional discard
        // (revoked grant, older/different identity) permits deletion.
        if (home) await rm(home, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (home) await rm(home, { recursive: true, force: true });
    throw error;
  }
}

/** Manual tests/adoption have no heartbeat row for quota's active-run guard.
 * Hold the shared credential lock from resolution through the provider probe
 * and write-back. Nested credential writes reuse this lock's async ownership. */
export async function withManagedAiProbe<T>(
  db: Db,
  input: Parameters<typeof prepareManagedAiRuntime>[1],
  probe: (runtime: Awaited<ReturnType<typeof prepareManagedAiRuntime>>) => Promise<T>,
): Promise<T> {
  const run = async () => {
    const runtime = await prepareManagedAiRuntime(db, input);
    try { return await probe(runtime); }
    finally { await runtime.cleanup(); }
  };
  return input.binding.provider === "openai"
    ? withAccountHomeSecretMutationLock(undefined, input.companyId, run).catch(error => {
      if ((error as NodeJS.ErrnoException)?.code === WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE) {
        throw unprocessable("AI credentials are being updated. Retry shortly.", { code: "ai_connection_busy" });
      }
      throw error;
    })
    : run();
}
