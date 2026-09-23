import { randomUUID } from "node:crypto";
import { and, eq, ne, sql } from "drizzle-orm";
import {
  agents, agentWakeupRequests, chatActions, chatConversations, chatEndpoints,
  chatIdentityLinks, chatExternalPrincipals, companyMemberships, heartbeatRuns,
  issueComments, issues, toolConnections, chatPublications, type Db,
} from "@paperclipai/db";
import { conflict, forbidden, HttpError, notFound } from "../errors.js";
import { issueService } from "./issues.js";
import { logActivity } from "./activity-log.js";
import { createDurableChatWakeupRequest, assertDurableChatWakeupReceipt } from "./durable-chat-wakeup.js";
import type { IssueAssignmentWakeupDeps } from "./issue-assignment-wakeup.js";
import { isAutomaticRecoverySuppressedByPauseHold } from "./recovery/pause-hold-guard.js";
import { slackDmBindingOwnedBy } from "./chat-slack-dm-threads.js";
import { isSlackCeoBotProfile } from "./slack-ceo-permission-profiles.js";
import { projectSafeChatPublication } from "./chat-publication-projection.js";
import { splitNativePublicationText } from "./chat-publication-text-parts.js";

const KIND = "slack_board_reply";
const SHARED_REQUEST_PREFIX = "slack-shared-request:";
export const SLACK_BOARD_REPLY_SOURCE = "slack.board_reply";
type Action = typeof chatActions.$inferSelect;
type Scope = { companyId: string; endpointId: string; conversationId: string; userId: string };

/** Current, company-scoped authority for the pilot person's existing bot DM.
 * This does not turn a board comment into a fabricated Slack inbound event. */
export async function authorizeSlackPilotConversation(db: Db, scope: Scope, receipt?: Action) {
  const [row] = await db.select({ endpoint: chatEndpoints, conversation: chatConversations, issue: issues })
    .from(chatEndpoints)
    .innerJoin(chatConversations, and(eq(chatConversations.endpointId, chatEndpoints.id), eq(chatConversations.companyId, chatEndpoints.companyId)))
    .innerJoin(issues, and(eq(issues.id, chatConversations.issueId), eq(issues.companyId, chatConversations.companyId)))
    .where(and(eq(chatEndpoints.companyId, scope.companyId), eq(chatEndpoints.id, scope.endpointId), eq(chatConversations.id, scope.conversationId))).limit(1);
  if (!row) throw notFound("Slack conversation not found");
  const { endpoint, conversation, issue } = row;
  const [connection] = await db.select({ enabled: toolConnections.enabled, status: toolConnections.status })
    .from(toolConnections).where(and(eq(toolConnections.id, endpoint.connectionId), eq(toolConnections.companyId, scope.companyId)));
  if (await isAutomaticRecoverySuppressedByPauseHold(db, scope.companyId, issue.id)) throw forbidden("This task is paused");
  if (!connection?.enabled || connection.status !== "active" || endpoint.provider !== "slack" || endpoint.status !== "active" || !endpoint.allowDirectMessages ||
      !isSlackCeoBotProfile((endpoint.setup as { slackPermissionProfile?: string }).slackPermissionProfile) ||
      endpoint.sponsorUserId !== scope.userId || !conversation.isDirectMessage ||
      !["active", "waiting"].includes(conversation.state) || issue.originKind !== "chat_channel" ||
      issue.assigneeAgentId !== endpoint.assignedAgentId || issue.hiddenAt || issue.assigneeUserId) {
    throw forbidden("Reply via Slack is only available for your active pilot DM");
  }
  const [identity] = await db.select({ link: chatIdentityLinks, principal: chatExternalPrincipals })
    .from(chatIdentityLinks)
    .innerJoin(chatExternalPrincipals, and(eq(chatExternalPrincipals.id, chatIdentityLinks.principalId), eq(chatExternalPrincipals.companyId, chatIdentityLinks.companyId)))
    .innerJoin(companyMemberships, and(eq(companyMemberships.companyId, chatIdentityLinks.companyId), eq(companyMemberships.principalId, scope.userId), eq(companyMemberships.principalType, "user")))
    .where(and(eq(chatIdentityLinks.companyId, scope.companyId), eq(chatIdentityLinks.endpointId, endpoint.id),
      eq(chatIdentityLinks.paperclipUserId, scope.userId), eq(chatIdentityLinks.status, "linked"),
      eq(companyMemberships.status, "active"), ne(companyMemberships.membershipRole, "viewer"),
      eq(chatExternalPrincipals.providerAccountId, endpoint.providerAccountId ?? ""),
      sql`exists (select 1 from chat_deliveries d where d.company_id = ${scope.companyId}
        and d.endpoint_id = ${endpoint.id} and d.conversation_id = ${conversation.id}
        and d.principal_id = ${chatExternalPrincipals.id} and d.state = 'processed')`)).limit(1);
  if (!identity || identity.principal.isBot || identity.principal.provider !== "slack" || identity.link.revokedAt) throw forbidden("Your linked Slack identity no longer owns this DM");
  if (!slackDmBindingOwnedBy(conversation, { ...scope, principalId: identity.principal.id })) throw forbidden("Your linked Slack identity does not own this thread");
  const fence = JSON.stringify([endpoint.connectionId, endpoint.providerAccountId, endpoint.botExternalId,
    endpoint.assignedAgentId, conversation.externalConversationId, conversation.externalThreadId,
    conversation.sessionGeneration, identity.link.id, identity.link.confirmedAt?.toISOString(),
    ...(conversation.bindingMode === "legacy" ? [] : [conversation.bindingMode, conversation.originPrincipalId, conversation.originUserId])]);
  if (receipt && (receipt.kind !== KIND || receipt.payload.fence !== fence ||
      receipt.payload.issueId !== issue.id || receipt.payload.agentId !== endpoint.assignedAgentId ||
      receipt.principalId !== identity.principal.id)) throw forbidden("Slack reply authorization changed; submit a new request");
  return { ...row, identity, fence };
}

const authorize = authorizeSlackPilotConversation;

function scopeFor(action: Action): Scope {
  if (!action.conversationId || typeof action.payload.userId !== "string") throw forbidden("Invalid Slack reply request");
  return { companyId: action.companyId, endpointId: action.endpointId, conversationId: action.conversationId, userId: action.payload.userId };
}

async function authorizeAction(db: Db, action: Action) {
  const current = await authorize(db, scopeFor(action), action);
  const shared = current.conversation.bindingMode === "slack_dm_thread_v2";
  if (shared !== (action.payload.audience === "shared_thread") ||
      (shared && typeof action.payload.requestPublicationId !== "string")) throw forbidden("Slack request sharing mode changed");
  const [comment] = await db.select().from(issueComments).where(and(
    eq(issueComments.id, String(action.payload.commentId)), eq(issueComments.companyId, action.companyId),
    eq(issueComments.issueId, current.issue.id), eq(issueComments.authorUserId, String(action.payload.userId)),
  )).limit(1);
  if (!comment || comment.deletedAt || comment.authorType !== "user" || comment.body !== action.payload.body) throw forbidden("Slack reply request was removed or changed");
  return current;
}

/** Shared requests use the same durable publication worker as answers. Check
 * the saved request's person/destination again at every provider send, including
 * any transport fragments. Never infer authority from the outbox key alone. */
export async function authorizeSlackSharedRequestPublication(db: Db, publication: typeof chatPublications.$inferSelect): Promise<boolean | null> {
  if (!publication.idempotencyKey.startsWith(SHARED_REQUEST_PREFIX)) return null;
  const match = /^slack-shared-request:([0-9a-f-]{36})(?::slack-part:([1-9][0-9]*))?$/.exec(publication.idempotencyKey);
  if (!match) return false;
  const [action] = await db.select().from(chatActions).where(and(eq(chatActions.companyId, publication.companyId), eq(chatActions.id, match[1]))).limit(1);
  if (!action || action.kind !== KIND || !["queued", "submitted"].includes(action.status) || action.payload.audience !== "shared_thread" ||
      action.endpointId !== publication.endpointId || action.conversationId !== publication.conversationId ||
      action.payload.issueId !== publication.issueId || action.payload.commentId !== publication.commentId ||
      publication.payload.attachmentIds?.length || publication.payload.interactionId || publication.payload.card || publication.payload.progressState) return false;
  const part = publication.payload.transportPart;
  if (match[2] ? part?.batchId !== action.payload.requestPublicationId || part?.index !== Number(match[2])
    : publication.id !== action.payload.requestPublicationId) return false;
  const safeText = projectSafeChatPublication({ classification: "external", source: "explicit_board_send", text: `From Paperclip (you):\n\n${action.payload.body}` }).text;
  const expectedParts = splitNativePublicationText("slack", safeText);
  const index = match[2] ? Number(match[2]) : 0;
  if (part) {
    const expected = expectedParts[index];
    if (!expected || part.index !== index || part.batchId !== action.payload.requestPublicationId || part.count !== expectedParts.length ||
        part.mode !== "inline" || part.prefix !== expected.prefix || part.suffix !== expected.suffix || publication.payload.text !== expected.text) return false;
  } else if (index !== 0 || publication.payload.text !== safeText) return false;
  try {
    await authorizeAction(db, action);
    return true;
  } catch (error) {
    if (error instanceof HttpError && error.status < 500) return false;
    throw error;
  }
}

async function sharedRequestDelivered(db: Db, action: Action): Promise<boolean> {
  if (action.payload.audience !== "shared_thread") return true;
  const rows = await db.select().from(chatPublications).where(and(
    eq(chatPublications.companyId, action.companyId), eq(chatPublications.endpointId, action.endpointId),
    eq(chatPublications.conversationId, action.conversationId!), eq(chatPublications.commentId, String(action.payload.commentId)),
  ));
  const root = rows.find(row => row.id === action.payload.requestPublicationId && row.idempotencyKey === `${SHARED_REQUEST_PREFIX}${action.id}`);
  if (!root) return false;
  const count = root.payload.transportPart?.count ?? 1;
  const batch = rows.filter(row => row.id === root.id || row.payload.transportPart?.batchId === root.id);
  if (batch.length !== count || new Set(batch.map(row => row.payload.transportPart?.index ?? 0)).size !== count) return false;
  for (const row of batch) {
    if (row.state !== "published" || !row.providerMessageId || !(await authorizeSlackSharedRequestPublication(db, row))) return false;
  }
  return true;
}

/** Called at run execution, not just at browser submission. A serialized source
 * or guessed action ID is never sufficient authority. */
export async function authorizeSlackBoardReplyWake(db: Db, input: {
  companyId: string; agentId: string; issueId: string | null; wakeupRequestId: string | null;
  contextSnapshot: Record<string, unknown>;
}) {
  const [action] = input.wakeupRequestId ? await db.select().from(chatActions)
    .where(and(eq(chatActions.id, input.wakeupRequestId), eq(chatActions.companyId, input.companyId))).limit(1) : [];
  if (action?.kind !== KIND) {
    if (input.contextSnapshot.source === SLACK_BOARD_REPLY_SOURCE) throw forbidden("Slack reply request has no durable authorization");
    return null;
  }
  const context = input.contextSnapshot;
  const commentId = action.payload.commentId;
  if (action.payload.agentId !== input.agentId || action.payload.issueId !== input.issueId ||
      context.source !== SLACK_BOARD_REPLY_SOURCE || context.wakeCommentId !== commentId ||
      (Array.isArray(context.wakeCommentIds) && context.wakeCommentIds.some(id => id !== commentId)) ||
      (context.commentId && context.commentId !== commentId) || !["queued", "submitted"].includes(action.status)) {
    throw forbidden("Slack reply request does not match this run");
  }
  await authorizeAction(db, action);
  if (!(await sharedRequestDelivered(db, action))) throw forbidden("Slack has not confirmed the shared request yet");
  return action;
}

/** Exact opt-in run -> comment -> durable request -> current DM authority. */
export async function slackBoardReplyBinding(db: Db, companyId: string, issueId: string, runId: string) {
  const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId))).limit(1);
  if (!run || run.contextSnapshot?.source !== SLACK_BOARD_REPLY_SOURCE) return null;
  try {
    const action = await authorizeSlackBoardReplyWake(db, { companyId, issueId, agentId: run.agentId,
      wakeupRequestId: run.wakeupRequestId, contextSnapshot: run.contextSnapshot });
    const [receipt] = action ? await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.id, action.id), eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.runId, run.id),
      eq(agentWakeupRequests.requestedByActorId, String(action.payload.userId)), eq(agentWakeupRequests.requestedByActorType, "user"),
    )).limit(1) : [];
    if (!action || !receipt) return null;
    return { companyId, endpointId: action.endpointId, conversationId: action.conversationId! };
  } catch (error) {
    if (error instanceof HttpError) return null;
    throw error;
  }
}

export function slackBoardRepliesService(db: Db, heartbeat: IssueAssignmentWakeupDeps) {
  async function processPending(limit = 25) {
    const actions = await db.select().from(chatActions).where(and(eq(chatActions.kind, KIND), eq(chatActions.status, "queued")))
      .orderBy(chatActions.createdAt).limit(limit);
    for (const action of actions) {
      try {
        const current = await authorizeAction(db, action);
        // A pending/uncertain/failed provider send never means the request was
        // delivered. Keep this same receipt queued for transport recovery.
        if (!(await sharedRequestDelivered(db, action))) continue;
        const request = createDurableChatWakeupRequest({ id: action.id, companyId: action.companyId,
          agentId: current.endpoint.assignedAgentId, issueId: current.issue.id, commentId: String(action.payload.commentId),
          requestedByActorType: "user", requestedByActorId: String(action.payload.userId), requestedAt: action.createdAt,
          authorize: async tx => {
            await authorizeAction(tx, action);
            if (!(await sharedRequestDelivered(tx, action))) throw forbidden("Slack has not confirmed the shared request yet");
          },
        });
        await heartbeat.wakeup(request.agentId, { source: "assignment", triggerDetail: "system", reason: "Reply via Slack requested",
          requestedByActorType: "user", requestedByActorId: request.requestedByActorId, durableChatRequest: request,
          allowRunCoalescing: false, payload: { issueId: request.issueId, wakeCommentId: request.commentId },
          contextSnapshot: { source: SLACK_BOARD_REPLY_SOURCE, issueId: request.issueId, wakeCommentId: request.commentId,
            wakeCommentIds: [request.commentId], taskKey: current.issue.identifier ?? current.issue.id },
        });
        const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, action.id)).limit(1);
        if (!receipt) continue; // A restart retries this same durable identity.
        assertDurableChatWakeupReceipt(request, receipt);
        const failed = ["skipped", "failed", "cancelled"].includes(receipt.status);
        await db.update(chatActions).set({ status: failed ? "failed" : "submitted", result: { runId: receipt.runId, code: failed ? "agent_unavailable" : "queued" }, updatedAt: new Date() })
          .where(and(eq(chatActions.id, action.id), eq(chatActions.status, "queued")));
      } catch (error) {
        if (!(error instanceof HttpError) || error.status >= 500) continue;
        await db.update(chatActions).set({ status: "failed", result: { code: "authorization_changed" }, updatedAt: new Date() })
          .where(and(eq(chatActions.id, action.id), eq(chatActions.status, "queued")));
      }
    }
  }

  async function request(scope: Scope, body: string, clientRequestId: string) {
    const action = await db.transaction(async tx => {
      // Same endpoint -> task lock order as chat admission and settlement.
      await tx.select({ id: chatEndpoints.id }).from(chatEndpoints)
        .where(and(eq(chatEndpoints.id, scope.endpointId), eq(chatEndpoints.companyId, scope.companyId))).for("update");
      const current = await authorize(tx as unknown as Db, scope);
      await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, current.issue.id)).for("update");
      const key = `board-reply:${scope.conversationId}:${scope.userId}:${clientRequestId}`;
      const [existing] = await tx.select().from(chatActions).where(and(eq(chatActions.endpointId, scope.endpointId), eq(chatActions.providerActionId, key))).limit(1);
      if (existing) {
        if (existing.payload.body !== body) throw conflict("This request ID already belongs to a different message");
        return existing;
      }
      const [issue] = await tx.select().from(issues).where(eq(issues.id, current.issue.id));
      const [agent] = await tx.select().from(agents).where(and(eq(agents.id, current.endpoint.assignedAgentId), eq(agents.companyId, scope.companyId)));
      if (!agent || ["paused", "terminated"].includes(agent.status) || !["todo", "in_review", "in_progress"].includes(issue.status) ||
          issue.executionRunId || issue.executionState || issue.monitorNextCheckAt) {
        throw conflict("Resolve the task's pause, blocker, or approval before requesting a Slack reply");
      }
      const [busy] = await tx.execute<{ busy: boolean }>(sql`select
        exists (select 1 from heartbeat_runs r where r.company_id = ${scope.companyId}
          and coalesce(r.context_snapshot->>'issueId', r.context_snapshot->>'taskId', r.native_issue_id::text) = ${issue.id}
          and r.status in ('queued','running','scheduled_retry'))
        or exists (select 1 from chat_actions a where a.company_id = ${scope.companyId} and a.kind = ${KIND}
          and a.payload->>'issueId' = ${issue.id} and a.status = 'queued')
        or exists (select 1 from agent_wakeup_requests w where w.company_id = ${scope.companyId}
          and coalesce(w.payload->>'issueId', w.payload->>'taskId', w.payload->'_paperclipWakeContext'->>'issueId') = ${issue.id}
          and w.status in ('queued','claimed','deferred_issue_execution'))
        or exists (select 1 from agent_task_sessions s where s.company_id = ${scope.companyId}
          and s.task_key = ${issue.id} and s.goal_status is not null and s.goal_status <> 'complete')
        or exists (select 1 from issue_relations e join issues blocker on blocker.id = e.issue_id and blocker.company_id = e.company_id
          where e.company_id = ${scope.companyId} and e.related_issue_id = ${issue.id} and e.type = 'blocks' and blocker.status <> 'done')
        or exists (select 1 from issue_thread_interactions i where i.company_id = ${scope.companyId} and i.issue_id = ${issue.id} and i.status = 'pending')
        or exists (select 1 from issue_approvals ia join approvals a on a.id = ia.approval_id and a.company_id = ia.company_id
          where ia.company_id = ${scope.companyId} and ia.issue_id = ${issue.id} and a.status in ('pending','revision_requested'))
        as busy`);
      if (busy?.busy) throw conflict("Wait for the current task turn or approval before requesting a Slack reply");
      const comment = await issueService(tx as unknown as Db).addComment(issue.id, body, { userId: scope.userId }, { authorType: "user" }, tx);
      // A new explicit reply authorizes a new turn, even when the operator
      // reopened a completed conversation into review. Do not leave that turn
      // in review (which triggers generic review-path recovery after answering).
      // All pending approvals, blockers and review execution state were checked
      // above; an unrelated status edit alone must not be auto-settled to idle.
      if (issue.status === "in_review") {
        await issueService(tx as unknown as Db).update(issue.id, {
          status: "todo", actorUserId: scope.userId, companyGuard: scope.companyId,
        }, tx);
      }
      const shared = current.conversation.bindingMode === "slack_dm_thread_v2";
      const requestId = randomUUID(), requestPublicationId = shared ? randomUUID() : null;
      const [created] = await tx.insert(chatActions).values({ id: requestId, companyId: scope.companyId,
        endpointId: scope.endpointId, conversationId: scope.conversationId, principalId: current.identity.principal.id,
        kind: KIND, providerActionId: key, status: "queued", payload: { version: 1, userId: scope.userId,
          issueId: issue.id, agentId: current.endpoint.assignedAgentId, commentId: comment.id, fence: current.fence, body,
          ...(shared ? { audience: "shared_thread", requestPublicationId } : {}) },
      }).returning();
      if (requestPublicationId) await tx.insert(chatPublications).values({
        id: requestPublicationId, companyId: scope.companyId, endpointId: scope.endpointId, conversationId: scope.conversationId,
        issueId: issue.id, commentId: comment.id, idempotencyKey: `${SHARED_REQUEST_PREFIX}${requestId}`, state: "pending",
        payload: projectSafeChatPublication({ classification: "external", source: "explicit_board_send", text: `From Paperclip (you):\n\n${body}` }),
      });
      await logActivity(tx as unknown as Db, { companyId: scope.companyId, actorType: "user", actorId: scope.userId,
        action: "chat.board_reply_requested", entityType: "issue", entityId: issue.id, issueId: issue.id,
        details: { endpointId: scope.endpointId, conversationId: scope.conversationId, commentId: comment.id, requestId: created.id } });
      return created;
    });
    await processPending();
    const [saved] = await db.select().from(chatActions).where(eq(chatActions.id, action.id));
    return { requestId: saved.id, commentId: String(saved.payload.commentId), status: saved.status };
  }
  return { request, processPending };
}
