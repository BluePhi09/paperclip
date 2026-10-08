import { and, desc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRunEvents, heartbeatRuns, issueRecoveryActions, type Db } from "@paperclipai/db";
import { readProcessStartedAt } from "./hot-restart.js";

// These adapters accept a conversation turn. Retrying a process or webhook can
// replay the action itself, so those adapters retain their recovery contract.
export const CONVERSATION_ADAPTER_TYPES = [
  "claude_local", "codex_local", "cursor", "gemini_local", "opencode_local",
  "pi_local", "grok_local", "kimi_local", "hermes_local",
] as const;

export function isConversationAdapter(adapterType: string): boolean {
  return (CONVERSATION_ADAPTER_TYPES as readonly string[]).includes(adapterType);
}

export const CONVERSATION_CONTINUATION_POLICY = "continue_conversation_v1";

export function hasConversationContinuationPolicy(result: Record<string, unknown> | null | undefined): boolean {
  return result?.workspaceRestoreFailure !== "restore_unsafe_archive" && result?.conversationContinuation === CONVERSATION_CONTINUATION_POLICY;
}

/** Persisted by the server when it claims the run, before remote provisioning. */
export function claimedAdapterType(run: Pick<typeof heartbeatRuns.$inferSelect, "runnerProfileJson">): string | null {
  const dispatch = run.runnerProfileJson?.adapterDispatch as Record<string, unknown> | undefined;
  return typeof dispatch?.adapterType === "string" ? dispatch.adapterType : null;
}

function conversationRunPredicate() {
  return or(
    inArray(sql`${heartbeatRuns.runnerProfileJson}->'adapterDispatch'->>'adapterType'`, [...CONVERSATION_ADAPTER_TYPES]),
    sql`${heartbeatRuns.resultJson}->>'conversationContinuation' = ${CONVERSATION_CONTINUATION_POLICY}`,
    and(
      sql`${heartbeatRuns.runnerProfileJson}->'adapterDispatch'->>'adapterType' is null`,
      sql`exists (
      select 1 from ${heartbeatRunEvents}
      where ${heartbeatRunEvents.companyId} = ${heartbeatRuns.companyId}
        and ${heartbeatRunEvents.runId} = ${heartbeatRuns.id}
        and ${heartbeatRunEvents.eventType} = 'adapter.invoke'
        and ${inArray(sql`${heartbeatRunEvents.payload}->>'adapterType'`, [...CONVERSATION_ADAPTER_TYPES])}
    )`),
  );
}

/** Recovery must not infer the old adapter from the agent's mutable settings. */
export async function historicalAdapterType(db: Db, run: typeof heartbeatRuns.$inferSelect): Promise<string | null> {
  const selected = claimedAdapterType(run);
  if (selected) return selected;
  const [invocation] = await db.select({ payload: heartbeatRunEvents.payload }).from(heartbeatRunEvents)
    .where(and(eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id),
      eq(heartbeatRunEvents.eventType, "adapter.invoke")))
    .orderBy(desc(heartbeatRunEvents.seq)).limit(1);
  const adapterType = invocation?.payload?.adapterType;
  return typeof adapterType === "string" ? adapterType : null;
}

export async function runUsedConversationAdapter(db: Db, run: typeof heartbeatRuns.$inferSelect): Promise<boolean> {
  if (run.resultJson?.workspaceRestoreFailure === "restore_unsafe_archive") return false;
  if (hasConversationContinuationPolicy(run.resultJson)) return true;
  const adapterType = await historicalAdapterType(db, run);
  return adapterType !== null && isConversationAdapter(adapterType);
}

/** Only immutable run evidence can retire a historical conversation hold.
 * An agent's current adapter can differ from the one that executed this run.
 * Missing evidence retains the hold; the current agent is never a fallback.
 */
export function conversationHoldDisposition(action: Pick<typeof issueRecoveryActions.$inferSelect, "companyId" | "sourceIssueId" | "fingerprint" | "evidence">) {
  return { version: 1, kind: "conversation_hold_retired", companyId: action.companyId,
    issueId: action.sourceIssueId, runId: action.evidence.runId, fingerprint: action.fingerprint };
}

/** A disposition retires one incident, never reconciles external actions or
 * authorizes replay. Revalidate immutable source identity and live ownership. */
export async function hasRetiredConversationHold(db: Db, run: typeof heartbeatRuns.$inferSelect, issueId: string): Promise<boolean> {
  const [retired] = await db.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions).where(and(
    conversationRecoveryActionPredicate(),
    eq(issueRecoveryActions.companyId, run.companyId), eq(issueRecoveryActions.sourceIssueId, issueId),
    eq(issueRecoveryActions.fingerprint, `legacy-execution:${run.id}`),
    eq(issueRecoveryActions.status, "resolved"), eq(issueRecoveryActions.outcome, "cancelled"),
    sql`${issueRecoveryActions.evidence}->'conversationDisposition' = ${JSON.stringify({ version: 1, kind: "conversation_hold_retired",
      companyId: run.companyId, issueId, runId: run.id, fingerprint: `legacy-execution:${run.id}` })}::jsonb`,
  )).limit(1);
  return !!retired && !(await getConversationOwnershipBlocker(db, run.companyId, issueId));
}

export function conversationRecoveryActionPredicate() {
  return and(
    eq(issueRecoveryActions.cause, "legacy_execution_requires_reconciliation"),
    sql`${issueRecoveryActions.fingerprint} = 'legacy-execution:' || (${issueRecoveryActions.evidence}->>'runId')`,
    sql`coalesce(${issueRecoveryActions.evidence}->>'noReplay', 'false') <> 'true'`,
    sql`exists (
      select 1 from ${heartbeatRuns}
      where ${heartbeatRuns.companyId} = ${issueRecoveryActions.companyId}
        and ${heartbeatRuns.id}::text = ${issueRecoveryActions.evidence}->>'runId'
        and coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId') = ${issueRecoveryActions.sourceIssueId}::text
        and ${heartbeatRuns.runtimeMode} = 'legacy'
        and coalesce(${heartbeatRuns.resultJson}->>'workspaceRestoreFailure', '') <> 'restore_unsafe_archive'
        and not exists (
          select 1 from ${heartbeatRunEvents}
          where ${heartbeatRunEvents.companyId} = ${heartbeatRuns.companyId}
            and ${heartbeatRunEvents.runId} = ${heartbeatRuns.id}
            and ${heartbeatRunEvents.eventType} = 'tool.execution.started'
        )
        and ${inArray(heartbeatRuns.status, ['failed', 'timed_out', 'interrupted', 'cancelled'])}
        and ${conversationRunPredicate()}
        and ${or(
          sql`${heartbeatRuns.resultJson}->>'conversationContinuation' = ${CONVERSATION_CONTINUATION_POLICY}`,
          eq(heartbeatRuns.status, "interrupted"),
          inArray(heartbeatRuns.errorCode, ["process_lost", "server_shutdown_interrupted", "execution_reconciliation_required"]),
          and(eq(heartbeatRuns.status, "cancelled"), sql`${heartbeatRuns.resultJson}->'executionCancellation'->>'state' = 'acknowledged'`),
        )}
    )`,
  );
}

/** OS liveness probes do not signal or stop the process. Unknown ownership holds. */
function processMayBeAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** A terminal conversation row does not prove that its execution authority ended.
 * Other adapters keep their existing bootstrap and ownership protocols.
 */
export async function getConversationOwnershipBlocker(db: Db, companyId: string, issueId: string) {
  const activeLease = sql`(exists (select 1 from ${environmentLeases}
    where ${environmentLeases.companyId} = "heartbeat_runs"."company_id"
      and ${environmentLeases.heartbeatRunId} = "heartbeat_runs"."id"
      and (${environmentLeases.releasedAt} is null
        or ${environmentLeases.status} = 'pending_cleanup'
        or ${environmentLeases.cleanupStatus} = 'failed'))
    or (${heartbeatRuns.runnerProfileJson} ? 'runAcquisition'
      and coalesce(${heartbeatRuns.runnerProfileJson}->'runAcquisition'->>'state', 'unknown')
        not in ('published', 'cleanup_confirmed')))`;
  // Partial authority is unknown, not released. Both null is the historical
  // unowned state; an expired complete lease may proceed to the other barriers.
  const controllerHeld = sql<boolean>`(
    (${heartbeatRuns.controllerBootId} is not null and ${heartbeatRuns.controllerLeaseExpiresAt} is null)
    or (${heartbeatRuns.controllerBootId} is null and ${heartbeatRuns.controllerLeaseExpiresAt} is not null)
    or ${heartbeatRuns.controllerLeaseExpiresAt} > clock_timestamp()
  )`;
  const candidates = await db.select({ run: heartbeatRuns, activeLease, controllerHeld }).from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.runtimeMode, "legacy"),
      conversationRunPredicate(),
      sql`coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId') = ${issueId}`,
      inArray(heartbeatRuns.status, ["failed", "timed_out", "interrupted", "cancelled"]),
      or(isNotNull(heartbeatRuns.processPid), isNotNull(heartbeatRuns.processGroupId), activeLease, controllerHeld),
    )).orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id));
  for (const { run, activeLease: leaseHeld, controllerHeld: controllerOwns } of candidates) {
    let pidAlive = run.processPid !== null && processMayBeAlive(run.processPid);
    if (pidAlive && run.processStartedAt) {
      // A recycled PID cannot keep an old task blocked. An unreadable identity
      // stays conservative; the original process may still own execution.
      const observed = await readProcessStartedAt(run.processPid!).catch(() => null);
      if (observed && new Date(observed).getTime() !== run.processStartedAt.getTime()) pidAlive = false;
    }
    const groupAlive = run.processGroupId !== null && processMayBeAlive(-run.processGroupId);
    if (pidAlive || groupAlive || leaseHeld || controllerOwns) {
      return {
        runId: run.id,
        agentId: run.agentId,
        cause: "execution_owner_active",
        nextAction: pidAlive || groupAlive
          ? "The previous provider process is still running. Stop it before continuing this task."
          : controllerOwns
            ? "The previous controller still owns execution or its authority is unknown. Wait for confirmed release before continuing this task."
            : "The previous execution has not released its environment lease. Wait for cleanup before continuing this task.",
      };
    }
  }
  return null;
}
