import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { agents, companies, createDb, environments, environmentLeases, heartbeatRuns, heartbeatRunEvents, issues, issueRecoveryActions, plugins } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { environmentService } from "../services/environments.js";
import { reserveRunAcquisition } from "../services/environment-acquisition-authority.js";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import { terminalizeLegacyExecution } from "../services/legacy-execution-recovery.js";
import { heartbeatService } from "../services/heartbeat.js";
import { settleUnrecoverableExecutions } from "../services/execution-recovery-resolution.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("runtime-acquisition-authority-"); db = createDb(database.connectionString); }, 120000);
afterEach(async () => { await db.transaction(async tx => { await tx.execute(sql`set local client_min_messages = warning`); await tx.execute(sql`truncate companies, plugins, environments cascade`); }); });
afterAll(async () => { await database?.cleanup(); });
async function waitForLock() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const rows = await db.execute(sql`select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and cardinality(pg_blocking_pids(pid)) > 0`);
    if (rows.length) return true;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return false;
}
function gate() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function seed(driver: "plugin" | "sandbox" = "plugin", pluginKey = "fixture.plugin") {
  const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID(), environmentId = randomUUID(), pluginId = randomUUID(), bootId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Authority fixture", issuePrefix: `A${companyId.slice(0,6)}` });
  await db.insert(agents).values({ id: agentId, companyId, name: "Fixture", role: "engineer", adapterType: "codex_local" });
  await db.insert(issues).values({ id: issueId, companyId, title: "Authority fixture", status: "in_progress", assigneeAgentId: agentId });
  const [run] = await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", controllerBootId: bootId, controllerLeaseExpiresAt: new Date(Date.now()+60000), contextSnapshot: { issueId }, runnerProfileJson: { adapterDispatch: { adapterType: "codex_local" } } }).returning();
  const [environment] = await db.insert(environments).values({ id: environmentId, name: `Authority fixture ${environmentId}`, driver, config: driver === "sandbox" ? { provider: "fixture-provider" } : { pluginKey, driverKey: "fixture-provider", driverConfig: {} } }).returning();
  await db.insert(plugins).values({ id: pluginId, pluginKey, packageName: "fixture-plugin", version: "1", apiVersion: 1, categories: ["automation"], status: "ready", manifestJson: { id: pluginKey, apiVersion: 1, version: "1", displayName: "Fixture", description: "Synthetic", author: "Synthetic", categories: ["automation"], capabilities: ["environment.drivers.register"], entrypoints: { worker: "unused" }, environmentDrivers: [{ driverKey: "fixture-provider", kind: "sandbox_provider", displayName: "Fixture", configSchema: { type: "object" } }] } });
  return { companyId, agentId, issueId, runId, environmentId, bootId, run: run!, environment: { ...environment!, driver, status: "active" as const, envVars: {} } };
}
async function assertNoDispatch(f: Awaited<ReturnType<typeof seed>>, call: ReturnType<typeof vi.fn>) {
  expect(call.mock.calls.filter(([, method]) => /Execute|Duplex|Sync/.test(method as string))).toHaveLength(0);
  expect(await db.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, f.runId), sql`${heartbeatRunEvents.eventType} in ('adapter.invoke','tool.execution.started')`))).toHaveLength(0);
}
it.each(["terminal", "issue_reassigned", "reassigned_controller", "cleanup_failed", "rpc_unknown"])("keeps pending acquire held and cleans late NEW publication (%s)", async mode => {
  const f = await seed(); const entered = gate(), release = gate();
  const call = vi.fn(async (_: string, method: string) => {
    if (method === "environmentAcquireLease") { entered.resolve(); await release.promise; if (mode === "rpc_unknown") throw new Error("Synthetic timeout with unknown allocation"); return { providerLeaseId: "late-resource", metadata: { effectiveAdapterType: "codex_local" } }; }
    if (method === "environmentDestroyLease") { if (mode === "cleanup_failed") throw new Error("Synthetic cleanup failure"); return {}; }
    throw new Error(`Unexpected dispatch ${method}`);
  });
  const runtime = environmentRuntimeService(db, { pluginWorkerManager: { isRunning: () => true, call, getWorker: () => ({ supportedMethods: [] }) } as unknown as PluginWorkerManager });
  const acquisition = runtime.acquireRunLease({ ...f, heartbeatRunId: f.runId, persistedExecutionWorkspace: null, adapterType: "codex_local" });
  const outcome = acquisition.then(value => ({ value, error: null }), error => ({ value: null, error }));
  await entered.promise;
  let pendingHold: unknown;
  try {
    const [terminal] = await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: new Date(0), status: "interrupted" }).where(eq(heartbeatRuns.id, f.runId)).returning();
    await terminalizeLegacyExecution({ db, run: terminal!, status: "interrupted" });
    await settleUnrecoverableExecutions(db);
    if (mode === "issue_reassigned") {
      const successor = randomUUID();
      await db.insert(heartbeatRuns).values({ id: successor, companyId: f.companyId, agentId: f.agentId, status: "interrupted", contextSnapshot: { issueId: f.issueId } });
      await db.update(issues).set({ checkoutRunId: successor }).where(eq(issues.id, f.issueId));
    }
    if (mode === "reassigned_controller") await db.update(heartbeatRuns).set({ status: "running", controllerBootId: randomUUID(), controllerLeaseExpiresAt: new Date(Date.now()+60000) }).where(eq(heartbeatRuns.id, f.runId));
    [pendingHold] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
  } finally { release.resolve(); }
  const result = await outcome;
  expect(pendingHold).toMatchObject({ status: "active" });
  expect(result.error).toBeTruthy();
  expect(result.value).toBeNull();
  const leases = await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, f.runId));
  expect(leases.filter(l => l.status === "active")).toHaveLength(0);
  if (mode === "rpc_unknown") {
    expect(leases).toHaveLength(0);
    const [unknownRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(unknownRun!.runnerProfileJson?.runAcquisition).toMatchObject({ state: "unknown", generation: 1 });
  }
  else expect(leases.some(l => l.providerLeaseId === "late-resource" && l.cleanupStatus === (mode === "cleanup_failed" ? "failed" : "success"))).toBe(true);
  expect(call.mock.calls.filter(([, method]) => method === "environmentDestroyLease")).toHaveLength(mode === "rpc_unknown" ? 0 : 1);
  await assertNoDispatch(f, call);
  await db.update(issues).set({ checkoutRunId: null }).where(eq(issues.id, f.issueId));
  await settleUnrecoverableExecutions(db);
  expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId)))[0]).toMatchObject(
    ["rpc_unknown", "cleanup_failed", "reassigned_controller"].includes(mode) ? { status: "active" }
      : { status: "resolved", outcome: "cancelled", evidence: { conversationDisposition: { runId: f.runId } } });
});

it.each(["inline", "delayed", "successor"])("followup creation cleanup settles only its reservation (%s)", async mode => {
  const f = await seed("sandbox");
  let available = mode === "inline";
  let originalToken: unknown;
  const attemptId = randomUUID(), providerLeaseId = `paperclip-create-${attemptId}`;
  const cleanup = { providerLeaseId, attemptId, companyId: f.companyId, environmentId: f.environmentId,
    runId: f.runId, accountFingerprint: "a".repeat(64), labels: { "paperclip-provider": "fixture-provider" } };
  const call = vi.fn(async (_: string, method: string) => {
    if (method === "environmentAcquireLease") {
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      originalToken = (run!.runnerProfileJson!.runAcquisition as { token: string }).token;
      throw Object.assign(new Error("creation uncertain"), { data: { schema: "paperclip/environment-creation-cleanup/v1", cleanup } });
    }
    if (method === "environmentDestroyLease") {
      if (!available) throw new Error("cleanup unavailable");
      return { providerLeaseId, state: "destroyed" };
    }
    throw new Error(`Unexpected dispatch ${method}`);
  });
  const worker = { isRunning: () => true, call, getWorker: () => ({ supportedMethods: ["environmentDestroyLease"] }) } as unknown as PluginWorkerManager;
  const runtime = environmentRuntimeService(db, { pluginWorkerManager: worker });
  await expect(runtime.acquireRunLease({ ...f, heartbeatRunId: f.runId, persistedExecutionWorkspace: null })).rejects.toThrow();
  const successorToken = randomUUID();
  if (mode !== "inline") {
    const [failed] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(failed!.runnerProfileJson!.runAcquisition).toMatchObject({ token: originalToken, generation: 1, state: "cleanup_failed" });
    if (mode === "successor") await db.update(heartbeatRuns).set({ runnerProfileJson: { ...failed!.runnerProfileJson,
      runAcquisition: { ...(failed!.runnerProfileJson!.runAcquisition as object), token: successorToken, generation: 2, state: "unknown" } } }).where(eq(heartbeatRuns.id, f.runId));
    available = true;
    const restarted = environmentRuntimeService(db, { pluginWorkerManager: worker });
    await heartbeatService(db, { environmentRuntime: restarted }).sweepPendingCleanupLeases({ backoffMs: 0 });
  }
  const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
  expect(run!.runnerProfileJson!.runAcquisition).toMatchObject(mode === "successor"
    ? { token: successorToken, generation: 2, state: "unknown" }
    : { token: originalToken, generation: 1, state: "cleanup_confirmed" });
  const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, f.runId));
  expect(lease).toMatchObject({ status: "expired", cleanupStatus: "success" });
  expect(call.mock.calls.filter(([, method]) => method === "environmentDestroyLease")).toHaveLength(mode === "inline" ? 1 : 2);
  await assertNoDispatch(f, call);
});

it.each(["inline", "spool", "spool-successor", "inline-ledger-failure"])("followup known generic allocation survives cleanup INSERT DB failure (%s)", async mode => {
  const f = await seed();
  const spoolDir = await mkdtemp(path.join(os.tmpdir(), "followup-cleanup-"));
  let available = mode === "inline" || mode === "inline-ledger-failure";
  const call = vi.fn(async (_: string, method: string) => {
    if (method === "environmentAcquireLease") {
      await db.update(heartbeatRuns).set({ status: "interrupted", controllerLeaseExpiresAt: new Date(0) }).where(eq(heartbeatRuns.id, f.runId));
      return { providerLeaseId: "known-orphan", metadata: { accessToken: "fixture-secret-must-not-spool", opaque: { auth: "fixture-secret-must-not-spool" } } };
    }
    if (method === "environmentDestroyLease") {
      if (!available) throw new Error("provider temporarily unavailable");
      return { providerLeaseId: "known-orphan", state: "destroyed" };
    }
    throw new Error(`Unexpected dispatch ${method}`);
  });
  const worker = { isRunning: () => true, call, getWorker: () => ({ supportedMethods: ["environmentDestroyLease"] }) } as unknown as PluginWorkerManager;
  await db.execute(sql`create function followup_reject_cleanup() returns trigger language plpgsql as $$ begin
    if new.status = 'pending_cleanup' then raise exception 'fixture cleanup INSERT unavailable'; end if; return new; end $$`);
  await db.execute(sql`create trigger followup_reject_cleanup before insert on environment_leases for each row execute function followup_reject_cleanup()`);
  if (mode === "inline-ledger-failure") {
    await db.execute(sql`create function followup_reject_ledger() returns trigger language plpgsql as $$ begin
      if new.runner_profile_json->'runAcquisition'->>'state' = 'cleanup_confirmed' then raise exception 'fixture ledger unavailable'; end if; return new; end $$`);
    await db.execute(sql`create trigger followup_reject_ledger before update on heartbeat_runs for each row execute function followup_reject_ledger()`);
  }
  try {
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: worker, orphanCleanupSpoolDir: spoolDir });
    await expect(runtime.acquireRunLease({ ...f, heartbeatRunId: f.runId, persistedExecutionWorkspace: null })).rejects.toThrow();
    expect(call.mock.calls.filter(([, method]) => method === "environmentDestroyLease")).toHaveLength(1);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const original = run!.runnerProfileJson!.runAcquisition as { token: string };
    const successorToken = randomUUID();
    if (mode !== "inline") {
      expect((await readdir(spoolDir)).filter(name => name.endsWith(".json"))).toHaveLength(1);
      for (const file of await readdir(spoolDir)) {
        expect(await readFile(path.join(spoolDir, file), "utf8")).not.toContain("fixture-secret-must-not-spool");
      }
      if (mode === "spool-successor") await db.update(heartbeatRuns).set({ runnerProfileJson: { ...run!.runnerProfileJson,
        runAcquisition: { ...original, token: successorToken, generation: 2, state: "unknown" } } }).where(eq(heartbeatRuns.id, f.runId));
      await db.execute(sql`drop trigger followup_reject_cleanup on environment_leases`);
      if (mode === "inline-ledger-failure") await db.execute(sql`drop trigger followup_reject_ledger on heartbeat_runs`);
      available = true;
      const restarted = environmentRuntimeService(db, { pluginWorkerManager: worker, orphanCleanupSpoolDir: spoolDir });
      await heartbeatService(db, { environmentRuntime: restarted }).sweepPendingCleanupLeases({ backoffMs: 0 });
      const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, f.runId));
      expect(lease).toMatchObject({ status: "expired", cleanupStatus: "success", providerLeaseId: "known-orphan" });
      expect((await readdir(spoolDir)).filter(name => name.endsWith(".json"))).toHaveLength(0);
    }
    const [finished] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(finished!.runnerProfileJson!.runAcquisition).toMatchObject(mode === "spool-successor"
      ? { token: successorToken, generation: 2, state: "unknown" }
      : { token: original.token, generation: 1, state: "cleanup_confirmed" });
    await assertNoDispatch(f, call);
  } finally {
    await db.execute(sql`drop trigger if exists followup_reject_cleanup on environment_leases`);
    await db.execute(sql`drop function followup_reject_cleanup()`);
    if (mode === "inline-ledger-failure") {
      await db.execute(sql`drop trigger if exists followup_reject_ledger on heartbeat_runs`);
      await db.execute(sql`drop function followup_reject_ledger()`);
    }
    await rm(spoolDir, { recursive: true, force: true });
  }
});

it.each([false, true])("followup same provider lease ID preserves both scoped recovery consumers (restart=%s)", async restart => {
  const fixtures = [await seed(), await seed("plugin", "fixture.other")];
  const spoolDir = await mkdtemp(path.join(os.tmpdir(), "followup-collision-"));
  let available = false;
  const destroyed: string[] = [];
  const call = vi.fn(async (_: string, method: string, params: { companyId: string; runId: string }) => {
    if (method === "environmentAcquireLease") {
      await db.update(heartbeatRuns).set({ status: "interrupted", controllerLeaseExpiresAt: new Date(0) }).where(eq(heartbeatRuns.id, params.runId));
      return { providerLeaseId: "1" };
    }
    if (method === "environmentDestroyLease") {
      if (!available) throw new Error("provider unavailable");
      destroyed.push(params.companyId); return { providerLeaseId: "1", state: "destroyed" };
    }
    throw new Error(`Unexpected method ${method}`);
  });
  const worker = { isRunning: () => true, call, getWorker: () => ({ supportedMethods: ["environmentDestroyLease"] }) } as unknown as PluginWorkerManager;
  const runtime = environmentRuntimeService(db, { pluginWorkerManager: worker, orphanCleanupSpoolDir: spoolDir });
  await db.execute(sql`create function followup_reject_cleanup() returns trigger language plpgsql as $$ begin
    if new.status = 'pending_cleanup' then raise exception 'fixture cleanup INSERT unavailable'; end if; return new; end $$`);
  await db.execute(sql`create trigger followup_reject_cleanup before insert on environment_leases for each row execute function followup_reject_cleanup()`);
  try {
    for (const f of fixtures) await expect(runtime.acquireRunLease({ ...f, heartbeatRunId: f.runId, persistedExecutionWorkspace: null })).rejects.toThrow();
    expect((await readdir(spoolDir)).filter(name => name.endsWith(".json"))).toHaveLength(2);
    await db.execute(sql`drop trigger followup_reject_cleanup on environment_leases`);
    available = true;
    const consumer = restart ? environmentRuntimeService(db, { pluginWorkerManager: worker, orphanCleanupSpoolDir: spoolDir }) : runtime;
    await heartbeatService(db, { environmentRuntime: consumer }).sweepPendingCleanupLeases({ backoffMs: 0 });
    expect(destroyed.sort()).toEqual(fixtures.map(f => f.companyId).sort());
    expect(await readdir(spoolDir)).toHaveLength(0);
    for (const f of fixtures) {
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      expect(run!.runnerProfileJson!.runAcquisition).toMatchObject({ generation: 1, state: "cleanup_confirmed" });
    }
  } finally {
    await db.execute(sql`drop trigger if exists followup_reject_cleanup on environment_leases`);
    await db.execute(sql`drop function followup_reject_cleanup()`);
    await rm(spoolDir, { recursive: true, force: true });
  }
});

it.each([false, true])("followup ad-hoc sandbox accounts retain distinct cleanup consumers (restart=%s)", async restart => {
  const f = await seed("sandbox");
  const spoolDir = await mkdtemp(path.join(os.tmpdir(), "followup-account-"));
  let available = false;
  const destroyed: string[] = [];
  const call = vi.fn(async (_: string, method: string, params: { config: { namespace?: string } }) => {
    if (method === "environmentAcquireLease") return { providerLeaseId: "1" };
    if (method === "environmentDestroyLease") {
      if (!available) throw new Error("provider unavailable");
      destroyed.push(params.config.namespace!); return { providerLeaseId: "1", state: "destroyed" };
    }
    throw new Error(`Unexpected method ${method}`);
  });
  const worker = { isRunning: () => true, call, getWorker: () => ({ supportedMethods: ["environmentDestroyLease"] }) } as unknown as PluginWorkerManager;
  const runtime = environmentRuntimeService(db, { pluginWorkerManager: worker, orphanCleanupSpoolDir: spoolDir });
  await db.execute(sql`create function followup_reject_cleanup() returns trigger language plpgsql as $$ begin
    raise exception 'fixture all lease INSERT unavailable'; end $$`);
  await db.execute(sql`create trigger followup_reject_cleanup before insert on environment_leases for each row execute function followup_reject_cleanup()`);
  try {
    for (const namespace of ["account-a", "account-b"]) {
      const environment = { ...f.environment, config: { provider: "fixture-provider", namespace } };
      await expect(runtime.acquireRunLease({ ...f, environment, heartbeatRunId: null, issueId: null, persistedExecutionWorkspace: null })).rejects.toThrow();
    }
    expect((await readdir(spoolDir)).filter(name => name.endsWith(".json"))).toHaveLength(2);
    await db.execute(sql`drop trigger followup_reject_cleanup on environment_leases`);
    available = true;
    const consumer = restart ? environmentRuntimeService(db, { pluginWorkerManager: worker, orphanCleanupSpoolDir: spoolDir }) : runtime;
    await heartbeatService(db, { environmentRuntime: consumer }).sweepPendingCleanupLeases({ backoffMs: 0 });
    expect(destroyed.sort()).toEqual(["account-a", "account-b"]);
    expect(await readdir(spoolDir)).toHaveLength(0);
    expect(await db.select().from(environmentLeases).where(eq(environmentLeases.cleanupStatus, "success"))).toHaveLength(2);
  } finally {
    await db.execute(sql`drop trigger if exists followup_reject_cleanup on environment_leases`);
    await db.execute(sql`drop function followup_reject_cleanup()`);
    await rm(spoolDir, { recursive: true, force: true });
  }
});

it.each(["writer-first", "retirement-first"])("followup transaction acquires issue before run without caller locks (%s)", async ordering => {
  const f = await seed();
  const token = await reserveRunAcquisition(db, { ...f, heartbeatRunId: f.runId });
  const ready = gate(), release = gate();
  const input = { companyId: f.companyId, environmentId: f.environmentId, issueId: f.issueId,
    heartbeatRunId: f.runId, acquisitionReservationId: token, providerLeaseId: "transaction-resource" };
  if (ordering === "writer-first") {
    const writer = db.transaction(async tx => {
      // No issue or run lock taken by the fixture before the production call.
      const lease = await environmentService(tx as unknown as typeof db).acquireLease(input);
      ready.resolve(); await release.promise;
      return lease;
    });
    await ready.promise;
    const retirement = db.transaction(async tx => {
      await tx.select().from(issues).where(eq(issues.id, f.issueId)).for("update");
      const [run] = await tx.update(heartbeatRuns).set({ status: "interrupted", controllerLeaseExpiresAt: new Date(0) }).where(eq(heartbeatRuns.id, f.runId)).returning();
      await terminalizeLegacyExecution({ db: tx as unknown as typeof db, run: run!, status: "interrupted" });
      await settleUnrecoverableExecutions(tx as unknown as typeof db);
    });
    let waiting; try { waiting = await waitForLock(); } finally { release.resolve(); }
    const lease = await writer; await retirement;
    expect(waiting).toBe(true);
    expect(await environmentService(db).getLeaseById(lease.id)).toMatchObject({ status: "active" });
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId)))[0]?.status).toBe("active");
  } else {
    let runLockError: unknown;
    const retirement = db.transaction(async tx => {
      await tx.select().from(issues).where(eq(issues.id, f.issueId)).for("update");
      ready.resolve(); await release.promise;
      // NOWAIT measures the inversion directly rather than waiting for PG's
      // deadlock victim selection. Only the production writer can hold this row.
      try { await tx.execute(sql`select id from heartbeat_runs where id = ${f.runId} for update nowait`); }
      catch (error) { runLockError = error; return; }
      const [run] = await tx.update(heartbeatRuns).set({ status: "interrupted", controllerLeaseExpiresAt: new Date(0) }).where(eq(heartbeatRuns.id, f.runId)).returning();
      await terminalizeLegacyExecution({ db: tx as unknown as typeof db, run: run!, status: "interrupted" });
      await settleUnrecoverableExecutions(tx as unknown as typeof db);
    }).catch(error => { runLockError ??= error; });
    await ready.promise;
    const writer = db.transaction(tx => environmentService(tx as unknown as typeof db).acquireLease(input))
      .then(value => ({ value, error: null }), error => ({ value: null, error }));
    let waiting; try { waiting = await waitForLock(); } finally { release.resolve(); }
    await retirement;
    const outcome = await writer;
    expect(waiting).toBe(true);
    expect(runLockError).toBeUndefined();
    expect(outcome).toMatchObject({ value: null, error: expect.any(Error) });
    expect(await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, f.runId))).toHaveLength(0);
  }
});

it("serializes an actual NEW INSERT writer-first and preserves its active lease after terminalization", async () => {
  const f = await seed(), ready = gate(), release = gate();
  const [initial] = await db.update(heartbeatRuns).set({ status: "interrupted", controllerLeaseExpiresAt: new Date(0) }).where(eq(heartbeatRuns.id, f.runId)).returning();
  await terminalizeLegacyExecution({ db, run: initial!, status: "interrupted" });
  const writer = db.transaction(async tx => {
    await tx.select().from(issues).where(eq(issues.id, f.issueId)).for("update");
    await tx.update(heartbeatRuns).set({ status: "running", controllerLeaseExpiresAt: new Date(Date.now()+60000) }).where(eq(heartbeatRuns.id, f.runId));
    const svc = environmentService(tx as unknown as typeof db);
    const lease = await svc.acquireLease({ companyId: f.companyId, environmentId: f.environmentId, issueId: f.issueId, heartbeatRunId: f.runId, providerLeaseId: "writer-first-new" });
    const [terminal] = await tx.update(heartbeatRuns).set({ status: "interrupted", controllerLeaseExpiresAt: new Date(0) }).where(eq(heartbeatRuns.id, f.runId)).returning();
    await terminalizeLegacyExecution({ db: tx as unknown as typeof db, run: terminal!, status: "interrupted" });
    ready.resolve(); await release.promise; return lease;
  });
  await ready.promise;
  const settlement = settleUnrecoverableExecutions(db);
  let waiting; try { waiting = await waitForLock(); } finally { release.resolve(); }
  const lease = await writer; await settlement;
  expect(waiting).toBe(true);
  expect(await environmentService(db).getLeaseById(lease.id)).toMatchObject({ status: "active", providerLeaseId: "writer-first-new" });
  expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId)))[0]).toMatchObject({ status: "active" });
  expect(await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.runId))).toHaveLength(0);
});
it.each(["new", "reacquire"])("rejects the production %s writer queued behind settlement-first locks", async mode => {
  const f = await seed(); const leaseId = randomUUID();
  if (mode === "reacquire") await db.insert(environmentLeases).values({ id: leaseId, companyId: f.companyId, environmentId: f.environmentId, issueId: f.issueId, heartbeatRunId: f.runId, providerLeaseId: "existing", leasePolicy: "reuse_by_environment", status: "released", releasedAt: new Date(), cleanupStatus: "success", metadata: { agentId: f.agentId } });
  const [terminal] = await db.update(heartbeatRuns).set({ status: "interrupted", controllerLeaseExpiresAt: new Date(0) }).where(eq(heartbeatRuns.id, f.runId)).returning();
  await terminalizeLegacyExecution({ db, run: terminal!, status: "interrupted" });
  const held = gate(), release = gate();
  const settlement = db.transaction(async tx => {
    await settleUnrecoverableExecutions(tx as unknown as typeof db);
    held.resolve(); await release.promise;
  });
  await held.promise;
  const writer = environmentService(db).acquireLease({ companyId: f.companyId, environmentId: f.environmentId, issueId: f.issueId, heartbeatRunId: f.runId, providerLeaseId: mode === "new" ? "late-new" : "existing", leasePolicy: "reuse_by_environment", metadata: { agentId: f.agentId }, reusesReusableLeaseId: mode === "reacquire" ? leaseId : null });
  const outcome = writer.then(value => ({ value, error: null }), error => ({ value: null, error }));
  let waiting; try { waiting = await waitForLock(); } finally { release.resolve(); await settlement; }
  const result = await outcome; expect(waiting).toBe(true); expect(result.value).toBeNull(); expect(result.error).toBeTruthy();
  expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId)))[0]).toMatchObject({ status: "resolved", outcome: "cancelled", evidence: { conversationDisposition: { runId: f.runId } } });
  const leases = await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, f.runId));
  expect(leases.filter(l => l.status === "active")).toHaveLength(0);
  expect(leases).toHaveLength(mode === "new" ? 0 : 1);
  expect(await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.runId))).toHaveLength(0);
});
it("does not allow ordinary release to clear an unknown pre-RPC reservation", async () => {
  const f = await seed();
  const id = await reserveRunAcquisition(db, { companyId: f.companyId, environmentId: f.environmentId, issueId: f.issueId, heartbeatRunId: f.runId });
  await environmentService(db).releaseLease(id!, "expired", { cleanupStatus: "success" });
  const [terminal] = await db.update(heartbeatRuns).set({ status: "interrupted", controllerLeaseExpiresAt: new Date(0) }).where(eq(heartbeatRuns.id, f.runId)).returning();
  await terminalizeLegacyExecution({ db, run: terminal!, status: "interrupted" });
  await settleUnrecoverableExecutions(db);
  expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId)))[0]).toMatchObject({ status: "active" });
  const [reservedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
  expect(reservedRun!.runnerProfileJson?.runAcquisition).toMatchObject({ token: id, state: "pending", generation: 1 });
  expect(await environmentService(db).getLeaseById(id!)).toBeNull();
});
it("holds a paused actual same-run sandbox resume after controller authority expires", async () => {
  const f = await seed("sandbox");
  f.environment.config = { provider: "fixture-provider", reuseLease: true };
  await db.update(environments).set({ config: f.environment.config }).where(eq(environments.id, f.environmentId));
  const [plugin] = await db.select().from(plugins);
  await db.update(plugins).set({ manifestJson: { ...plugin!.manifestJson!, environmentDrivers: [{
    driverKey: "fixture-provider", kind: "sandbox_provider", displayName: "Fixture", supportsReusableLeases: true,
    configSchema: { type: "object" },
  }] } }).where(eq(plugins.id, plugin!.id));
  const entered = gate(), release = gate();
  const call = vi.fn(async (_: string, method: string) => {
    if (method === "environmentAcquireLease") return { providerLeaseId: "same-resource", metadata: { remoteCwd: "/workspace" } };
    if (method === "environmentResumeLease") { entered.resolve(); await release.promise; return { providerLeaseId: "same-resource", metadata: { remoteCwd: "/workspace" } }; }
    throw new Error(`Unexpected method ${method}`);
  });
  const runtime = environmentRuntimeService(db, { pluginWorkerManager: { isRunning: () => true, call,
    getWorker: () => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] }) } as unknown as PluginWorkerManager });
  const input = { ...f, heartbeatRunId: f.runId, expectedControllerBootId: f.bootId, persistedExecutionWorkspace: null, adapterType: "codex_local" };
  const first = await runtime.acquireRunLease(input);
  await environmentService(db).releaseLease(first.lease.id, "released");
  const resumed = runtime.acquireRunLease(input).then(value => ({ value, error: null }), error => ({ value: null, error }));
  await entered.promise;
  try {
    const [terminal] = await db.update(heartbeatRuns).set({ status: "interrupted", controllerLeaseExpiresAt: new Date(0) }).where(eq(heartbeatRuns.id, f.runId)).returning();
    await terminalizeLegacyExecution({ db, run: terminal!, status: "interrupted" });
    await settleUnrecoverableExecutions(db);
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId)))[0]?.status).toBe("active");
  } finally { release.resolve(); }
  expect(await resumed).toMatchObject({ value: null, error: expect.any(Error) });
  const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
  expect(run!.runnerProfileJson?.runAcquisition).toMatchObject({ state: "unknown", generation: 2 });
  expect(await environmentService(db).getLeaseById(first.lease.id)).toMatchObject({ status: "released" });
  expect(call.mock.calls.map(([, method]) => method)).toEqual(["environmentAcquireLease", "environmentResumeLease"]);
  await settleUnrecoverableExecutions(db);
  expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId)))[0]?.status).toBe("active");
  await assertNoDispatch(f, call);
});
it("rejects a stale caller boot before any provider RPC", async () => {
  const f = await seed();
  const call = vi.fn();
  const runtime = environmentRuntimeService(db, { pluginWorkerManager: { isRunning: () => true, call } as unknown as PluginWorkerManager });
  await expect(runtime.acquireRunLease({ ...f, heartbeatRunId: f.runId, expectedControllerBootId: randomUUID(), persistedExecutionWorkspace: null })).rejects.toThrow("authority lost");
  expect(call).not.toHaveBeenCalled();
  await assertNoDispatch(f, call);
});
it("does not allocate a second generic resource for the same active run", async () => {
  const f = await seed();
  const call = vi.fn(async () => ({ providerLeaseId: "only-resource" }));
  const runtime = environmentRuntimeService(db, { pluginWorkerManager: { isRunning: () => true, call, getWorker: () => ({ supportedMethods: [] }) } as unknown as PluginWorkerManager });
  const input = { ...f, heartbeatRunId: f.runId, persistedExecutionWorkspace: null };
  const first = await runtime.acquireRunLease(input);
  await expect(runtime.acquireRunLease(input)).rejects.toThrow("active lease");
  expect(call).toHaveBeenCalledTimes(1);
  expect((await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, f.runId))).map(lease => lease.id)).toEqual([first.lease.id]);
});
it("allows same-run retry after a proven pre-RPC worker failure", async () => {
  const f = await seed();
  let ready = false;
  const call = vi.fn(async () => ({ providerLeaseId: "repaired-resource" }));
  const runtime = environmentRuntimeService(db, { pluginWorkerManager: { isRunning: () => ready, call, getWorker: () => ({ supportedMethods: [] }) } as unknown as PluginWorkerManager });
  const input = { ...f, heartbeatRunId: f.runId, persistedExecutionWorkspace: null };
  await expect(runtime.acquireRunLease(input)).rejects.toThrow();
  expect(call).not.toHaveBeenCalled();
  ready = true;
  await expect(runtime.acquireRunLease(input)).resolves.toMatchObject({ lease: { providerLeaseId: "repaired-resource", status: "active" } });
  expect(call).toHaveBeenCalledTimes(1);
});
it("publishes exactly one NEW usable owner and consumes its durable generation", async () => {
  const f = await seed();
  const call = vi.fn(async (_: string, method: string) => { expect(method).toBe("environmentAcquireLease"); return { providerLeaseId: "current-resource", metadata: { effectiveAdapterType: "codex_local" } }; });
  const runtime = environmentRuntimeService(db, { pluginWorkerManager: { isRunning: () => true, call, getWorker: () => ({ supportedMethods: [] }) } as unknown as PluginWorkerManager });
  const result = await runtime.acquireRunLease({ ...f, heartbeatRunId: f.runId, expectedControllerBootId: f.bootId, persistedExecutionWorkspace: null, adapterType: "codex_local" });
  expect(result.lease).toMatchObject({ status: "active", providerLeaseId: "current-resource" });
  const leases = await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, f.runId));
  expect(leases.filter(l => l.status === "active")).toHaveLength(1);
  const [publishedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
  const reservation = publishedRun!.runnerProfileJson!.runAcquisition as { token: string };
  expect(reservation).toMatchObject({ generation: 1, state: "published", leaseId: result.lease.id, controllerBootId: f.bootId });
  expect(leases).toHaveLength(1);
  await expect(environmentService(db).acquireLease({ companyId: f.companyId, environmentId: f.environmentId, issueId: f.issueId, heartbeatRunId: f.runId, acquisitionReservationId: reservation.token, providerLeaseId: "duplicate" })).rejects.toThrow("generation");
  expect((await db.select().from(environmentLeases).where(and(eq(environmentLeases.heartbeatRunId, f.runId), eq(environmentLeases.status, "active"))))).toHaveLength(1);
  await assertNoDispatch(f, call);
});
