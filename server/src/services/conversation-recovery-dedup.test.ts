import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { appendHeartbeatRunEvent } from "./heartbeat-run-events.js";
import { and, eq, sql } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRuns, heartbeatRunEvents, issueRecoveryActions, issues, activityLog, environments, environmentLeases } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { legacyExecutionNeedsReconciliationWithEvidence, terminalizeLegacyExecution } from "./legacy-execution-recovery.js";
import { settleUnrecoverableExecutions } from "./execution-recovery-resolution.js";
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("paperclip-conversation-dedup-"); db = createDb(database.connectionString); }, 120000);
afterEach(async () => { await db?.transaction(async tx => { await tx.execute(sql`set local client_min_messages = warning`); await tx.execute(sql`truncate companies cascade`); }); });
afterAll(async () => { await database?.cleanup(); });
it.each(["live_process", "live_controller"])("retains execution ownership before retiring a conversation hold (%s)", async mode => {
  const fixture = await seed();
  const [run] = await db.update(heartbeatRuns).set(mode === "live_process" ? { processPid: process.pid }
    : { controllerBootId: randomUUID(), controllerLeaseExpiresAt: new Date(Date.now() + 60000) })
    .where(eq(heartbeatRuns.id, fixture.runId)).returning();
  await terminalizeLegacyExecution({ db, run: run!, status: "interrupted" });
  await settleUnrecoverableExecutions(db);
  const [hold] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, fixture.issueId));
  expect(hold!.status).toBe("active");
  expect(hold!.evidence).not.toHaveProperty("conversationDisposition");
});
it.each(["expired", "released"])("retires a conversation hold after controller authority is %s", async mode => {
  const f = await seed();
  const [run] = await db.update(heartbeatRuns).set(mode === "expired"
    ? { controllerBootId: randomUUID(), controllerLeaseExpiresAt: new Date(0) }
    : { controllerBootId: null, controllerLeaseExpiresAt: null }).where(eq(heartbeatRuns.id, f.runId)).returning();
  await terminalizeLegacyExecution({ db, run: run!, status: "interrupted" });
  await settleUnrecoverableExecutions(db);
  expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId)))[0])
    .toMatchObject({ status: "resolved", outcome: "cancelled", evidence: { conversationDisposition: { runId: f.runId } } });
});
it.each(["missing_expiry", "missing_boot"])("holds unknown controller authority (%s)", async mode => {
  const f = await seed();
  const [run] = await db.update(heartbeatRuns).set(mode === "missing_expiry"
    ? { controllerBootId: randomUUID(), controllerLeaseExpiresAt: null }
    : { controllerBootId: null, controllerLeaseExpiresAt: new Date(0) }).where(eq(heartbeatRuns.id, f.runId)).returning();
  await terminalizeLegacyExecution({ db, run: run!, status: "interrupted" });
  await settleUnrecoverableExecutions(db);
  expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId)))[0]).toMatchObject({ status: "active" });
});
it.each(["unsafe_archive", "noReplay", "unknown_action", "wrong_fingerprint", "claimed_process"])("does not retire protected or misbound incidents (%s)", async mode => {
  const fixture = await seed();
  const patch = mode === "unsafe_archive" ? { resultJson: { workspaceRestoreFailure: "restore_unsafe_archive" } }
    : mode === "claimed_process" ? { runnerProfileJson: { adapterDispatch: { adapterType: "process" } } } : {};
  const [run] = await db.update(heartbeatRuns).set({ ...patch, updatedAt: new Date() }).where(eq(heartbeatRuns.id, fixture.runId)).returning();
  if (mode === "unknown_action" || mode === "claimed_process") await appendHeartbeatRunEvent(db, { companyId: fixture.companyId, agentId: fixture.agentId, runId: fixture.runId, eventType: mode === "unknown_action" ? "tool.execution.started" : "adapter.invoke", stream: "system", payload: mode === "unknown_action" ? { name: "send_email", executionId: "unconfirmed-write", transport: "process" } : { adapterType: "claude_local" } });
  await terminalizeLegacyExecution({ db, run: run!, status: "interrupted" });
  if (mode === "noReplay") await db.update(issueRecoveryActions).set({ evidence: { runId: fixture.runId, noReplay: true } }).where(eq(issueRecoveryActions.sourceIssueId, fixture.issueId));
  if (mode === "wrong_fingerprint") await db.update(issueRecoveryActions).set({ fingerprint: "other-incident" }).where(eq(issueRecoveryActions.sourceIssueId, fixture.issueId));
  await settleUnrecoverableExecutions(db);
  const [hold] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, fixture.issueId));
  expect(hold!.evidence).not.toHaveProperty("conversationDisposition");
  expect(hold).toMatchObject({ status: "resolved", outcome: "blocked", evidence: {
    automaticRecovery: { policy: "preserve_without_replay_v1", replay: "blocked", actionOutcome: "unknown" },
  } });
  const [task] = await db.select().from(issues).where(eq(issues.id, fixture.issueId));
  expect(task!.status).toBe("blocked");
  const lifecycle = await db.select().from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.runId, fixture.runId), eq(heartbeatRunEvents.eventType, "lifecycle"),
  ));
  expect(lifecycle).toHaveLength(1);
  expect(lifecycle[0]!.payload).toMatchObject({ replay: "blocked" });
  expect((hold!.evidence.automaticRecovery as Record<string, unknown> | undefined)?.replay).not.toBe("conversation_continuation");
  expect(await legacyExecutionNeedsReconciliationWithEvidence(db, run!)).toBe(true);
});
it.each(["renewal", "reassignment", "issue_claim", "tool_effect", "lease_renewal"])("serializes hold retirement with concurrent controller %s", async mode => {
  const f = await seed();
  const priorBootId = randomUUID();
  await db.update(heartbeatRuns).set({ controllerBootId: priorBootId, controllerLeaseExpiresAt: new Date(0) }).where(eq(heartbeatRuns.id, f.runId));
  await terminalizeLegacyExecution({ db, run: f.run, status: "interrupted" });
  let release!: () => void;
  let locked!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { locked = resolve; });
  const leaseId = randomUUID();
  if (mode === "lease_renewal") {
    const environmentId = randomUUID();
    await db.insert(environments).values({ id: environmentId, name: `Fixture ${environmentId}`, driver: "sandbox", config: { provider: "fake" } });
    await db.insert(environmentLeases).values({ id: leaseId, companyId: f.companyId, environmentId, heartbeatRunId: f.runId, status: "released", releasedAt: new Date(), cleanupStatus: "success" });
  }
  const writer = db.transaction(async tx => {
    if (mode === "lease_renewal") {
      await tx.update(environmentLeases).set({ status: "active", releasedAt: null }).where(eq(environmentLeases.id, leaseId));
    } else if (mode === "issue_claim") {
      await tx.select().from(issues).where(eq(issues.id, f.issueId)).for("update");
      const successor = randomUUID();
      await tx.insert(heartbeatRuns).values({ id: successor, companyId: f.companyId, agentId: f.agentId, status: "running", contextSnapshot: { issueId: f.issueId } });
      await tx.update(issues).set({ executionRunId: successor }).where(eq(issues.id, f.issueId));
    } else if (mode === "tool_effect") {
      await appendHeartbeatRunEvent(tx as unknown as typeof db, { companyId: f.companyId, agentId: f.agentId, runId: f.runId,
        eventType: "tool.execution.started", payload: { executionId: "synthetic-unknown-effect" } });
    } else {
      await tx.update(heartbeatRuns).set({ controllerBootId: mode === "renewal" ? priorBootId : randomUUID(),
        controllerLeaseExpiresAt: sql`clock_timestamp() + interval '60 seconds'`, executionStage: "dispatching" })
        .where(eq(heartbeatRuns.id, f.runId));
    }
    locked();
    await gate;
  });
  await ready;
  let finished = false;
  const settlement = settleUnrecoverableExecutions(db).finally(() => { finished = true; });
  let waiting = false;
  try {
    for (let attempt = 0; attempt < 100 && !finished; attempt++) {
      const rows = await db.execute(sql`select 1 from pg_stat_activity where datname = current_database()
        and wait_event_type = 'Lock' and cardinality(pg_blocking_pids(pid)) > 0`);
      if (rows.length) { waiting = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  } finally { release(); await writer; await settlement; }
  expect(waiting, "settlement must wait for the ownership writer, not read its stale predecessor").toBe(true);
  const [hold] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
  expect(hold).toMatchObject(mode === "tool_effect" ? { status: "resolved", outcome: "blocked", evidence: { automaticRecovery: { replay: "blocked" } } } : { status: "active" });
  expect(hold!.evidence).not.toHaveProperty("conversationDisposition");
});
async function seed() {
  const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Synthetic recovery", issuePrefix: `R${companyId.slice(0,6)}` });
  await db.insert(agents).values({ id: agentId, companyId, name: "Synthetic executor", role: "engineer", adapterType: "process" });
  await db.insert(issues).values({ id: issueId, companyId, title: "Synthetic legacy conversation", status: "in_progress", assigneeAgentId: agentId });
  const [run] = await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "interrupted", runtimeMode: "legacy", errorCode: "orphaned_running_run", contextSnapshot: { issueId }, runnerProfileJson: { adapterDispatch: { adapterType: "claude_local" } } }).returning();
  return { companyId, agentId, issueId, runId, run: run! };
}
it("durably retires one historical conversation hold across twenty service ticks and a fresh DB client", async () => {
  const { companyId, issueId, runId, run } = await seed();
  // No provider calls, wakes, scheduler timers or live DB URLs. Execute the
  // production terminalize/settlement seam with an immutable historical run.
  for (let tick = 0; tick < 20; tick++) {
    await terminalizeLegacyExecution({ db, run: run!, status: "interrupted" });
    await settleUnrecoverableExecutions(db);
  }
  const rows = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ status: "resolved", outcome: "cancelled", fingerprint: `legacy-execution:${runId}`, evidence: { conversationDisposition: { version: 1, kind: "conversation_hold_retired", companyId, issueId, runId, fingerprint: `legacy-execution:${runId}` } } });
  expect(rows[0]!.evidence).not.toHaveProperty("executionReconciliation");
  const restarted = createDb(database.connectionString);
  expect(await legacyExecutionNeedsReconciliationWithEvidence(restarted, run!)).toBe(false);
  await terminalizeLegacyExecution({ db: restarted, run: run!, status: "interrupted" });
  expect(await restarted.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId))).toHaveLength(1);
  const [task] = await db.select().from(issues).where(eq(issues.id, issueId));
  expect(task!.status).toBe("in_progress");
  const events = await db.select().from(activityLog).where(and(eq(activityLog.entityId, issueId), eq(activityLog.action, "issue.execution_recovery_settled")));
  expect(events).toHaveLength(1);
  expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(1);
});
