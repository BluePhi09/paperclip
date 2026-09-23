import { describe, expect, it } from "vitest";
import { governedSlackReadArguments, hasSlackReadRuntimeScopes, slackReadConfiguration, validateSlackReadTokenResponse, validateSlackReadToolSchema } from "../services/slack-read-profile.js";
import { readChannelSchema, readThreadSchema } from "./fixtures/slack-read-schemas.js";

const expected = { appId: "ATEST", teamId: "TTEST", slackUserId: "UTEST" };
const token = { ok: true, access_token: "not-a-real-token", token_type: "user", team: { id: "TTEST" }, authed_user: { id: "UTEST", scope: "channels:read,channels:history" } };
const identity = { ok: true, team_id: "TTEST", user_id: "UTEST" };

describe("Slack read pilot boundaries", () => {
  it("accepts Slack's implicit identify header scope, but no extra data permissions", () => {
    const reads = ["channels:history", "channels:read"];
    expect(hasSlackReadRuntimeScopes(reads)).toBe(true);
    expect(hasSlackReadRuntimeScopes(["identify", ...reads])).toBe(true);
    for (const scopes of [[], ["identify"], ["identify", "channels:read"], [...reads, "chat:write"], [...reads, "groups:history"], [...reads, "users:read"], [...reads, "files:read"]]) {
      expect(hasSlackReadRuntimeScopes(scopes)).toBe(false);
    }
  });
  it("is disabled until the exact pilot and source are configured", () => {
    expect(() => slackReadConfiguration({})).toThrow();
    const env = Object.fromEntries(Object.entries({ ENABLED: "true", READ_ENABLED: "true", COMPANY_ID: "company", USER_ID: "person", AGENT_ID: "ceo", TEAM_ID: "TTEST", APP_ID: "ATEST", READ_CHANNEL_ID: "CAPPROVED", CLIENT_ID: "client", CLIENT_SECRET: "secret" }).map(([key, value]) => [`PAPERCLIP_SLACK_CEO_POC_${key}`, value]));
    expect(slackReadConfiguration(env).channelId).toBe("CAPPROVED");
    expect(slackReadConfiguration(env)).not.toHaveProperty("clientSecret");
    expect(() => slackReadConfiguration({ ...env, PAPERCLIP_SLACK_CEO_POC_READ_CHANNEL_ID: "DPRIVATE" })).toThrow();
  });
  it("uses actual personal identity/scope evidence, not requested scope hints", () => {
    expect(validateSlackReadTokenResponse(token, expected, identity)).toEqual({ scopes: ["channels:read", "channels:history"], teamId: "TTEST", userId: "UTEST", appId: "ATEST" });
  });
  it("accepts a standard bearer response only with independently verified Slack identity", () => {
    const bearer = { access_token: "not-a-real-token", token_type: "Bearer", scope: "channels:read channels:history" };
    expect(validateSlackReadTokenResponse(bearer, expected, identity)).toMatchObject({ userId: "UTEST", teamId: "TTEST" });
    expect(() => validateSlackReadTokenResponse(bearer, expected, undefined)).toThrow();
    expect(() => validateSlackReadTokenResponse(bearer, expected, { ...identity, user_id: "UOTHER" })).toThrow();
    expect(() => validateSlackReadTokenResponse(bearer, expected, { ...identity, team_id: "TOTHER" })).toThrow();
  });
  it.each([
    null, {}, { ...identity, ok: false }, { ...identity, bot_id: "BTEST" },
    { ...identity, user_id: "UOTHER" }, { ...identity, team_id: "TOTHER" },
    { ...identity, app_id: "AOTHER" }, { ...identity, is_enterprise_install: true },
  ])("rejects missing or conflicting authenticated identity %j", proof => {
    expect(() => validateSlackReadTokenResponse(token, expected, proof)).toThrow();
  });
  it("reports a safe failure code without reflecting tokens or provider values", () => {
    try {
      validateSlackReadTokenResponse(token, expected, { ...identity, user_id: "provider-untrusted-value" });
      expect.fail("expected identity mismatch");
    } catch (error) {
      expect(error).toMatchObject({ status: 403, details: { code: "slack_read_person_mismatch" } });
      expect(String(error)).not.toContain("provider-untrusted-value");
      expect(String(error)).not.toContain(token.access_token);
    }
  });
  it.each([
    { token_type: "bot" }, { ok: false }, { access_token: "" }, { team: { id: "TOTHER" } },
    { app_id: "AOTHER" }, { is_enterprise_install: true }, { authed_user: { id: "UOTHER", scope: "channels:read,channels:history" } },
    { authed_user: { id: "UTEST", scope: "channels:read" } },
    { authed_user: { id: "UTEST", scope: "channels:read,channels:history,chat:write" } },
    { authed_user: { id: "UTEST" } }, { token_type: "unsupported" },
    { scope: "channels:read,channels:history,chat:write" },
  ])("rejects wrong or widened provider evidence %j", override => {
    expect(() => validateSlackReadTokenResponse({ ...token, ...override }, expected, identity)).toThrow();
  });
  const args = (parameters: unknown, toolName = "slack_read_channel", schema: unknown = readChannelSchema) => governedSlackReadArguments({ toolName, schema, parameters, channelId: "CAPPROVED", nowSeconds: 2_000_000 });
  it("projects a fixed channel and window; repeated governance is stable", () => {
    const projected = args({});
    expect(projected).toEqual({ channel_id: "CAPPROVED", oldest: "1395200.000000", latest: "2000000.000000", limit: 30 });
    expect(args(projected)).toEqual(projected);
  });
  it("guides a clock-mismatched caller to the server window without widening it", () => {
    expect(() => args({ latest: "2000027.72" })).toThrow("Omit oldest/latest");
    expect(args({ limit: 100, response_format: "detailed" })).toMatchObject({ oldest: "1395200.000000", latest: "2000000.000000" });
  });
  it.each([
    { channel_id: "COTHER" }, { query: "in:anywhere" }, { channel: "COTHER" }, { limit: 201 }, { limit: -1 }, { limit: 1.5 },
    { oldest: "1395199" }, { oldest: "2000001" }, { latest: "2000001" }, { oldest: "NaN" }, { oldest: "1999999", latest: "1999998" },
    { cursor: "x".repeat(2049) }, { inclusive: "true" }, { response_format: "everything" }, [], null,
  ])("rejects resource/window/budget argument escape %j", parameters => expect(() => args(parameters)).toThrow());
  it("rejects all writes, search and unreviewed schema variants", () => {
    for (const name of ["slack_send_message", "slack_search_messages", "slack_read_channel_v2"]) expect(() => args({}, name)).toThrow();
    expect(validateSlackReadToolSchema("slack_read_channel", { ...readChannelSchema, required: ["workspace"] })).toBe(false);
    expect(validateSlackReadToolSchema("slack_read_channel", { ...readChannelSchema, properties: {} })).toBe(false);
    expect(validateSlackReadToolSchema("slack_read_channel", { ...readChannelSchema, properties: { ...readChannelSchema.properties, workspace: { type: "string" } } })).toBe(false);
    expect(validateSlackReadToolSchema("slack_read_thread", { ...readThreadSchema, required: ["channel_id"] })).toBe(false);
  });
  it("requires a recent thread root in the same channel", () => {
    const projected = args({ message_ts: "1999999.123", response_format: "concise" }, "slack_read_thread", readThreadSchema);
    expect(projected).toEqual({ message_ts: "1999999.123", response_format: "concise", channel_id: "CAPPROVED", limit: 30, oldest: "1395200.000000", latest: "2000000.000000" });
    expect(args(projected, "slack_read_thread", readThreadSchema)).toEqual(projected);
    for (const parameters of [{ message_ts: "1395199.001" }, { message_ts: "2000001.001" }, { message_ts: "1999999" }, { ts: "1999999.123" }, {}]) {
      expect(() => args(parameters, "slack_read_thread", readThreadSchema)).toThrow();
    }
  });
  it("canonicalizes whole-second bounds for Slack without rounding fractional timestamps", () => {
    expect(args({ oldest: "1395200", latest: "2000000" })).toMatchObject({ oldest: "1395200.000000", latest: "2000000.000000" });
    expect(args({ oldest: "1999999.123456", latest: "1999999.999999" })).toMatchObject({ oldest: "1999999.123456", latest: "1999999.999999" });
  });
});
