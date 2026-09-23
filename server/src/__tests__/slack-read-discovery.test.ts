import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, chatActions, chatConversations, chatDeliveries, chatEndpoints, chatExternalPrincipals, chatIdentityLinks,
  chatMessageLinks, chatPublications, companies, companyMemberships, connectionGrants, createDb, heartbeatRuns, issueComments,
  issueThreadInteractions, issues, toolApplications, toolConnections } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { authorizeSlackReadContext, SLACK_READ_AUTH_URL, SLACK_READ_MCP_URL, SLACK_READ_TOKEN_URL } from "../services/slack-read-profile.js";
import { resolveSlackReadGrant } from "../services/slack-read-access.js";
import { reserveSlackReadBudget } from "../services/slack-read-budget.js";
import { connectionIntentService } from "../services/connection-intents.js";
import { connectionIntentDeliveryService, wakeConnectionIntentAfterResolution } from "../services/connection-intent-delivery.js";
import { authorizeSlackReadContinuation, authorizeSlackReadIntent } from "../services/slack-read-intents.js";
import { issueService } from "../services/issues.js";
import { toolAccessService } from "../services/tool-access.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import type { RuntimeToolsTokenClaims } from "../runtime-tools-token.js";
import { readChannelSchema, readThreadSchema } from "./fixtures/slack-read-schemas.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("Slack read discovery persistence", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("paperclip-slack-read-"); db = createDb(database.connectionString); }, 90000);
  afterAll(async () => { vi.unstubAllEnvs(); await db?.$client.end({ timeout: 0 }); await database?.cleanup(); });
  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), endpointId = randomUUID(), conversationId = randomUUID();
    const userId = randomUUID(), principalId = randomUUID(), connectionId = randomUUID(), applicationId = randomUUID(), runId = randomUUID(), commentId = randomUUID();
    for (const [key, value] of Object.entries({ ENABLED: "true", READ_ENABLED: "true", COMPANY_ID: companyId, USER_ID: userId, AGENT_ID: agentId, TEAM_ID: "TTEST", APP_ID: "ATEST", READ_CHANNEL_ID: "CAPPROVED", CLIENT_ID: "client", CLIENT_SECRET: "test-secret" })) vi.stubEnv(`PAPERCLIP_SLACK_CEO_POC_${key}`, value);
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", "https://pilot.example.test");
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "0".repeat(64));
    await db.insert(companies).values({ id: companyId, name: "Pilot", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "CEO", role: "ceo", adapterType: "codex_local" });
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "owner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Papercuts", status: "in_progress", originKind: "chat_channel", assigneeAgentId: agentId });
    await db.insert(toolApplications).values({ id: applicationId, companyId, name: "Slack", type: "mcp_http", metadata: { sourceTemplateKey: "slack" } });
    await db.insert(toolConnections).values({ id: connectionId, applicationId, companyId, name: "Slack DM", uid: connectionId, transport: "chat_sdk", connectionPurpose: "channel", enabled: true, status: "active" });
    await db.insert(chatEndpoints).values({ id: endpointId, companyId, connectionId, provider: "slack", publicId: endpointId, assignedAgentId: agentId, sponsorUserId: userId, status: "active", providerAccountId: "TTEST", botExternalId: `U${endpointId}`, setup: { step: "complete", slackPermissionProfile: "ceo-dm-v1" } as any });
    await db.insert(chatConversations).values({ id: conversationId, companyId, endpointId, issueId, externalConversationId: "DTEST", externalThreadId: "dm", externalLabel: "Pilot DM", isDirectMessage: true, state: "active" });
    await db.insert(chatExternalPrincipals).values({ id: principalId, companyId, provider: "slack", providerAccountId: "TTEST", externalId: "UTEST" });
    await db.insert(chatIdentityLinks).values({ companyId, endpointId, principalId, paperclipUserId: userId, status: "linked", confirmedAt: new Date() });
    await db.insert(chatDeliveries).values({ companyId, endpointId, conversationId, principalId, providerEventId: "event", deduplicationKey: "event", eventKind: "message", state: "processed", normalizedEvent: {} });
    await db.insert(issueComments).values({ id: commentId, companyId, issueId, authorType: "user", authorUserId: userId, body: "Review papercuts; suggest only." });
    await db.insert(chatMessageLinks).values({ companyId, endpointId, conversationId, issueId, commentId, direction: "inbound", providerMessageId: "100.1" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "legacy", responsibleUserId: userId, contextSnapshot: { issueId, source: "chat:slack", wakeCommentId: commentId, wakeCommentIds: [commentId] } });
    const claims: RuntimeToolsTokenClaims = { sub: agentId, company_id: companyId, run_id: runId, responsible_user_id: userId, scope: "connection_intents", iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+3600 };
    const context = { companyId, userId, agentId, issueId };
    const authority = await authorizeSlackReadContext(db, context);
    const readConnectionId = randomUUID();
    const config = { url: SLACK_READ_MCP_URL, slackReadPilot: authority.binding, oauth: { authorizationUrl: SLACK_READ_AUTH_URL, tokenUrl: SLACK_READ_TOKEN_URL } };
    const [readConnection] = await db.insert(toolConnections).values({ id: readConnectionId, companyId, applicationId, name: "Personal reads", uid: readConnectionId, transport: "mcp_remote", authKind: "oauth", credentialPolicy: "per_user", config, transportConfig: config }).returning();
    return { ...context, endpointId, conversationId, runId, commentId, authority, claims, readConnection, service: connectionIntentService(db) };
  }
  it("creates one real consent card for duplicate calls; neither bot access nor generic Slack readiness satisfies it", async () => {
    const f = await fixture();
    const [first, duplicate] = await Promise.all([f.service.ensureCapability(f.claims, { capability: "slack.read_channel" }), f.service.ensureCapability(f.claims, { capability: "slack.read_thread" })]);
    expect(first.status).toBe("AUTH_REQUIRED"); expect(duplicate.status).toBe("AUTH_REQUIRED");
    const intents = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.companyId, f.companyId));
    expect(intents).toHaveLength(1); expect(intents[0].originCommentIds).toEqual([f.commentId]);
    const publications = await db.select().from(chatPublications).where(eq(chatPublications.companyId, f.companyId));
    expect(publications).toHaveLength(1); expect(JSON.stringify(publications[0].payload)).toContain("Connect Slack");
    const actions = publications[0].payload.card!.actions as { type: string; url: string }[];
    expect(actions[0].url).toMatch(new RegExp(`/connect-slack-read/${intents[0].id}$`));
    expect(actions[1].url).not.toBe(actions[0].url);
    expect((await f.service.ensureCapability(f.claims, { capability: "slack.search_messages" })).status).toBe("UNAVAILABLE");
    await f.service.decline(intents[0].id, f.userId);
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, interactionId: intents[0].id } }).where(eq(heartbeatRuns.id, f.runId));
    expect((await f.service.ensureCapability(f.claims, { capability: "slack.read_channel" })).status).toBe("UNAVAILABLE");
  });
  it("starts fresh consent after removal without duplicating the retained application or reviving credentials", async () => {
    const f = await fixture();
    const access = toolAccessService(db);
    const actor = { actorType: "user" as const, actorId: f.userId, sessionId: "fixture-session", actorSource: "session" as const };
    const app = await access.createApplication(f.companyId, { name: "Slack public-channel read pilot", type: "mcp_http", ownerUserId: f.userId, metadata: { sourceTemplateKey: "slack" } });
    await db.update(toolConnections).set({ applicationId: app.id }).where(eq(toolConnections.id, f.readConnection.id));
    await access.archiveConnection(f.readConnection.id, f.companyId, actor);
    const requested = await f.service.ensureCapability(f.claims, { capability: "slack.read_channel" });
    expect(requested.status).toBe("AUTH_REQUIRED");
    if (requested.status !== "AUTH_REQUIRED") throw new Error("Expected consent");
    const result = await f.service.startSlackRead(requested.interactionId!, actor, "https://pilot.example.test/api/tools/oauth/callback");
    expect(result.status).toBe("AUTH_REQUIRED");
    const applications = await access.listApplications(f.companyId);
    expect(applications.filter(item => item.name === app.name)).toHaveLength(1);
    const connections = await access.listConnections(f.companyId);
    const replacement = connections.find(item => item.applicationId === app.id && item.status !== "archived")!;
    expect(replacement.id).not.toBe(f.readConnection.id);
    expect(replacement.enabled).toBe(false);
    expect(replacement.credentialSecretRefs).toEqual([]);
    expect(connections.find(item => item.id === f.readConnection.id)).toMatchObject({ status: "archived", enabled: false });
    expect(connections.find(item => item.transport === "chat_sdk")).toMatchObject({ status: "active", enabled: true });
    const grants = await db.select().from(connectionGrants).where(eq(connectionGrants.connectionId, replacement.id));
    expect(grants.every(grant => grant.credentialSecretRefs.length === 0 && !grant.providerTenant?.slackReadPilot)).toBe(true);
    await expect(resolveSlackReadGrant(db, replacement, f)).rejects.toMatchObject({ status: 403 });
    expect((await access.listApplications(f.companyId)).find(item => item.id === app.id)).toMatchObject({ status: "active", archivedAt: null });
    expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, requested.interactionId!)))[0].status).toBe("pending");
  });
  it("never adopts a retained pilot application belonging to another person", async () => {
    const f = await fixture();
    const access = toolAccessService(db);
    const actor = { actorType: "user" as const, actorId: f.userId, sessionId: "fixture-session", actorSource: "session" as const };
    await access.createApplication(f.companyId, { name: "Slack public-channel read pilot", type: "mcp_http", ownerUserId: randomUUID(), metadata: { sourceTemplateKey: "slack" } });
    await access.archiveConnection(f.readConnection.id, f.companyId, actor);
    const requested = await f.service.ensureCapability(f.claims, { capability: "slack.read_channel" });
    if (requested.status !== "AUTH_REQUIRED") throw new Error("Expected consent");
    await expect(f.service.startSlackRead(requested.interactionId!, actor, "https://pilot.example.test/api/tools/oauth/callback")).rejects.toMatchObject({ status: 409 });
  });
  it("never externalizes a private Paperclip request", async () => {
    const f = await fixture();
    await db.delete(chatMessageLinks).where(eq(chatMessageLinks.commentId, f.commentId));
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, source: "issue.comment", wakeCommentId: f.commentId } }).where(eq(heartbeatRuns.id, f.runId));
    expect((await f.service.ensureCapability(f.claims, { capability: "slack.read_channel" })).status).toBe("AUTH_REQUIRED");
    expect(await db.select().from(chatPublications).where(eq(chatPublications.companyId, f.companyId))).toHaveLength(0);
  });
  it("routes an older agent's generic Slack request through the same narrow pilot consent", async () => {
    const f = await fixture();
    const requested = await f.service.request(f.claims, "slack");
    const [intent] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, requested.interactionId!));
    expect(intent.payload).toMatchObject({ capabilityProfile: "slack-public-read-v1", sourceChannelId: "CAPPROVED" });
    expect(await f.service.ensureCapability(f.claims, { capability: "slack.read_channel" })).toMatchObject({ status: "AUTH_REQUIRED", interactionId: intent.id });
    expect(await db.select().from(chatPublications).where(eq(chatPublications.companyId, f.companyId))).toHaveLength(1);
  });
  it.each([
    { ok: true, team_id: "TTEST", user_id: "UOTHER" },
    { ok: true, team_id: "TOTHER", user_id: "UTEST" },
    { ok: true, team_id: "TTEST", user_id: "UTEST", bot_id: "BTEST" },
    { ok: false, error: "invalid_auth" },
  ])("rejects a token's authenticated identity before persistence or channel access: %j", async identity => {
    const f = await fixture();
    await f.service.ensureCapability(f.claims, { capability: "slack.read_channel" });
    const [intent] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.companyId, f.companyId));
    const remote = vi.fn(async (url: string) => {
      if (url === SLACK_READ_TOKEN_URL) return Response.json({ access_token: "fixture-personal-access", token_type: "Bearer", scope: "channels:read channels:history" });
      if (url === "https://slack.com/api/auth.test") return Response.json(identity);
      throw new Error("No catalog or channel request is permitted before identity verification");
    });
    const access = toolAccessService(db, { remoteHttpRequest: remote, remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }] });
    const actor = { actorType: "user" as const, actorId: f.userId, sessionId: "fixture-session", actorSource: "session" as const };
    const redirectUri = "https://pilot.example.test/api/tools/oauth/callback";
    const started = await access.startOAuth(f.companyId, f.readConnection.id, { actor, subjectUserId: f.userId, issueId: f.issueId, interactionId: intent.id, scopes: ["channels:history", "channels:read"], redirectUri });
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    await expect(access.completeOAuthCallback({ state, code: "fixture-code", actor, redirectUri })).rejects.toMatchObject({ status: 403 });
    expect(remote.mock.calls.map(([url]) => url)).toEqual([SLACK_READ_TOKEN_URL, "https://slack.com/api/auth.test"]);
    const grants = await db.select().from(connectionGrants).where(eq(connectionGrants.connectionId, f.readConnection.id));
    expect(grants.every(grant => grant.credentialSecretRefs.length === 0 && !grant.providerTenant.slackReadPilot)).toBe(true);
    expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, intent.id)))[0].status).toBe("pending");
  });
  it.each(["nested-user", "rfc-bearer"])("binds %s OAuth to the browser session, recovers a saved token, and resumes accepted access without another prompt", async format => {
    const f = await fixture();
    await f.service.ensureCapability(f.claims, { capability: "slack.read_channel" });
    const [intent] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.companyId, f.companyId));
    let failCatalog = true;
    const remote = vi.fn(async (url: string, init: RequestInit) => {
      if (url === "https://slack.com/api/auth.test") {
        expect(new Headers(init.headers).get("authorization")).toBe("Bearer fixture-personal-access");
        return Response.json({ ok: true, team_id: "TTEST", user_id: "UTEST" }, { headers: { "x-oauth-scopes": format === "rfc-bearer" ? "identify,channels:history,channels:read" : "channels:history,channels:read" } });
      }
      if (url === SLACK_READ_TOKEN_URL) {
        expect((init.body as URLSearchParams).has("code_verifier")).toBe(false);
        return Response.json(format === "rfc-bearer"
          ? { access_token: "fixture-personal-access", token_type: "Bearer", scope: "channels:read channels:history" }
          : { ok: true, access_token: "fixture-personal-access", token_type: "user", team: { id: "TTEST" }, authed_user: { id: "UTEST", scope: "channels:read,channels:history" } });
      }
      if (url.startsWith("https://slack.com/api/conversations.info?")) return Response.json({ ok: true, channel: { id: "CAPPROVED", is_private: false } });
      if (url === SLACK_READ_MCP_URL) {
        if (failCatalog) throw new Error("simulated catalog outage after grant persistence");
        expect(new Headers(init.headers).get("authorization")).toBe("Bearer fixture-personal-access");
        const request = JSON.parse(String(init.body));
        if (request.method === "tools/call") {
          expect(["slack_read_channel", "slack_read_thread"]).toContain(request.params.name);
          expect(request.params.arguments.channel_id).toBe("CAPPROVED");
          expect(request.params.arguments.oldest).toBeDefined();
          expect(request.params.arguments.latest).toBeDefined();
          if (request.params.name === "slack_read_thread") {
            expect(request.params.arguments.message_ts).toMatch(/^\d+\.\d+$/);
            expect(request.params.arguments.ts).toBeUndefined();
          }
          return Response.json({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "Approved-channel fixture result" }] } });
        }
        return Response.json({ jsonrpc: "2.0", id: "paperclip-catalog-refresh", result: { tools: [
          { name: "slack_read_channel", inputSchema: readChannelSchema, annotations: { readOnlyHint: true } },
          { name: "slack_read_thread", inputSchema: readThreadSchema, annotations: { readOnlyHint: true } },
          { name: "slack_send_message", inputSchema: readChannelSchema, annotations: { readOnlyHint: false } },
        ] } });
      }
      throw new Error(`Unexpected fixture request: ${url}`);
    });
    const access = toolAccessService(db, { remoteHttpRequest: remote, remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }] });
    const actor = { actorType: "user" as const, actorId: f.userId, sessionId: "fixture-session", actorSource: "session" as const };
    const redirectUri = "https://pilot.example.test/api/tools/oauth/callback";
    const started = await access.startOAuth(f.companyId, f.readConnection.id, { actor, subjectUserId: f.userId, issueId: f.issueId, interactionId: intent.id, scopes: ["channels:history", "channels:read"], redirectUri });
    const url = new URL(started.authorizationUrl);
    expect(url.pathname).toBe("/oauth/v2_user/authorize"); expect(url.searchParams.has("code_challenge")).toBe(false);
    expect(url.searchParams.get("team")).toBe("TTEST");
    const callback = { state: url.searchParams.get("state")!, code: "fixture-code", actor, redirectUri };
    await expect(access.completeOAuthCallback({ ...callback, actor: { ...actor, sessionId: "other-session" } })).rejects.toMatchObject({ status: 403 });
    expect(remote).not.toHaveBeenCalled();
    await expect(access.completeOAuthCallback(callback)).rejects.toThrow("simulated catalog outage");
    await expect(resolveSlackReadGrant(db, f.readConnection, f)).resolves.toMatchObject({ subjectUserId: f.userId });
    await expect(access.completeOAuthCallback(callback)).rejects.toMatchObject({ status: 400 });
    failCatalog = false;
    await access.reconcileSlackReadOAuth(f.companyId, f.readConnection.id, intent.id, actor);
    await f.service.complete(intent.id, f.readConnection.id, f.userId);
    const ready = await f.service.ensureCapability(f.claims, { capability: "slack.read_channel" });
    expect(ready.status).toBe("CONNECTED");
    expect("instruction" in ready && ready.instruction).toContain("Omit oldest/latest");
    expect(await db.select().from(chatActions).where(and(eq(chatActions.companyId, f.companyId), eq(chatActions.kind, "interaction_wakeup")))).toHaveLength(0);
    const effective = await access.getEffectiveProfilesForAgent(f.companyId, f.agentId);
    expect(effective.allowedTools.filter(tool => tool.connectionId === f.readConnection.id).map(tool => tool.toolName).sort()).toEqual(["slack_read_channel", "slack_read_thread"]);
    const gateway = createToolGatewayService(db, { remoteHttpRequest: remote, remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }] });
    const session = await gateway.createSession({ companyId: f.companyId, agentId: f.agentId, issueId: f.issueId, runId: f.runId });
    const visible = await gateway.listToolsForSession(session.token);
    expect(visible.some(tool => tool.upstreamToolName === "slack_send_message")).toBe(false);
    const read = visible.find(tool => tool.upstreamToolName === "slack_read_channel")!;
    expect(read).toBeDefined();
    await expect(gateway.executeTool({ sessionToken: session.token, tool: read.name, parameters: { channel_id: "COTHER" } })).rejects.toMatchObject({ status: 403 });
    const executed = await gateway.executeTool({ sessionToken: session.token, tool: read.name, parameters: { channel_id: "CAPPROVED", limit: 20 } });
    expect(JSON.stringify(executed)).toContain("Approved-channel fixture result");
    const thread = visible.find(tool => tool.upstreamToolName === "slack_read_thread")!;
    const threadResult = await gateway.executeTool({ sessionToken: session.token, tool: thread.name,
      parameters: { channel_id: "CAPPROVED", message_ts: `${Math.floor(Date.now() / 1000) - 60}.123`, limit: 20, response_format: "detailed" } });
    expect(JSON.stringify(threadResult)).toContain("Approved-channel fixture result");
    const wakeup = vi.fn(async (agentId: string, opts: any) => {
      await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId, source: "automation", status: "queued", requestedByActorType: "user", requestedByActorId: f.userId, idempotencyKey: opts.idempotencyKey });
      return null;
    });
    await connectionIntentDeliveryService(db, { wakeup } as any).tryDeliver(intent.id);
    await connectionIntentDeliveryService(db, { wakeup } as any).sweepPending();
    expect(wakeup).toHaveBeenCalledOnce();
    const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
    const continuation = { companyId: f.companyId, agentId: f.agentId, issueId: f.issueId,
      wakeupRequestId: receipt.id, contextSnapshot: wakeup.mock.calls[0][1].contextSnapshot };
    expect((await authorizeSlackReadContinuation(db, continuation))?.intent.id).toBe(intent.id);
    await db.update(connectionGrants).set({ status: "revoked", revokedAt: new Date() }).where(eq(connectionGrants.connectionId, f.readConnection.id));
    await expect(authorizeSlackReadContinuation(db, continuation)).rejects.toMatchObject({ status: 403 });
    expect(remote.mock.calls.filter(([url]) => url === SLACK_READ_TOKEN_URL)).toHaveLength(1);
  });
  it("rejects organization fallback, unverified personal grants, excess scopes, changed identity, and cross-tenant calls", async () => {
    const f = await fixture();
    const proof = { ...f.authority.binding, userId: "UTEST" };
    const providerTenant = { oauth: { scopes: ["channels:read", "channels:history"] }, slackReadPilot: proof };
    const refs = [{ secretId: randomUUID(), configPath: "oauth.access_token", headerName: "Authorization", prefix: "Bearer " }];
    await db.insert(connectionGrants).values({ companyId: f.companyId, connectionId: f.readConnection.id, kind: "organization", status: "active", providerTenant, credentialSecretRefs: refs });
    await expect(resolveSlackReadGrant(db, f.readConnection, f)).rejects.toMatchObject({ status: 403 });
    const [grant] = await db.insert(connectionGrants).values({ companyId: f.companyId, connectionId: f.readConnection.id, kind: "user", subjectUserId: f.userId, status: "active", providerTenant, credentialSecretRefs: refs }).returning();
    expect((await resolveSlackReadGrant(db, f.readConnection, f)).id).toBe(grant.id);
    await expect(resolveSlackReadGrant(db, f.readConnection, { ...f, companyId: randomUUID() })).rejects.toMatchObject({ status: 403 });
    await db.update(connectionGrants).set({ providerTenant: { ...providerTenant, oauth: { scopes: ["channels:read", "channels:history", "chat:write"] } } }).where(eq(connectionGrants.id, grant.id));
    await expect(resolveSlackReadGrant(db, f.readConnection, f)).rejects.toMatchObject({ status: 403 });
    await db.update(connectionGrants).set({ providerTenant }).where(eq(connectionGrants.id, grant.id));
    await db.update(chatIdentityLinks).set({ status: "revoked" }).where(eq(chatIdentityLinks.endpointId, f.endpointId));
    await expect(resolveSlackReadGrant(db, f.readConnection, f)).rejects.toMatchObject({ status: 403 });
  });
  it("preserves bounded scan reservations across retries and rejects concurrent over-budget reads", async () => {
    const f = await fixture();
    const input = { ...f, generation: f.authority.conversation.sessionGeneration, invocationId: randomUUID(), toolName: "slack_read_channel", limit: 100 };
    await reserveSlackReadBudget(db, input); await reserveSlackReadBudget(db, input);
    const results = await Promise.allSettled([reserveSlackReadBudget(db, { ...input, invocationId: randomUUID() }), reserveSlackReadBudget(db, { ...input, invocationId: randomUUID() })]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(await db.select().from(chatActions).where(eq(chatActions.companyId, f.companyId))).toHaveLength(2);
  });
  it("resumes a resolved request once after worker restart and rejects a forged or stale continuation", async () => {
    const f = await fixture();
    await f.service.ensureCapability(f.claims, { capability: "slack.read_channel" });
    const [intent] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.companyId, f.companyId));
    await f.service.decline(intent.id, f.userId);
    // Even a provider-visible consent card must use only the connection-intent
    // delivery worker, never the generic chat interaction wake lane.
    expect(await db.select().from(chatActions).where(and(eq(chatActions.companyId, f.companyId), eq(chatActions.kind, "interaction_wakeup")))).toHaveLength(0);
    let savedContext: Record<string, unknown> = {}, wakeId = "", runId = "";
    const wakeup = vi.fn(async (agentId: string, opts: any) => {
      savedContext = opts.contextSnapshot; wakeId = randomUUID(); runId = randomUUID();
      await db.insert(agentWakeupRequests).values({ id: wakeId, companyId: f.companyId, agentId, source: "automation", status: "claimed", runId, requestedByActorType: "user", requestedByActorId: f.userId, idempotencyKey: opts.idempotencyKey });
      await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId, status: "running", runtimeMode: "legacy", wakeupRequestId: wakeId, contextSnapshot: opts.contextSnapshot });
      throw new Error("worker crashed after enqueue");
    });
    await connectionIntentDeliveryService(db, { wakeup } as any).tryDeliver(intent.id);
    await connectionIntentDeliveryService(db, { wakeup } as any).tryDeliver(intent.id);
    expect(wakeup).toHaveBeenCalledOnce();
    const execution = { companyId: f.companyId, agentId: f.agentId, issueId: f.issueId, wakeupRequestId: wakeId, contextSnapshot: savedContext, runId };
    expect((await authorizeSlackReadContinuation(db, execution))?.intent.id).toBe(intent.id);
    await expect(authorizeSlackReadContinuation(db, { ...execution, wakeupRequestId: randomUUID() })).rejects.toMatchObject({ status: 403 });
    await issueService(db).addComment(f.issueId, "No channel content was read.", { agentId: f.agentId, runId }, { authorizationReason: "allow_chat_run_presentation" });
    expect((await db.select().from(chatPublications).where(and(eq(chatPublications.companyId, f.companyId), eq(chatPublications.state, "pending")))).some(row => row.payload.text === "No channel content was read.")).toBe(true);
    await db.update(chatConversations).set({ sessionGeneration: 2 }).where(eq(chatConversations.id, f.conversationId));
    await expect(authorizeSlackReadIntent(db, intent.id, f.companyId)).rejects.toMatchObject({ status: 403 });
  });
});
