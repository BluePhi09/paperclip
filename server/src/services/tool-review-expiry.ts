import { and, asc, eq, gt, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import { approvals, toolActionRequests, toolInvocations, type Db } from "@paperclipai/db";
import { logActivity } from "./activity-log.js";
import { writeToolReviewChange } from "./tool-review-work-notifications.js";
import { TOOL_APPROVAL_CONNECTION_REQUIRED } from "./tool-approval-connection.js";

// A destructive tool call carries a formal request_board_approval next to its
// confirmation card. Once the gateway expires or cancels the action request,
// that approval can never authorize anything, so cancel it in the same
// transaction instead of leaving it pending in the Board queue. Mirrors the
// card-side cleanup in issue-thread-interactions (resolveLinkedToolActionRequests).
export async function cancelFormalApprovalForResolvedToolAction(
  tx: Pick<Db, "select" | "update" | "insert">,
  input: {
    companyId: string;
    actionRequestId: string;
    status: "expired" | "cancelled";
    now: Date;
  },
) {
  const [request] = await tx
    .select({
      approvalId: toolActionRequests.approvalId,
      interactionId: toolActionRequests.interactionId,
    })
    .from(toolActionRequests)
    .where(
      and(
        eq(toolActionRequests.id, input.actionRequestId),
        eq(toolActionRequests.companyId, input.companyId),
      ),
    )
    .limit(1);
  if (!request?.approvalId) return null;
  const [cancelled] = await tx
    .update(approvals)
    .set({
      status: "cancelled",
      decisionNote: `Linked tool action request ${input.status} before a decision`,
      decidedAt: input.now,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(approvals.companyId, input.companyId),
        eq(approvals.id, request.approvalId),
        inArray(approvals.status, ["pending", "revision_requested"]),
      ),
    )
    .returning({
      id: approvals.id,
      requestedByAgentId: approvals.requestedByAgentId,
    });
  if (!cancelled) return null;
  await logActivity(tx as unknown as Db, {
    companyId: input.companyId,
    actorType: "system",
    actorId: "tool-gateway",
    action: "approval.cancelled",
    entityType: "approval",
    entityId: cancelled.id,
    agentId: cancelled.requestedByAgentId ?? null,
    details: {
      reason: "linked_tool_action_request_resolved",
      interactionId: request.interactionId ?? null,
      actionRequestId: input.actionRequestId,
      actionRequestStatus: input.status,
    },
  });
  return cancelled.id;
}

export function toolReviewExpiryService(db: Db, onExpired: (input: {
  actionRequestId: string;
  invocationId: string;
  status: "expired";
  errorCode: string;
  errorMessage: string;
}) => Promise<void>) {
  const pending = eq(toolActionRequests.status, "pending");
  const waiting = and(eq(toolActionRequests.status, "approved"),
    sql`exists (select 1 from ${toolInvocations} where ${toolInvocations.id} = ${toolActionRequests.invocationId}
      and ${toolInvocations.companyId} = ${toolActionRequests.companyId}
      and ${toolInvocations.status} = 'awaiting_approval' and ${toolInvocations.startedAt} is null
      and ${toolInvocations.errorCode} = ${TOOL_APPROVAL_CONNECTION_REQUIRED})`);
  const eligible = or(pending, waiting);
  return {
    async next(): Promise<number | null> {
      const earliest = (condition: typeof pending | typeof waiting) => db.select({
        at: sql<string | Date | null>`min(${toolActionRequests.expiresAt})`.as("at"),
      }).from(toolActionRequests).where(condition);
      const candidates = unionAll(earliest(pending), earliest(waiting)).as("review_deadlines");
      const [row] = await db.select({ at: sql<string | Date | null>`min(${candidates.at})` }).from(candidates);
      return row?.at == null ? null : new Date(row.at).getTime();
    },
    sweep,
    sweepForCompany: (companyId: string) => sweep(new Date(), companyId, 1),
    async deadlines(companyId?: string) {
      // Keep the pending-only predicate in its own branch so PostgreSQL can
      // still read one entry from the partial deadline index on large backlogs.
      const deadlines = (condition: typeof pending | typeof waiting) => companyId === undefined
        ? db.select({ companyId: toolActionRequests.companyId,
          at: sql<string | Date>`min(${toolActionRequests.expiresAt})`.as("at") })
          .from(toolActionRequests).where(and(condition, isNotNull(toolActionRequests.expiresAt))).groupBy(toolActionRequests.companyId)
        : db.select({ companyId: toolActionRequests.companyId,
          at: sql<string | Date>`${toolActionRequests.expiresAt}`.as("at") })
          .from(toolActionRequests).where(and(condition, isNotNull(toolActionRequests.expiresAt), eq(toolActionRequests.companyId, companyId)))
          .orderBy(asc(toolActionRequests.expiresAt)).limit(1);
      const candidates = unionAll(deadlines(pending), deadlines(waiting)).as("review_deadlines");
      const rows = await db.select({ companyId: candidates.companyId,
        at: sql<string | Date>`min(${candidates.at})` }).from(candidates).groupBy(candidates.companyId);
      return rows.map(row => ({ companyId: row.companyId, dueAt: new Date(row.at).getTime() }));
    },
  };
  async function sweep(now = new Date(), companyId?: string, maxPages = Infinity) {
    let cursor: string | undefined;
    let scanned = 0;
    for (let page = 0; page < maxPages; page++) {
      const rows = await db.select().from(toolActionRequests).where(and(
        eligible, lte(toolActionRequests.expiresAt, now),
        cursor ? gt(toolActionRequests.id, cursor) : undefined,
        companyId === undefined ? undefined : eq(toolActionRequests.companyId, companyId),
      )).orderBy(asc(toolActionRequests.id)).limit(100);
      for (const row of rows) {
        const errorCode = "action_expired";
        const errorMessage = row.status === "approved" ? "The action deadline passed before execution."
          : "The approval request expired before a decision.";
        const changed = await writeToolReviewChange(db, row.companyId, async tx => {
          const [updated] = await tx.update(toolActionRequests)
            .set({ status: "expired", resolvedAt: now, updatedAt: now }).where(and(
              eq(toolActionRequests.id, row.id), eq(toolActionRequests.status, row.status),
              eq(toolActionRequests.updatedAt, row.updatedAt),
            )).returning({ id: toolActionRequests.id });
          if (!updated) return false;
          await cancelFormalApprovalForResolvedToolAction(tx, { companyId: row.companyId, actionRequestId: row.id, status: "expired", now });
          await tx.update(toolInvocations).set({ status: "failed", errorCode, errorMessage,
            completedAt: now, updatedAt: now }).where(eq(toolInvocations.id, row.invocationId));
          return true;
        });
        if (changed) await onExpired({ actionRequestId: row.id, invocationId: row.invocationId,
          status: "expired", errorCode, errorMessage });
      }
      scanned += rows.length;
      if (rows.length < 100) break;
      cursor = rows[rows.length - 1].id;
    }
    return { scanned };
  }
}
