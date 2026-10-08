import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, issueRecoveryActions, issues, type Db } from "@paperclipai/db";
import { conflict } from "../errors.js";

export interface AcquisitionBinding {
  companyId: string;
  heartbeatRunId?: string | null;
  issueId?: string | null;
  environmentId: string;
  executionWorkspaceId?: string | null;
  expectedControllerBootId?: string | null;
}
export interface RunAcquisition extends Record<string, unknown> {
  token: string;
  generation: number;
  state: string;
  controllerBootId: string | null;
  runnerInstanceId: string | null;
  runtimeMode: string;
  environmentId: string;
  issueId: string | null;
  executionWorkspaceId: string | null;
}
export function readRunAcquisition(run: Pick<typeof heartbeatRuns.$inferSelect, "runnerProfileJson">) {
  return run.runnerProfileJson?.runAcquisition as RunAcquisition | undefined;
}
export const acquisitionUnknown = (state: string | undefined) => ["pending", "unknown", "cleanup_pending", "cleanup_failed"].includes(state ?? "");

/** Shared issue -> run lock order. Never hold these locks across a provider RPC. */
export async function lockAcquisitionRun(tx: Db, input: AcquisitionBinding) {
  if (!input.heartbeatRunId) return null;
  const [snapshot] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, input.heartbeatRunId), eq(heartbeatRuns.companyId, input.companyId)));
  if (!snapshot) throw conflict("Acquisition run binding is missing.");
  const issueId = snapshot.nativeIssueId ?? snapshot.contextSnapshot?.issueId ?? null;
  if (issueId !== (input.issueId ?? null)) throw conflict("Acquisition issue binding changed.");
  if (typeof issueId === "string") {
    const [issue] = await tx.select().from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, input.companyId))).for("update");
    if (!issue) throw conflict("Acquisition issue binding is missing.");
  }
  const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, snapshot.id), eq(heartbeatRuns.companyId, input.companyId))).for("update");
  if (!run || (run.nativeIssueId ?? run.contextSnapshot?.issueId ?? null) !== issueId) throw conflict("Acquisition run binding changed.");
  return run;
}
export async function acquisitionAuthorityValid(tx: Db, run: typeof heartbeatRuns.$inferSelect, expectedBootId?: string | null) {
  if (run.status !== "running") return false;
  if (run.runtimeMode === "legacy") {
    if (!run.controllerBootId || !run.controllerLeaseExpiresAt || (expectedBootId !== undefined && run.controllerBootId !== expectedBootId)) return false;
    const [live] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(eq(heartbeatRuns.id, run.id), sql`${heartbeatRuns.controllerLeaseExpiresAt} > clock_timestamp()`));
    if (!live) return false;
  }
  const issueId = run.nativeIssueId ?? run.contextSnapshot?.issueId;
  if (typeof issueId === "string") {
    const [issue] = await tx.select().from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, run.companyId)));
    if (!issue || (issue.executionRunId && issue.executionRunId !== run.id)) return false;
    // A checkout left behind by a terminal run is stale, not a competing owner
    // (it is cleared lazily); only another live run's checkout revokes authority.
    if (issue.checkoutRunId && issue.checkoutRunId !== run.id) {
      const [other] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.id, issue.checkoutRunId), eq(heartbeatRuns.companyId, run.companyId),
        sql`${heartbeatRuns.status} in ('queued', 'running')`,
      )).limit(1);
      if (other) return false;
    }
  }
  const [retired] = await tx.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, run.companyId), eq(issueRecoveryActions.fingerprint, `legacy-execution:${run.id}`), sql`${issueRecoveryActions.evidence} ? 'conversationDisposition'`)).limit(1);
  return !retired;
}

export async function writeRunAcquisition(tx: Db, runId: string, acquisition: RunAcquisition) {
  await tx.update(heartbeatRuns).set({ runnerProfileJson: sql`coalesce(${heartbeatRuns.runnerProfileJson}, '{}'::jsonb) || jsonb_build_object('runAcquisition', ${JSON.stringify(acquisition)}::jsonb)`, updatedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
}
/** The run metadata is the reservation ledger; environment leases stay resource owners/cleanup records. */
export async function reserveRunAcquisition(db: Db, input: AcquisitionBinding) {
  if (!input.heartbeatRunId) return null;
  return db.transaction(async rawTx => {
    const tx = rawTx as unknown as Db;
    const run = await lockAcquisitionRun(tx, input);
    if (!run || !(await acquisitionAuthorityValid(tx, run, input.expectedControllerBootId))) throw conflict("Environment acquisition controller authority lost.");
    const previous = readRunAcquisition(run);
    if (acquisitionUnknown(previous?.state)) throw conflict("Environment acquisition outcome is still unknown.");
    const [activeOwner] = await tx.select({ id: environmentLeases.id }).from(environmentLeases).where(and(
      eq(environmentLeases.companyId, input.companyId), eq(environmentLeases.heartbeatRunId, run.id),
      eq(environmentLeases.status, "active"), sql`${environmentLeases.leasePolicy} <> 'reuse_by_environment'`,
    )).limit(1);
    if (activeOwner) throw conflict("Environment acquisition already has an active lease.");
    const token = randomUUID();
    await writeRunAcquisition(tx, run.id, { version: 1, token, generation: (previous?.generation ?? 0) + 1, state: "pending", controllerBootId: run.controllerBootId, runnerInstanceId: run.runnerInstanceId, runtimeMode: run.runtimeMode, environmentId: input.environmentId, issueId: input.issueId ?? null, executionWorkspaceId: input.executionWorkspaceId ?? null });
    return token;
  });
}
/** Only the original generation may complete; a lost DB connection leaves pending/unknown, never safe. */
export async function finishRunAcquisition(db: Db, input: AcquisitionBinding, token: string, state: string, cleanupLeaseId?: string | null) {
  return db.transaction(async rawTx => {
    const tx = rawTx as unknown as Db;
    const run = await lockAcquisitionRun(tx, input);
    const current = run && readRunAcquisition(run);
    if (!run || !current || current.token !== token || !acquisitionUnknown(current.state)) return;
    await writeRunAcquisition(tx, run.id, { ...current, state, ...(cleanupLeaseId ? { cleanupLeaseId } : {}) });
  });
}
