import { and, eq } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, issueThreadInteractions, toolConnections, type Db } from "@paperclipai/db";
import { forbidden, HttpError } from "../errors.js";
import { authorizeSlackReadContext, object, SLACK_READ_PROFILE } from "./slack-read-profile.js";
import { resolveSlackReadGrant } from "./slack-read-access.js";

export const SLACK_READ_CONTINUATION_SOURCE = "slack.read.continued";

/** An intent belongs to one linked person, source channel, and DM generation.
 * The personal grant can outlive a conversation; its suspended request cannot. */
export async function authorizeSlackReadIntent(db: Db, interactionId: string, companyId: string) {
  const [intent] = await db.select().from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.id, interactionId), eq(issueThreadInteractions.companyId, companyId)));
  const payload = object(intent?.payload);
  if (!intent || intent.kind !== "connection_intent" || payload.capabilityProfile !== SLACK_READ_PROFILE ||
      !intent.addresseeUserId || !intent.sourceRunId || typeof payload.requestingAgentId !== "string") {
    throw forbidden("This is not an addressed Slack read request");
  }
  const authority = await authorizeSlackReadContext(db, { companyId, issueId: intent.issueId,
    userId: intent.addresseeUserId, agentId: payload.requestingAgentId });
  if (payload.authorityFingerprint !== authority.binding.fingerprint ||
      payload.conversationFingerprint !== authority.conversationFingerprint ||
      payload.sourceChannelId !== authority.binding.channelId) throw forbidden("Slack read request authority changed");
  return { intent, authority };
}

export async function authorizeSlackReadContinuation(db: Db, input: {
  companyId: string; agentId: string; issueId: string | null; wakeupRequestId: string | null;
  contextSnapshot: Record<string, unknown>; runId?: string;
}) {
  if (input.contextSnapshot.source !== SLACK_READ_CONTINUATION_SOURCE) return null;
  const context = input.contextSnapshot;
  if (typeof context.interactionId !== "string" || !input.wakeupRequestId) throw forbidden("Missing Slack read continuation receipt");
  const current = await authorizeSlackReadIntent(db, context.interactionId, input.companyId);
  const { intent } = current;
  const [receipt] = await db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.id, input.wakeupRequestId), eq(agentWakeupRequests.companyId, input.companyId)));
  if (!["accepted", "rejected"].includes(intent.status) || intent.issueId !== input.issueId ||
      object(intent.payload).requestingAgentId !== input.agentId || context.interactionStatus !== intent.status ||
      !receipt || receipt.agentId !== input.agentId || receipt.requestedByActorType !== "user" ||
      receipt.requestedByActorId !== intent.addresseeUserId ||
      receipt.idempotencyKey !== `connection-intent:${intent.id}:${intent.status}` ||
      (input.runId && receipt.runId !== input.runId) ||
      ["skipped", "failed", "cancelled"].includes(receipt.status) ||
      JSON.stringify(context.wakeCommentIds) !== JSON.stringify(intent.originCommentIds)) {
    throw forbidden("Slack read continuation does not match its durable request");
  }
  if (intent.status === "accepted") {
    const connectionId = object(intent.result).connectionId;
    const [connection] = typeof connectionId === "string" ? await db.select().from(toolConnections).where(and(
      eq(toolConnections.id, connectionId), eq(toolConnections.companyId, input.companyId))) : [];
    if (!connection?.enabled || connection.status !== "active" || connection.healthStatus !== "ok") {
      throw forbidden("The accepted Slack read connection is no longer available");
    }
    await resolveSlackReadGrant(db, connection, { companyId: input.companyId, agentId: input.agentId,
      issueId: intent.issueId, userId: intent.addresseeUserId! }, true);
  }
  return current;
}

/** Return the source turn's actual audience, never every conversation attached
 * to a task. In particular an ordinary private board turn stays private. */
export async function slackReadContinuationBinding(db: Db, companyId: string, issueId: string, runId: string) {
  const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId)));
  if (run?.contextSnapshot?.source !== SLACK_READ_CONTINUATION_SOURCE) return { handled: false as const, bindings: [] };
  try {
    const current = await authorizeSlackReadContinuation(db, { companyId, issueId, agentId: run.agentId,
      wakeupRequestId: run.wakeupRequestId, contextSnapshot: run.contextSnapshot, runId });
    if (!current) return { handled: true as const, bindings: [] };
    // A fresh human turn must own a new capability request; never build an
    // unbounded chain of authorization continuations.
    const [source] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, current.intent.sourceRunId!), eq(heartbeatRuns.companyId, companyId)));
    if (!source || source.contextSnapshot?.source === SLACK_READ_CONTINUATION_SOURCE) return { handled: true as const, bindings: [] };
    const { resolveChatOriginPublicationBindings } = await import("./issues.js");
    const bindings = await resolveChatOriginPublicationBindings(db, companyId, issueId, source.id);
    return { handled: true as const, bindings: bindings.filter(binding =>
      binding.endpointId === current.authority.endpoint.id && binding.conversationId === current.authority.conversation.id) };
  } catch (error) {
    if (error instanceof HttpError) return { handled: true as const, bindings: [] };
    throw error;
  }
}
