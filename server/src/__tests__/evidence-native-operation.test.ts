import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { nativeEvidenceFixture } from "./helpers/native-evidence-fixture.js";
import { documentService } from "../services/documents.js";
import { executeNativeSession } from "../../../packages/paperclip-runner/src/native-session-runtime.js";
import type { NativeSession, NativeSessionBackend } from "../../../packages/paperclip-runner/src/contracts/native-session-backend.js";
import type { NativeExecutionInputV1 } from "../../../packages/paperclip-runner/src/contracts/native-execution.js";
import { admitEvidencePackRun, revalidateEvidenceOperation } from "../services/evidence-pack.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

describe("native evidence operation admission after asynchronous preparation", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("evidence-native-operation-"); db = createDb(database.connectionString); }, 120000);
  afterAll(async () => { await database?.cleanup(); });

  type Path = "fresh" | "attach" | "recover";
  // Ownership/running-state loss is evidence-gated only for opted-in issues; a
  // no-pack run keeps its previous behavior (opt-in invariant).
  const faults = ["no_pack", "valid_pack", "late_opt_in", "removed", "rebound", "artifact", "context", "expiry", "cancelled", "owner_changed", "no_pack_cancelled", "no_pack_owner_changed"];
  it.each(faults)("fresh backend barrier: %s", async fault => { await scenario("fresh", fault); });
  // Retained attach and provider recovery have no fresh openSession; the
  // asynchronous preparation barrier sits in the durable launch callback.
  it.each(faults.flatMap(fault => (["attach", "recover"] as const).map(path => [path, fault] as const)))("%s barrier: %s", async (path, fault) => { await scenario(path, fault); });

  async function scenario(path: Path, fault: string) {
    const invalidate = !["no_pack", "valid_pack", "no_pack_cancelled", "no_pack_owner_changed"].includes(fault);
    const companyId = randomUUID(), issueId = randomUUID(), agentId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "A1 isolated", issuePrefix: `A${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Executor", role: "engineer", status: "running", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "A1", status: "in_progress", assigneeAgentId: agentId });
    const evidence = ["no_pack", "late_opt_in", "no_pack_cancelled", "no_pack_owner_changed"].includes(fault) ? null : await nativeEvidenceFixture(db, { companyId, issueId, agentId }, fault === "expiry" ? new Date(Date.now() + 2000).toISOString() : undefined);
    const [run] = await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native", nativeIssueId: issueId,
      contextSnapshot: { paperclipEnvironment: { driver: "local" } }, runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" } } }).returning();
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const admission = async () => { await db.transaction(tx => admitEvidencePackRun(tx, run!, true)); };
    await admission(); // Real server admission at the old handoff, not a provider call.
    const entered = barrier(), ready = barrier(), turned = barrier();
    const identity = { companyId, issueId, agentId, runId, sessionId: randomUUID() };
    const capabilities = { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true };
    const result = { schema: "paperclip.run_result.v1" as const, reportedWorkDisposition: "done" as const, summary: "one turn", completionClaim: { contractRevision: "1", objectiveSatisfied: true, criteria: [{ criterionId: "objective", status: "satisfied" as const, evidenceRefs: [] }], remainingWork: [] }, evidence: [], verification: [], attentionRequests: [], artifacts: [] };
    const terminal = { schema: "paperclip.prp.terminal.v1" as const, turnTerminalState: "completed" as const, runTerminalState: "succeeded" as const, reportedWorkDisposition: "done" as const };
    const startTurn = vi.fn(async () => { turned.release(); return { turnId: "turn-a1" }; });
    const attachRun = vi.fn(async () => {});
    const close = vi.fn(async () => { turned.release(); });
    const session: NativeSession = {
      identity: () => identity, async capabilities() { return capabilities; }, startTurn, close, attachRun,
      cancel() { turned.release(); return { cleanup: Promise.resolve() }; },
      async *events() {
        await turned.promise;
        yield { schema: "paperclip.prp.event.v1", sourceEventId: "a1:1", sourceSeq: 1, sourceInstanceId: "a1-runner", sourceKind: "runner", runId, normalizedSessionId: identity.sessionId, turnId: "turn-a1", eventType: "turn.completed", schemaVersion: 1, priority: 0, emittedAt: new Date().toISOString(), payload: {} };
      },
      async snapshot() { return { backendKind: "mock", sessionId: "driver-a1", identity, providerSessionId: "provider-a1", cursor: null, activeTurnId: null, pendingRuntimeRequests: [], lineage: [] }; },
      async result() { return { result, terminal, turnId: "turn-a1" }; },
    };
    const backend: NativeSessionBackend = {
      async descriptor() { return { kind: "mock", name: "delayed-a1", version: "1", capabilities }; },
      async openSession() { if (path !== "fresh") throw new Error("unexpected fresh session"); entered.release(); await ready.promise; return session; },
      ...(path === "recover" ? { recoverSession: vi.fn(async () => ({ recovered: true as const, session })) } : {}),
    };
    const checkpoint = { backendKind: "mock" as const, sessionId: "driver-a1", identity, providerSessionId: "provider-a1", cursor: null, activeTurnId: null, pendingRuntimeRequests: [], lineage: [] };
    const input: NativeExecutionInputV1 = {
      schema: "paperclip.native-execution-input.v1", binding: { companyId, issueId, agentId, runId, executionWorkspaceId: "workspace-a1" },
      task: { identifier: "A1", title: "A1", description: null, prompt: "Bound execution", workMode: "standard" },
      workspace: { cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: identity.sessionId, driverKind: "codex_app_server", protocolVersion: 1 }, provider: { kind: "codex", model: null },
      completionContract: { id: "a1", sha256: "a1", schemaVersion: "paperclip.completion-contract.v1", contract: { revision: "1", objective: "Bound execution", criteria: [{ id: "objective", requirement: "one turn" }] } }, interactionResponses: [], credentialBindings: [],
    };
    const completeRun = vi.fn(async () => {});
    const options = {
      input, backend, onOperationAdmission: () => revalidateEvidenceOperation(db, input.binding),
      onSessionAdmission: async () => { await admission(); if (path !== "fresh") { entered.release(); await ready.promise; } },
      ...(path === "attach" ? { existingSession: session } : {}),
      ...(path === "recover" ? { persistedSession: checkpoint } : {}),
      runnerInstanceId: "a1-runner", controlPlaneInstanceId: "a1-control",
      controlPlane: { async openRun() {}, async checkpointSession() {}, completeRun,
        async appendEvent(event: { sourceSeq: number }) { return { cursor: event.sourceSeq, highestContiguousSourceSeq: event.sourceSeq, disposition: "committed" as const }; },
        async replayEvents() { return { events: [], highestContiguousSourceSeq: 0 }; },
      },
    };
    const execution = executeNativeSession(options).then(value => ({ value, error: null }), error => ({ value: null, error }));
    await Promise.race([entered.promise, execution.then(outcome => { throw outcome.error ?? new Error("completed before backend barrier"); })]);
    try {
      if (fault === "late_opt_in" || fault === "rebound") await db.update(issues).set({ executionPolicy: { evidencePack: { schemaVersion: 1, documentId: randomUUID(), revisionId: randomUUID(), scope: { action: "implement", target: "a1", exclusions: [] }, receipts: [randomUUID()] } } }).where(eq(issues.id, issueId));
      if (fault === "removed") await db.update(issues).set({ executionPolicy: null }).where(eq(issues.id, issueId));
      if (fault === "cancelled" || fault === "no_pack_cancelled") await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, runId));
      if (fault === "owner_changed" || fault === "no_pack_owner_changed") await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, issueId));
      if (fault === "artifact" || fault === "context") {
        const ref = evidence![fault];
        await documentService(db).upsertIssueDocument({ issueId, key: ref.key, format: "markdown", body: "Changed during setup", baseRevisionId: ref.revisionId });
      }
      if (fault === "expiry") {
        // Advance real elapsed DB time, not the application clock or proof bytes.
        await db.execute(sql`select pg_sleep(greatest(0, extract(epoch from (${evidence!.expiresAt}::timestamptz - clock_timestamp()))) + 0.01)`);
      }
    } finally { ready.release(); }
    const outcome = await execution;
    expect(startTurn).toHaveBeenCalledTimes(invalidate ? 0 : 1);
    if (path === "attach") expect(attachRun).toHaveBeenCalledTimes(invalidate ? 0 : 1);
    if (path === "recover") expect(backend.recoverSession).toHaveBeenCalledTimes(invalidate ? 0 : 1);
    // Denied before attach/recovery, no provider session belongs to this run:
    // the retained session was never attached and recovery never ran.
    expect(close).toHaveBeenCalledTimes(path === "fresh" || !invalidate ? 1 : 0);
    if (invalidate) {
      const code = fault === "removed" ? "evidence_pack_admission_changed" : fault === "expiry" ? "evidence_pack_expired" : ["cancelled", "owner_changed"].includes(fault) ? "evidence_pack_run_mismatch" : "evidence_pack_stale";
      expect(outcome.error).toMatchObject({ message: "Evidence pack blocks execution", details: { code } });
      expect(completeRun).not.toHaveBeenCalled();
    } else { expect(outcome.error).toBeNull(); expect(completeRun).toHaveBeenCalledOnce(); }
  }

  it("does not lock or deny a no-pack run that does not own the issue execution", async () => {
    const companyId = randomUUID(), issueId = randomUUID(), agentId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "No pack", issuePrefix: `N${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Mentioned", role: "engineer", status: "running", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "No pack", status: "in_progress" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native", nativeIssueId: issueId, contextSnapshot: { issueId } });
    // A concurrent writer holds the issue row: legacy recovery must not wait on it.
    const held = barrier(), locked = barrier();
    const writer = db.transaction(async (tx) => {
      await tx.select().from(issues).where(eq(issues.id, issueId)).for("update");
      locked.release(); await held.promise;
    });
    await locked.promise;
    try {
      const outcome = await Promise.race([
        revalidateEvidenceOperation(db, { companyId, issueId, agentId, runId }).then(() => "admitted", (e: unknown) => e),
        new Promise((r) => setTimeout(() => r("blocked"), 2000)),
      ]);
      expect(outcome).toBe("admitted");
    } finally { held.release(); await writer; }
    const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(row.runnerProfileJson?.evidenceAdmission).toBeUndefined();
  });
});
