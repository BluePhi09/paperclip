import { and, eq } from "drizzle-orm";
import { connectionGrants, connectionGrantDelegations, type Db } from "@paperclipai/db";
import { forbidden } from "../errors.js";
import { authorizeSlackReadContext, isSlackReadProfile, object, SLACK_READ_SCOPES, SLACK_READ_MCP_URL, SLACK_READ_AUTH_URL, SLACK_READ_TOKEN_URL } from "./slack-read-profile.js";

export async function assertSlackReadConnection(db: Db, connection: {
  id: string; companyId: string; config?: Record<string, unknown>; credentialPolicy?: string;
}, context: { companyId: string; agentId: string; userId: string; issueId: string }) {
  const authority = await authorizeSlackReadContext(db, context);
  const binding = object(connection.config?.slackReadPilot);
  const oauth = object(connection.config?.oauth);
  if (!isSlackReadProfile(connection) || connection.companyId !== context.companyId ||
      connection.credentialPolicy !== "per_user" || connection.config?.url !== SLACK_READ_MCP_URL ||
      oauth.authorizationUrl !== SLACK_READ_AUTH_URL || oauth.tokenUrl !== SLACK_READ_TOKEN_URL ||
      binding.fingerprint !== authority.binding.fingerprint) {
    throw forbidden("Slack read connection identity or source configuration changed");
  }
  return authority;
}

export async function resolveSlackReadGrant(db: Db, connection: {
  id: string; companyId: string; config?: Record<string, unknown>; credentialPolicy?: string;
}, context: { companyId: string; agentId: string; userId: string; issueId: string }, requireDelegation = false) {
  const authority = await assertSlackReadConnection(db, connection, context);
  const grants = await db.select().from(connectionGrants).where(and(
    eq(connectionGrants.companyId, context.companyId), eq(connectionGrants.connectionId, connection.id),
    eq(connectionGrants.kind, "user"), eq(connectionGrants.subjectUserId, context.userId), eq(connectionGrants.status, "active")));
  const grant = grants.length === 1 ? grants[0] : null;
  // Private provider verification metadata is deliberately not writable through
  // the public grant-input schema.
  const proof = object(object(grant?.providerTenant).slackReadPilot);
  const scopes = object(grant?.providerTenant?.oauth).scopes;
  if (!grant || grant.revokedAt || proof.fingerprint !== authority.binding.fingerprint ||
      proof.userId !== authority.binding.slackUserId || proof.teamId !== authority.binding.teamId ||
      !Array.isArray(scopes) || SLACK_READ_SCOPES.some(scope => !scopes.includes(scope)) ||
      scopes.some(scope => !(SLACK_READ_SCOPES as readonly unknown[]).includes(scope)) ||
      !grant.credentialSecretRefs.some(ref => ref.configPath === "oauth.access_token")) {
    throw forbidden("The linked person needs a verified personal public-channel read grant");
  }
  if (requireDelegation) {
    const [delegation] = await db.select({ id: connectionGrantDelegations.id }).from(connectionGrantDelegations).where(and(
      eq(connectionGrantDelegations.companyId, context.companyId), eq(connectionGrantDelegations.grantId, grant.id),
      eq(connectionGrantDelegations.agentId, context.agentId), eq(connectionGrantDelegations.createdByUserId, context.userId)));
    if (!delegation) throw forbidden("The pilot person's delegation to this CEO is no longer active");
  }
  return grant;
}
