import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, agentWakeupRequests, chatActions, chatConversations, chatDeliveries, chatEndpoints,
  chatExternalPrincipals, chatIdentityLinks, chatMessageLinks, chatPublications, companies,
  companyMemberships, createDb, heartbeatRuns, issueComments, issueThreadInteractions, issues,
  toolApplications, toolConnections,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { slackBoardRepliesService, slackBoardReplyBinding, authorizeSlackBoardReplyWake, authorizeSlackSharedRequestPublication } from "../services/slack-board-replies.js";
import { assertDurableChatWakeupRequest } from "../services/durable-chat-wakeup.js";
import type { IssueAssignmentWakeupDeps } from "../services/issue-assignment-wakeup.js";
import { issueService } from "../services/issues.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("explicit board-to-Slack answer", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-slack-board-");
    db = createDb(database.connectionString);
  }, 90000);
  afterAll(async () => { await db?.$client.end({ timeout: 0 }); await database?.cleanup(); });

  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), endpointId = randomUUID();
    const conversationId = randomUUID(), userId = randomUUID(), principalId = randomUUID(), connectionId = randomUUID(), applicationId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Pilot", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "CEO", role: "ceo", adapterType: "codex_local" });
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "owner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "DM", status: "in_review", originKind: "chat_channel", assigneeAgentId: agentId });
    await db.insert(toolApplications).values({ id: applicationId, companyId, name: "Slack", type: "native" });
    await db.insert(toolConnections).values({ id: connectionId, applicationId, companyId, name: "Slack", uid: connectionId, transport: "chat_sdk", connectionPurpose: "channel", enabled: true, status: "active" });
    await db.insert(chatEndpoints).values({ id: endpointId, companyId, connectionId, provider: "slack", publicId: endpointId,
      assignedAgentId: agentId, sponsorUserId: userId, status: "active", providerAccountId: "TTEST", botExternalId: `U${endpointId}`,
      setup: { step: "complete", slackPermissionProfile: "ceo-dm-v1" } as any });
    await db.insert(chatConversations).values({ id: conversationId, companyId, endpointId, issueId, externalConversationId: "DTEST", externalThreadId: "dm", externalLabel: "Pilot DM", isDirectMessage: true, state: "waiting" });
    await db.insert(chatExternalPrincipals).values({ id: principalId, companyId, provider: "slack", providerAccountId: "TTEST", externalId: "UTEST" });
    await db.insert(chatIdentityLinks).values({ companyId, endpointId, principalId, paperclipUserId: userId, status: "linked", confirmedAt: new Date() });
    await db.insert(chatDeliveries).values({ companyId, endpointId, conversationId, principalId, providerEventId: "real-event", deduplicationKey: "real-event", eventKind: "message", state: "processed", normalizedEvent: {} });
    const wakeup: IssueAssignmentWakeupDeps["wakeup"] = async (targetAgentId, opts) => {
      const request = opts.durableChatRequest!;
      assertDurableChatWakeupRequest(request, { companyId, agentId: targetAgentId, issueId, commentId: String(opts.contextSnapshot?.wakeCommentId), requestedByActorType: opts.requestedByActorType, requestedByActorId: opts.requestedByActorId });
      await request.authorize(db);
      const runId = randomUUID();
      const inserted = await db.insert(agentWakeupRequests).values({ id: request.id, companyId, agentId, source: "assignment",
        payload: opts.payload, status: "claimed", runId, requestedByActorType: "user", requestedByActorId: userId, idempotencyKey: request.idempotencyKey }).onConflictDoNothing().returning();
      if (inserted.length) await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "legacy", wakeupRequestId: request.id, contextSnapshot: opts.contextSnapshot });
      return null;
    };
    const heartbeat = { wakeup: vi.fn(wakeup) };
    const scope = { companyId, endpointId, conversationId, userId };
    return { ...scope, scope, agentId, issueId, principalId, connectionId, heartbeat, service: slackBoardRepliesService(db, heartbeat) };
  }

  it("uses one durable receipt for simultaneous duplicate requests; never fabricates Slack inbound proof", async () => {
    const f = await fixture(), key = randomUUID();
    const [first, second] = await Promise.all([f.service.request(f.scope, "Reply hello", key), f.service.request(f.scope, "Reply hello", key)]);
    expect(first).toEqual(second);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId))).toHaveLength(1);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(1);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
    expect(await db.select().from(chatDeliveries).where(eq(chatDeliveries.companyId, f.companyId))).toHaveLength(1);
    expect(await db.select().from(chatMessageLinks).where(eq(chatMessageLinks.companyId, f.companyId))).toHaveLength(0);
    await expect(f.service.request(f.scope, "Changed text", key)).rejects.toMatchObject({ status: 409 });
  });

  it("starts a fresh turn from an active conversation explicitly reopened into review", async () => {
    const f = await fixture();
    await db.update(chatConversations).set({ state: "active" }).where(eq(chatConversations.id, f.conversationId));
    await f.service.request(f.scope, "Continue the read-only conversation", randomUUID());
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(issue.status).toBe("todo");
    expect(f.heartbeat.wakeup).toHaveBeenCalledOnce();
  });

  it("recovers a committed request after interruption without a new comment or admission identity", async () => {
    const f = await fixture();
    const unavailable = slackBoardRepliesService(db, { wakeup: async () => { throw new Error("interrupted"); } });
    const result = await unavailable.request(f.scope, "Reply hello", randomUUID());
    expect(result.status).toBe("queued");
    await f.service.processPending();
    await f.service.processPending();
    expect((await db.select().from(chatActions).where(eq(chatActions.id, result.requestId)))[0].status).toBe("submitted");
    expect(f.heartbeat.wakeup).toHaveBeenCalledOnce();
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId))).toHaveLength(1);
  });

  it("publishes only the selected answer, not its request or intermediate notes; finalization is idempotent", async () => {
    const f = await fixture();
    await f.service.request(f.scope, "Reply hello", randomUUID());
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId));
    expect(await slackBoardReplyBinding(db, f.companyId, f.issueId, run.id)).toEqual({ companyId: f.companyId, endpointId: f.endpointId, conversationId: f.conversationId });
    const actor = { agentId: f.agentId, runId: run.id };
    await issueService(db).addComment(f.issueId, "Internal progress", actor, { authorizationReason: "allow_agent_comment" });
    expect(await db.select().from(chatPublications).where(eq(chatPublications.companyId, f.companyId))).toHaveLength(0);
    const answer = await issueService(db).addComment(f.issueId, "Hello", actor, { authorizationReason: "allow_chat_run_presentation" });
    await issueService(db).addComment(f.issueId, "Hello", actor, { authorizationReason: "allow_chat_run_presentation" });
    const publications = await db.select().from(chatPublications).where(eq(chatPublications.companyId, f.companyId));
    expect(publications).toHaveLength(1);
    expect(publications[0].commentId).toBe(answer.id);
    expect(publications[0].payload.text).toBe("Hello");
  });

  it.each(["other company", "other user", "viewer", "unlinked", "wrong DM", "disabled connection", "blocked task", "pending approval"])("rejects %s without creating work", async (boundary) => {
    const f = await fixture();
    const scope = { ...f.scope };
    if (boundary === "other company") scope.companyId = randomUUID();
    if (boundary === "other user") scope.userId = randomUUID();
    if (boundary === "viewer") await db.update(companyMemberships).set({ membershipRole: "viewer" }).where(eq(companyMemberships.companyId, f.companyId));
    if (boundary === "unlinked") await db.update(chatIdentityLinks).set({ status: "revoked" }).where(eq(chatIdentityLinks.endpointId, f.endpointId));
    if (boundary === "wrong DM") await db.delete(chatDeliveries).where(eq(chatDeliveries.endpointId, f.endpointId));
    if (boundary === "disabled connection") await db.update(toolConnections).set({ enabled: false }).where(eq(toolConnections.id, f.connectionId));
    if (boundary === "blocked task") await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, f.issueId));
    if (boundary === "pending approval") await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issueId, kind: "request_confirmation", payload: { version: 1, prompt: "Approve?" } });
    await expect(f.service.request(scope, "Reply hello", randomUUID())).rejects.toMatchObject({ status: expect.any(Number) });
    expect(f.heartbeat.wakeup).not.toHaveBeenCalled();
    expect(await db.select().from(chatActions).where(eq(chatActions.companyId, f.companyId))).toHaveLength(0);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId))).toHaveLength(0);
  });

  it.each(["identity", "destination", "session", "disabled", "forged run"])("revalidates %s after admission", async (boundary) => {
    const f = await fixture();
    await f.service.request(f.scope, "Reply hello", randomUUID());
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId));
    if (boundary === "identity") await db.update(chatIdentityLinks).set({ status: "revoked" }).where(eq(chatIdentityLinks.endpointId, f.endpointId));
    if (boundary === "destination") await db.update(chatConversations).set({ externalConversationId: "DOTHER" }).where(eq(chatConversations.id, f.conversationId));
    if (boundary === "session") await db.update(chatConversations).set({ sessionGeneration: 2 }).where(eq(chatConversations.id, f.conversationId));
    if (boundary === "disabled") await db.update(toolConnections).set({ enabled: false }).where(eq(toolConnections.id, f.connectionId));
    if (boundary === "forged run") await db.update(heartbeatRuns).set({ wakeupRequestId: null }).where(eq(heartbeatRuns.id, run.id));
    expect(await slackBoardReplyBinding(db, f.companyId, f.issueId, run.id)).toBeNull();
  });

  it("rejects source hints without a real durable request", async () => {
    const f = await fixture();
    await expect(authorizeSlackBoardReplyWake(db, { companyId: f.companyId, agentId: f.agentId, issueId: f.issueId,
      wakeupRequestId: null, contextSnapshot: { source: "slack.board_reply" } })).rejects.toMatchObject({ status: 403 });
  });

  async function threadBinding(f: Awaited<ReturnType<typeof fixture>>) {
    await db.update(chatConversations).set({ bindingMode: "slack_dm_thread_v2", externalThreadId: "slack:DTEST:9000.000001",
      originPrincipalId: f.principalId, originUserId: f.userId }).where(eq(chatConversations.id, f.conversationId));
  }

  it("retains an exact threaded binding through board submission and rejects later root changes", async () => {
    const f = await fixture();
    await threadBinding(f);
    await f.service.request(f.scope, "Answer in this thread", randomUUID());
    expect(f.heartbeat.wakeup).not.toHaveBeenCalled();
    await db.update(chatPublications).set({ state: "published", providerMessageId: "9001.000001" }).where(eq(chatPublications.companyId, f.companyId));
    await f.service.processPending();
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId));
    expect(await slackBoardReplyBinding(db, f.companyId, f.issueId, run.id)).toMatchObject({ conversationId: f.conversationId });
    await db.update(chatConversations).set({ externalThreadId: "slack:DTEST:9000.000002" }).where(eq(chatConversations.id, f.conversationId));
    expect(await slackBoardReplyBinding(db, f.companyId, f.issueId, run.id)).toBeNull();
  });

  it("atomically saves a shared request once, waits for delivery, then resumes once after reconstruction", async () => {
    const f = await fixture(), key = randomUUID();
    await threadBinding(f);
    const first = await f.service.request(f.scope, "Shared from Paperclip", key);
    const second = await f.service.request(f.scope, "Shared from Paperclip", key);
    expect(first).toEqual(second);
    const [publication] = await db.select().from(chatPublications).where(eq(chatPublications.companyId, f.companyId));
    expect(publication.payload.text).toBe("From Paperclip (you):\n\nShared from Paperclip");
    expect(publication.commentId).toBe(first.commentId);
    expect(await authorizeSlackSharedRequestPublication(db, publication)).toBe(true);
    expect(await authorizeSlackSharedRequestPublication(db, { ...publication, payload: { text: "Modified later" } })).toBe(false);
    expect(f.heartbeat.wakeup).not.toHaveBeenCalled();
    const restarted = slackBoardRepliesService(db, f.heartbeat);
    for (const state of ["pending", "retry", "delivery_unknown", "failed"] as const) {
      await db.update(chatPublications).set({ state }).where(eq(chatPublications.id, publication.id));
      await restarted.processPending();
      expect(f.heartbeat.wakeup).not.toHaveBeenCalled();
    }
    await db.update(chatPublications).set({ state: "published", providerMessageId: "9001.000001" }).where(eq(chatPublications.id, publication.id));
    await restarted.processPending();
    await restarted.processPending();
    expect(f.heartbeat.wakeup).toHaveBeenCalledOnce();
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId))).toHaveLength(1);
    expect(await db.select().from(chatPublications).where(eq(chatPublications.companyId, f.companyId))).toHaveLength(1);
    expect(await db.select().from(chatDeliveries).where(eq(chatDeliveries.companyId, f.companyId))).toHaveLength(1);
  });

  it("revocation before a shared send blocks both the request publication and the CEO wake", async () => {
    const f = await fixture();
    await threadBinding(f);
    await f.service.request(f.scope, "Do not send after revocation", randomUUID());
    const [publication] = await db.select().from(chatPublications).where(eq(chatPublications.companyId, f.companyId));
    await db.update(chatIdentityLinks).set({ status: "revoked" }).where(eq(chatIdentityLinks.endpointId, f.endpointId));
    expect(await authorizeSlackSharedRequestPublication(db, publication)).toBe(false);
    await f.service.processPending();
    expect(f.heartbeat.wakeup).not.toHaveBeenCalled();
    expect((await db.select().from(chatActions).where(eq(chatActions.companyId, f.companyId)))[0].status).toBe("failed");
  });

  it("editing the saved request does not silently replace the text authorized for Slack", async () => {
    const f = await fixture();
    await threadBinding(f);
    const result = await f.service.request(f.scope, "Original shared request", randomUUID());
    await db.update(issueComments).set({ body: "Private replacement" }).where(eq(issueComments.id, result.commentId));
    const [publication] = await db.select().from(chatPublications).where(eq(chatPublications.companyId, f.companyId));
    expect(await authorizeSlackSharedRequestPublication(db, publication)).toBe(false);
    await f.service.processPending();
    expect(f.heartbeat.wakeup).not.toHaveBeenCalled();
  });

  it("does not authorize a threaded task merely from an existing linked identity and inbound receipt", async () => {
    const f = await fixture();
    await threadBinding(f);
    await db.update(chatConversations).set({ originUserId: "another-user" }).where(eq(chatConversations.id, f.conversationId));
    await expect(f.service.request(f.scope, "Do not start", randomUUID())).rejects.toMatchObject({ status: 403 });
    expect(f.heartbeat.wakeup).not.toHaveBeenCalled();
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId))).toHaveLength(0);
  });

  it("enforces thread shape, channel and tenant constraints in the database", async () => {
    const f = await fixture(), other = await fixture();
    await threadBinding(f);
    for (const change of [{ externalThreadId: "slack:DOTHER:9000.000001" }, { sessionGeneration: 2 },
      { originPrincipalId: null }, { originPrincipalId: other.principalId }, { bindingMode: "unknown" as never }]) {
      await expect(db.update(chatConversations).set(change).where(eq(chatConversations.id, f.conversationId))).rejects.toThrow();
    }
  });
});
