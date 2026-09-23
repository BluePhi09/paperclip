import { createHash } from "node:crypto";
import { forbidden, unprocessable } from "../errors.js";
import { hasExactSlackCeoScopes, slackCeoBotScopes, type SlackCeoBotProfile, SLACK_CEO_DM_PROFILE, SLACK_CEO_DM_SCOPES } from "./slack-ceo-permission-profiles.js";
export { SLACK_CEO_DM_PROFILE, SLACK_CEO_DM_SCOPES } from "./slack-ceo-permission-profiles.js";

/** The existing adapter profile, not a least-privilege production profile. */
export const SLACK_ADAPTER_BOT_SCOPES = [
  "app_mentions:read", "assistant:write", "channels:history", "channels:read",
  "chat:write", "commands", "files:read", "files:write", "groups:history",
  "groups:read", "im:history", "im:read", "mpim:history", "mpim:read",
  "reactions:read", "reactions:write", "users:read",
] as const;

/** Called only after Slack's raw-body signature has been verified. */
export function slackDmPilotRequestAllowed(raw: string, contentType: string, appId: string | undefined, userId: string | undefined) {
  try {
    const form = contentType.includes("application/x-www-form-urlencoded") ? new URLSearchParams(raw) : null;
    const payload = form ? (form.has("payload") ? JSON.parse(form.get("payload")!) : Object.fromEntries(form)) : JSON.parse(raw);
    if (payload.api_app_id && payload.api_app_id !== appId) return false;
    if (payload.type === "url_verification") return true;
    const event = payload.event;
    if (event?.type === "app_uninstalled" || event?.type === "tokens_revoked") return true;
    if (!userId) return false;
    if (event) {
      return event.type === "message" && event.channel_type === "im" && /^D[A-Z0-9]+$/.test(event.channel ?? "") &&
        (event.user ?? event.message?.user ?? event.previous_message?.user) === userId;
    }
    if (form && !form.has("payload")) return /^D[A-Z0-9]+$/.test(payload.channel_id ?? "") && payload.user_id === userId;
    if (payload.user?.id !== userId) return false;
    if (["view_submission", "view_closed"].includes(payload.type)) return true; // Existing modal nonce/revision checks still apply.
    return /^D[A-Z0-9]+$/.test(payload.channel?.id ?? payload.container?.channel_id ?? "");
  } catch { return false; }
}

const PREFIX = "PAPERCLIP_SLACK_CEO_POC_";
const REQUIRED = ["COMPANY_ID", "USER_ID", "AGENT_ID", "APP_ID", "TEAM_ID", "CLIENT_ID", "CLIENT_SECRET", "SIGNING_SECRET"] as const;
export type SlackBotOAuthConfig = Record<(typeof REQUIRED)[number], string>;

export function slackBotOAuthStatus(publicBaseUrl: string | null, endpointId: string, env = process.env, profile: SlackCeoBotProfile = SLACK_CEO_DM_PROFILE) {
  const enabled = env[`${PREFIX}ENABLED`] === "true";
  let callbackUrl: string | null = null;
  try {
    const origin = new URL(publicBaseUrl ?? "");
    if (origin.protocol === "https:" && !origin.username && !origin.password) {
      callbackUrl = new URL(`/api/chat-endpoints/${endpointId}/slack/oauth/callback`, origin.origin).href;
    }
  } catch { /* Missing configuration is an operator prerequisite. */ }
  return {
    enabled,
    configured: enabled && Boolean(callbackUrl) && REQUIRED.every((key) => Boolean(env[`${PREFIX}${key}`]?.trim())),
    callbackUrl,
    missing: enabled ? [
      ...REQUIRED.filter((key) => !env[`${PREFIX}${key}`]?.trim()).map((key) => `${PREFIX}${key}`),
      ...(!callbackUrl ? ["PAPERCLIP_PUBLIC_URL (HTTPS)"] : []),
    ] : [],
    profile,
    scopes: [...slackCeoBotScopes(profile)],
  };
}

export function slackBotOAuthConfig(publicBaseUrl: string | null, endpointId: string, env = process.env) {
  const status = slackBotOAuthStatus(publicBaseUrl, endpointId, env);
  if (!status.configured) throw unprocessable("Finish the Slack pilot's server configuration before connecting", { code: "slack_pilot_not_configured" });
  const config = Object.fromEntries(REQUIRED.map((key) => [key, env[`${PREFIX}${key}`]!.trim()])) as SlackBotOAuthConfig;
  if (!/^A[A-Z0-9]+$/.test(config.APP_ID) || !/^T[A-Z0-9]+$/.test(config.TEAM_ID)) {
    throw unprocessable("Configure the exact Slack app ID and workspace ID for this pilot");
  }
  return { ...config, callbackUrl: status.callbackUrl! };
}

export function slackBotOAuthBinding(config: SlackBotOAuthConfig & { callbackUrl: string }) {
  // Pin configuration across a restart without persisting any credentials.
  return createHash("sha256").update(JSON.stringify(REQUIRED.map((key) => config[key])) + config.callbackUrl).digest("hex");
}

export function assertSlackBotOAuthActor(
  state: { createdByActorType: string | null; createdByActorId: string | null; createdBySessionId: string | null },
  actor: { userId: string; sessionId: string },
) {
  if (state.createdByActorType !== "user" || !state.createdBySessionId ||
      state.createdByActorId !== actor.userId || state.createdBySessionId !== actor.sessionId) {
    throw forbidden("Finish connecting Slack in the same signed-in Paperclip browser session that started it");
  }
}

export function slackBotAuthorizationUrl(config: SlackBotOAuthConfig & { callbackUrl: string }, state: string, profile: SlackCeoBotProfile = SLACK_CEO_DM_PROFILE) {
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", config.CLIENT_ID);
  url.searchParams.set("redirect_uri", config.callbackUrl);
  url.searchParams.set("team", config.TEAM_ID);
  url.searchParams.set("scope", slackCeoBotScopes(profile).join(","));
  url.searchParams.set("state", state);
  return url.href;
}

export async function exchangeSlackBotCode(config: SlackBotOAuthConfig & { callbackUrl: string }, code: string, fetchImpl = globalThis.fetch, profile: SlackCeoBotProfile = SLACK_CEO_DM_PROFILE) {
  const response = await fetchImpl("https://slack.com/api/oauth.v2.access", {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: config.CLIENT_ID, client_secret: config.CLIENT_SECRET, code, redirect_uri: config.callbackUrl }),
  });
  // Never reflect provider prose, response bodies, codes, or tokens in errors.
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok || body?.ok !== true) throw unprocessable("Slack could not complete authorization. Try connecting again.", { code: "slack_oauth_exchange_failed" });
  const team = body.team as { id?: unknown } | undefined;
  const user = body.authed_user as { id?: unknown } | undefined;
  if (body.app_id !== config.APP_ID || team?.id !== config.TEAM_ID || body.is_enterprise_install === true) {
    throw forbidden("Slack returned a different app or workspace from the configured pilot");
  }
  if (typeof body.access_token !== "string" || !body.access_token.startsWith("xoxb-") ||
      body.token_type !== "bot" || typeof body.bot_user_id !== "string" ||
      !/^U[A-Z0-9]+$/.test(body.bot_user_id) || typeof user?.id !== "string" || !/^[UW][A-Z0-9]+$/.test(user.id)) {
    throw unprocessable("Slack did not return a verified bot installation and installing user");
  }
  // The channel adapter has no bot-token refresh contract yet. Fail closed;
  // never silently turn off an administrator's token rotation requirement.
  if (body.refresh_token || body.expires_in) throw unprocessable("This pilot does not yet support rotating Slack bot tokens. Keep your workspace policy unchanged.", { code: "slack_bot_rotation_unsupported" });
  const scopes = typeof body.scope === "string" ? body.scope.split(/[ ,]+/).filter(Boolean) : [];
  if (!hasExactSlackCeoScopes(profile, scopes)) {
    throw unprocessable("This pilot needs exactly the DM-only permissions. Use a separate app without previous broader grants.", { code: "slack_bot_scope_profile_mismatch" });
  }
  return { botToken: body.access_token, botUserId: body.bot_user_id, installingUserId: user.id, scopes };
}
