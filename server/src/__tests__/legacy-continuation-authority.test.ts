import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, agentWakeupRequests, companies, createDb, heartbeatRuns, issueComments, issueRecoveryActions, issueThreadInteractions, issues } from "@paperclipai/db";
import { recoveryService } from "../services/recovery/service.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

describe("legacy continuation persisted authority", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { temporary = await startEmbeddedPostgresTestDatabase("legacy-authority-"); db = createDb(temporary.connectionString); });
  afterAll(async () => { await db?.$client.end({ timeout: 0 }); await temporary?.cleanup(); });
  async function fixture(context: Record<string, unknown> = {}, continuationAttempt = 0) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Authority fixture", issuePrefix: `A${companyId.slice(0, 6)}`, defaultResponsibleUserId: "fixture-owner" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", role: "engineer", status: "idle", adapterType: "codex_local", runtimeConfig: { heartbeat: { wakeOnDemand: true } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Implement export", status: "in_progress", assigneeAgentId: agentId, responsibleUserId: "fixture-owner" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", status: "succeeded", runtimeMode: "legacy", continuationAttempt, contextSnapshot: { issueId, ...context }, livenessState: "blocked", resultJson: { summary: "All done. Need approval. I will continue." } });
    const createRecovery = () => recoveryService(db, {
      enqueueWakeup: async (targetAgentId, opts) => db.transaction(async tx => {
        const [wake] = await tx.insert(agentWakeupRequests).values({ companyId, agentId: targetAgentId, source: "automation", reason: opts?.reason, payload: opts?.payload, idempotencyKey: opts?.idempotencyKey, status: "queued" }).returning();
        const [run] = await tx.insert(heartbeatRuns).values({ companyId, agentId: targetAgentId, invocationSource: "automation", status: "queued", runtimeMode: "legacy", wakeupRequestId: wake.id, contextSnapshot: opts?.contextSnapshot }).returning();
        await tx.update(agentWakeupRequests).set({ runId: run.id }).where(eq(agentWakeupRequests.id, wake.id));
        return run;
      }),
    });
    const runs = () => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    const actions = () => db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, companyId));
    async function finish(run: typeof heartbeatRuns.$inferSelect) {
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, run.id));
      if (run.wakeupRequestId) await db.update(agentWakeupRequests).set({ status: "completed" }).where(eq(agentWakeupRequests.id, run.wakeupRequestId));
    }
    return { companyId, agentId, issueId, runId, createRecovery, runs, actions, finish };
  }
  it.each([1, 2, 3, 4, 5])("deduplicates concurrent replay with stale prose-derived liveness (%s)", async () => {
    const f = await fixture();
    const recovery = f.createRecovery();
    await Promise.all([recovery.reconcileLegacyContinuation(f.runId), recovery.reconcileLegacyContinuation(f.runId)]);
    expect(await f.runs()).toHaveLength(2);
    expect(await f.actions()).toHaveLength(1);
    await f.createRecovery().reconcileLegacyContinuation(f.runId);
    expect(await f.runs()).toHaveLength(2);
    const repair = (await f.runs()).find(r => r.id !== f.runId)!;
    expect(repair.contextSnapshot).toMatchObject({ legacyDispositionEpisode: { id: f.runId, attempt: 1, maxAttempts: 2 } });
  });
  it("keeps the same bounded episode across restart and commentary, then escalates only after agent attempts", async () => {
    const f = await fixture();
    await f.createRecovery().reconcileLegacyContinuation(f.runId);
    const first = (await f.runs()).find(r => r.id !== f.runId)!;
    await f.finish(first);
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorAgentId: f.agentId, body: "I will continue; all done; no approval required." });
    await f.createRecovery().reconcileLegacyContinuation(first.id);
    const second = (await f.runs()).find(r => r.status === "scheduled_retry")!;
    expect(second.contextSnapshot).toMatchObject({ legacyDispositionEpisode: { id: f.runId, attempt: 2, maxAttempts: 2 } });
    await f.finish(second);
    expect(await f.createRecovery().reconcileLegacyContinuation(second.id)).toBe("escalated");
    expect(await f.runs()).toHaveLength(3);
    expect((await f.actions()).find(a => a.status === "active")).toMatchObject({ ownerType: "board", attemptCount: 2 });
    await f.createRecovery().reconcileLegacyContinuation(second.id);
    expect(await f.runs()).toHaveLength(3);
  });
  it("does not grant a new budget to exhausted pre-upgrade continuation", async () => {
    const f = await fixture({}, 2);
    expect(await f.createRecovery().reconcileLegacyContinuation(f.runId)).toBe("escalated");
    expect(await f.runs()).toHaveLength(1);
  });
  it.each(["done", "cancelled", "blocked", "in_review"])("honors durable %s instead of the final summary", async status => {
    const f = await fixture();
    await db.update(issues).set({ status }).where(eq(issues.id, f.issueId));
    expect(await f.createRecovery().reconcileLegacyContinuation(f.runId)).toBe("skipped");
    expect(await f.runs()).toHaveLength(1);
  });
  it("respects a pending approval while the issue still says in progress", async () => {
    const f = await fixture();
    await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issueId, kind: "request_confirmation", status: "pending", requestedResolverPolicy: "anyone", effectiveResolverPolicy: "anyone", payload: { version: 1, prompt: "Approve?" } });
    expect(await f.createRecovery().reconcileLegacyContinuation(f.runId)).toBe("skipped");
    expect(await f.runs()).toHaveLength(1);
  });
  it("rechecks a newly pending approval at dispatch without spending another attempt", async () => {
    const f = await fixture();
    await f.createRecovery().reconcileLegacyContinuation(f.runId);
    const repair = (await f.runs()).find(r => r.id !== f.runId)!;
    expect(await f.createRecovery().legacyRepairDispatchBlock(repair.id)).toBeNull();
    await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issueId, kind: "request_confirmation", status: "pending", requestedResolverPolicy: "anyone", effectiveResolverPolicy: "anyone", payload: { version: 1, prompt: "Approve?" } });
    expect(await f.createRecovery().legacyRepairDispatchBlock(repair.id)).toBe("durable_wait");
    expect((await f.actions())[0].attemptCount).toBe(1);
  });
  it.each(["done", "paused", "reassigned", "stopped"])("suppresses a queued repair after %s", async gate => {
    const f = await fixture();
    await f.createRecovery().reconcileLegacyContinuation(f.runId);
    const repair = (await f.runs()).find(r => r.id !== f.runId)!;
    if (gate === "done") await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId));
    if (gate === "paused") await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agentId));
    if (gate === "reassigned") await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, f.issueId));
    if (gate === "stopped") await db.update(heartbeatRuns).set({ status: "cancelled", errorCode: "operator_cancelled" }).where(eq(heartbeatRuns.id, repair.id));
    expect(await f.createRecovery().legacyRepairDispatchBlock(repair.id)).not.toBeNull();
    expect((await f.actions())[0].attemptCount).toBe(1);
  });
  it("leaves a due monitor as the owner of the next step", async () => {
    const f = await fixture();
    await db.update(issues).set({ monitorNextCheckAt: new Date(0) }).where(eq(issues.id, f.issueId));
    expect(await f.createRecovery().reconcileLegacyContinuation(f.runId)).toBe("skipped");
    expect(await f.runs()).toHaveLength(1);
  });
  it("honors pause and changed ownership without spending a repair attempt", async () => {
    const f = await fixture();
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agentId));
    expect(await f.createRecovery().reconcileLegacyContinuation(f.runId)).toBe("skipped");
    expect(await f.actions()).toHaveLength(0);
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, f.agentId));
    await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, f.issueId));
    expect(await f.createRecovery().reconcileLegacyContinuation(f.runId)).toBe("skipped");
    expect(await f.runs()).toHaveLength(1);
  });
  it("the delayed sweep ignores old diagnostic labels and uses the same repair path", async () => {
    const f = await fixture();
    await f.createRecovery().reconcileStrandedAssignedIssues({ companyId: f.companyId });
    expect(await f.runs()).toHaveLength(2);
    const repair = (await f.runs()).find(r => r.id !== f.runId)!;
    expect(repair.contextSnapshot).toMatchObject({ legacyDispositionEpisode: { id: f.runId, attempt: 1 } });
  });
});
