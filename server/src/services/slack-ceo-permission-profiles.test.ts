import { describe, expect, it } from "vitest";
import {
  hasExactSlackCeoScopes, SLACK_CEO_DM_PROFILE, SLACK_CEO_DM_SCOPES,
  SLACK_CEO_THREADED_PROFILE, SLACK_CEO_THREADED_SCOPES,
  SLACK_READ_PROFILE, SLACK_READ_SCOPES,
  SLACK_RESEARCH_PROFILE, SLACK_RESEARCH_SCOPES,
} from "./slack-ceo-permission-profiles.js";
import { slackBotAuthorizationUrl, slackBotOAuthStatus } from "./slack-bot-oauth.js";
import { hasSlackReadRuntimeScopes, isSlackReadProfile } from "./slack-read-profile.js";

describe("Slack CEO versioned permission contracts", () => {
  const profiles = [
    [SLACK_CEO_DM_PROFILE, SLACK_CEO_DM_SCOPES],
    [SLACK_CEO_THREADED_PROFILE, SLACK_CEO_THREADED_SCOPES],
    [SLACK_READ_PROFILE, SLACK_READ_SCOPES],
    [SLACK_RESEARCH_PROFILE, SLACK_RESEARCH_SCOPES],
  ] as const;

  it.each(profiles)("checks the exact scope set for %s", (profile, scopes) => {
    expect(hasExactSlackCeoScopes(profile, scopes)).toBe(true);
    expect(hasExactSlackCeoScopes(profile, [...scopes].reverse())).toBe(true);
    expect(hasExactSlackCeoScopes(profile, [...scopes, scopes[0]])).toBe(true);
    for (const omitted of scopes) {
      expect(hasExactSlackCeoScopes(profile, scopes.filter(scope => scope !== omitted))).toBe(false);
    }
    for (const extra of ["admin", "files:write", "groups:history", "assistant:write"]) {
      expect(hasExactSlackCeoScopes(profile, [...scopes, extra])).toBe(false);
    }
  });

  it("adds only the two separately authorized permissions", () => {
    expect(SLACK_CEO_THREADED_SCOPES).toEqual([...SLACK_CEO_DM_SCOPES, "reactions:write"]);
    expect(SLACK_RESEARCH_SCOPES).toEqual([...SLACK_READ_SCOPES, "files:read"]);
    expect(hasExactSlackCeoScopes(SLACK_CEO_DM_PROFILE, SLACK_CEO_THREADED_SCOPES)).toBe(false);
    expect(hasExactSlackCeoScopes(SLACK_CEO_THREADED_PROFILE, SLACK_CEO_DM_SCOPES)).toBe(false);
    expect(hasExactSlackCeoScopes(SLACK_READ_PROFILE, SLACK_RESEARCH_SCOPES)).toBe(false);
    expect(hasExactSlackCeoScopes(SLACK_RESEARCH_PROFILE, SLACK_READ_SCOPES)).toBe(false);
  });

  it("never treats a bot grant as a personal grant or vice versa", () => {
    expect(hasExactSlackCeoScopes(SLACK_RESEARCH_PROFILE, SLACK_CEO_THREADED_SCOPES)).toBe(false);
    expect(hasExactSlackCeoScopes(SLACK_CEO_THREADED_PROFILE, SLACK_RESEARCH_SCOPES)).toBe(false);
  });

  it.each(["", "unknown", "__proto__", "constructor", "ceo-dm-v3"])("fails closed for profile %s", profile => {
    expect(hasExactSlackCeoScopes(profile, SLACK_CEO_DM_SCOPES)).toBe(false);
  });

  it.each(profiles)("limits implicit identify to personal runtime checks for %s", (profile, scopes) => {
    expect(hasExactSlackCeoScopes(profile, [...scopes, "identify"])).toBe(false);
    expect(hasExactSlackCeoScopes(profile, [...scopes, "identify"], "runtime"))
      .toBe(profile === SLACK_READ_PROFILE || profile === SLACK_RESEARCH_PROFILE);
  });

  it("does not activate or accept v2 through the existing v1 entry points", () => {
    expect(slackBotOAuthStatus("https://pilot.example", "endpoint", {
      PAPERCLIP_SLACK_CEO_POC_ENABLED: "true",
      PAPERCLIP_SLACK_CEO_POC_BOT_PROFILE: SLACK_CEO_THREADED_PROFILE,
    }).profile).toBe(SLACK_CEO_DM_PROFILE);
    const url = new URL(slackBotAuthorizationUrl({
      COMPANY_ID: "company", USER_ID: "user", AGENT_ID: "ceo", APP_ID: "ATEST",
      TEAM_ID: "TTEST", CLIENT_ID: "client", CLIENT_SECRET: "synthetic-secret",
      SIGNING_SECRET: "synthetic-signing", callbackUrl: "https://pilot.example/callback",
    }, "nonce"));
    expect(url.searchParams.get("scope")?.split(",")).toEqual(SLACK_CEO_DM_SCOPES);
    expect(hasSlackReadRuntimeScopes(SLACK_RESEARCH_SCOPES)).toBe(false);
    expect(isSlackReadProfile({ config: { slackReadPilot: { profile: SLACK_RESEARCH_PROFILE } } })).toBe(false);
  });
});
