/** Permission contracts, not feature switches. Threaded bot v2 requires the
 * explicit, identity-bound upgrade transaction before runtime activation.
 * Never infer a profile from the scopes in a token: bind the requested profile
 * first, then verify that the granted scopes match it exactly. */
export const SLACK_CEO_DM_PROFILE = "ceo-dm-v1" as const;
export const SLACK_CEO_THREADED_PROFILE = "ceo-dm-threaded-v2" as const;
export const SLACK_READ_PROFILE = "slack-public-read-v1" as const;
export const SLACK_RESEARCH_PROFILE = "slack-public-research-v2" as const;

export const SLACK_CEO_DM_SCOPES = Object.freeze([
  "chat:write", "commands", "im:history", "im:read", "users:read",
] as const);
export const SLACK_CEO_THREADED_SCOPES = Object.freeze([
  ...SLACK_CEO_DM_SCOPES, "reactions:write",
] as const);
export const SLACK_READ_SCOPES = Object.freeze([
  "channels:history", "channels:read",
] as const);
export const SLACK_RESEARCH_SCOPES = Object.freeze([
  ...SLACK_READ_SCOPES, "files:read",
] as const);

const PROFILES = Object.freeze({
  [SLACK_CEO_DM_PROFILE]: { purpose: "bot", scopes: SLACK_CEO_DM_SCOPES },
  [SLACK_CEO_THREADED_PROFILE]: { purpose: "bot", scopes: SLACK_CEO_THREADED_SCOPES },
  [SLACK_READ_PROFILE]: { purpose: "personal_read", scopes: SLACK_READ_SCOPES },
  [SLACK_RESEARCH_PROFILE]: { purpose: "personal_read", scopes: SLACK_RESEARCH_SCOPES },
} as const);

export type SlackCeoPermissionProfile = keyof typeof PROFILES;
export type SlackCeoBotProfile = typeof SLACK_CEO_DM_PROFILE | typeof SLACK_CEO_THREADED_PROFILE;

export function isSlackCeoBotProfile(profile: unknown): profile is SlackCeoBotProfile {
  return profile === SLACK_CEO_DM_PROFILE || profile === SLACK_CEO_THREADED_PROFILE;
}

export function slackCeoBotScopes(profile: SlackCeoBotProfile) {
  if (!isSlackCeoBotProfile(profile)) throw new Error("Unknown Slack bot permission profile");
  return PROFILES[profile].scopes;
}

/** The implicit identity-only scope is accepted only from a runtime identity
 * check on a personal grant, not as an extra requested/returned OAuth scope. */
export function hasExactSlackCeoScopes(
  profile: string,
  scopes: readonly string[],
  source: "oauth" | "runtime" = "oauth",
): boolean {
  if (!Object.hasOwn(PROFILES, profile)) return false;
  const expected = PROFILES[profile as SlackCeoPermissionProfile];
  const granted = new Set(scopes);
  return expected.scopes.every(scope => granted.has(scope)) &&
    [...granted].every(scope =>
      (expected.scopes as readonly string[]).includes(scope) ||
      (source === "runtime" && expected.purpose === "personal_read" && scope === "identify"));
}
