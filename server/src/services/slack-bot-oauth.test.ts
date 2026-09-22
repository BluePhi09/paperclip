import { describe, expect, it, vi } from "vitest";
import { assertSlackBotOAuthActor, exchangeSlackBotCode, slackBotAuthorizationUrl, slackBotOAuthBinding, slackBotOAuthStatus, slackDmPilotRequestAllowed, SLACK_CEO_DM_SCOPES } from "./slack-bot-oauth.js";

const config = { COMPANY_ID: "company", USER_ID: "user", AGENT_ID: "ceo", APP_ID: "ATEST", TEAM_ID: "TTEST", CLIENT_ID: "client", CLIENT_SECRET: "synthetic-secret", SIGNING_SECRET: "synthetic-signing-secret", callbackUrl: "https://pilot.example/api/chat-endpoints/endpoint/slack/oauth/callback" };
const installation = { ok: true, app_id: "ATEST", team: { id: "TTEST" }, authed_user: { id: "UOWNER" }, access_token: "xoxb-synthetic", token_type: "bot", bot_user_id: "UBOT", scope: SLACK_CEO_DM_SCOPES.join(",") };
function exchange(body: unknown, status = 200) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify(body), { status }));
  return { fetch, result: exchangeSlackBotCode(config, "synthetic-code", fetch) };
}

describe("Slack CEO DM OAuth boundary", () => {
  it("is disabled by default and does not expose environment values", () => {
    expect(slackBotOAuthStatus("http://localhost:3210", "id", {})).toMatchObject({ enabled: false, configured: false, callbackUrl: null });
    const env = Object.fromEntries(Object.entries(config).map(([key, value]) => [`PAPERCLIP_SLACK_CEO_POC_${key}`, value]));
    env.PAPERCLIP_SLACK_CEO_POC_ENABLED = "true";
    const status = slackBotOAuthStatus("https://pilot.example", "endpoint", env);
    expect(status).toMatchObject({ configured: true, profile: "ceo-dm-v1", callbackUrl: config.callbackUrl });
    expect(JSON.stringify(status)).not.toContain(config.CLIENT_SECRET);
    expect(slackBotOAuthStatus("https://user:pass@pilot.example", "endpoint", env).configured).toBe(false);
  });
  it("uses only the DM bot profile, an exact callback, and pinned workspace", () => {
    const url = new URL(slackBotAuthorizationUrl(config, "nonce"));
    expect(url.origin + url.pathname).toBe("https://slack.com/oauth/v2/authorize");
    expect(url.searchParams.get("scope")?.split(",")).toEqual([...SLACK_CEO_DM_SCOPES]);
    expect(url.searchParams.get("user_scope")).toBeNull();
    expect(url.searchParams.get("redirect_uri")).toBe(config.callbackUrl);
    expect(url.searchParams.get("team")).toBe("TTEST");
    expect(url.searchParams.get("state")).toBe("nonce");
    expect(url.href).not.toContain(config.CLIENT_SECRET);
    expect(slackBotOAuthBinding(config)).not.toBe(slackBotOAuthBinding({ ...config, TEAM_ID: "TOTHER" }));
  });
  it("requires the initiating signed-in user AND session", () => {
    const state = { createdByActorType: "user", createdByActorId: "user", createdBySessionId: "session" };
    expect(() => assertSlackBotOAuthActor(state, { userId: "user", sessionId: "session" })).not.toThrow();
    for (const actor of [{ userId: "other", sessionId: "session" }, { userId: "user", sessionId: "other" }]) {
      expect(() => assertSlackBotOAuthActor(state, actor)).toThrow(/same signed-in/);
    }
  });
  it("normalizes bot and installer identity; never follows token endpoint redirects", async () => {
    const { fetch, result } = exchange(installation);
    await expect(result).resolves.toMatchObject({ botUserId: "UBOT", installingUserId: "UOWNER", scopes: [...SLACK_CEO_DM_SCOPES] });
    expect(fetch).toHaveBeenCalledWith("https://slack.com/api/oauth.v2.access", expect.objectContaining({ method: "POST", redirect: "error" }));
  });
  it.each([
    { ...installation, app_id: "AOTHER" }, { ...installation, team: { id: "TOTHER" } },
    { ...installation, is_enterprise_install: true }, { ...installation, token_type: "user" },
    { ...installation, access_token: "xoxp-user" }, { ...installation, authed_user: {} },
    { ...installation, scope: "chat:write" }, { ...installation, scope: `${installation.scope},files:read` },
    { ...installation, refresh_token: "synthetic-refresh" }, { ...installation, expires_in: 3600 },
  ])("rejects an incompatible installation %#", async body => {
    await expect(exchange(body).result).rejects.toThrow();
  });
  it("does not reflect provider errors or secrets", async () => {
    await expect(exchange({ ok: false, error: "synthetic-secret synthetic-code xoxb-private" }).result).rejects.toThrow("Slack could not complete authorization. Try connecting again.");
  });
});

describe("Slack CEO DM ingress profile", () => {
  const message = { api_app_id: "ATEST", event: { type: "message", channel: "D123", channel_type: "im", user: "UOWNER" } };
  const allowed = (body: unknown) => slackDmPilotRequestAllowed(JSON.stringify(body), "application/json", "ATEST", "UOWNER");
  it("accepts only the installing person's bot DM", () => {
    expect(allowed(message)).toBe(true);
    expect(allowed({ ...message, api_app_id: "AOTHER" })).toBe(false);
    expect(allowed({ ...message, event: { ...message.event, user: "UOTHER" } })).toBe(false);
    expect(allowed({ ...message, event: { ...message.event, channel: "C123", channel_type: "channel" } })).toBe(false);
    expect(allowed({ ...message, event: { ...message.event, channel_type: "mpim" } })).toBe(false);
    expect(slackDmPilotRequestAllowed("invalid", "application/json", "ATEST", "UOWNER")).toBe(false);
  });
  it("permits signed setup and revocation but no reactions or assistant events", () => {
    expect(allowed({ type: "url_verification" })).toBe(true);
    expect(allowed({ event: { type: "app_uninstalled" } })).toBe(true);
    expect(allowed({ event: { type: "tokens_revoked" } })).toBe(true);
    expect(allowed({ event: { type: "reaction_added", user: "UOWNER" } })).toBe(false);
  });
  it("keeps slash commands and interactive replies in the same private surface", () => {
    expect(slackDmPilotRequestAllowed("channel_id=D123&user_id=UOWNER", "application/x-www-form-urlencoded", "ATEST", "UOWNER")).toBe(true);
    expect(slackDmPilotRequestAllowed("channel_id=C123&user_id=UOWNER", "application/x-www-form-urlencoded", "ATEST", "UOWNER")).toBe(false);
    expect(allowed({ type: "block_actions", user: { id: "UOWNER" }, channel: { id: "D123" } })).toBe(true);
    expect(allowed({ type: "block_actions", user: { id: "UOTHER" }, channel: { id: "D123" } })).toBe(false);
  });
});
