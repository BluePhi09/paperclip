import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issueThreadInteractions, issues, documents, documentRevisions } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { documentService } from "../services/documents.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { heartbeatService } from "../services/heartbeat.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";

// Never connects to a configured/live instance: fresh embedded PostgreSQL only.
describe("evidence pack at the issue execution boundary", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("paperclip-evidence-pack-"); db = createDb(database.connectionString); }, 120000);
  afterAll(async () => { await database?.cleanup(); });

  async function fixture() {
    const companyId = randomUUID(), issueId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Evidence fixture", issuePrefix: `E${companyId.slice(0, 6)}`, requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "local-board" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Implementer", role: "engineer", status: "idle", adapterType: "process" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Bound execution", status: "todo", assigneeAgentId: agentId, executionPolicy: { evidencePack: { schemaVersion: 1, documentId: randomUUID(), revisionId: randomUUID(), scope: { action: "implement", target: "example.test/demo", exclusions: ["deploy"] }, receipts: [randomUUID()] } } });
    return { companyId, issueId, agentId };
  }
  async function reviewedFixture(options: { condition?: boolean; prerequisite?: boolean; expired?: boolean; environmentDriver?: string; expiresInMs?: number } = {}) {
    const f = await fixture();
    const reviewers = [randomUUID(), randomUUID()];
    await db.insert(agents).values(reviewers.map((id, i) => ({ id, companyId: f.companyId, name: `Reviewer ${i}`, role: "engineer", status: "idle", adapterType: "process" })));
    const doc = async (key: string, body: string) => {
      const { document: d } = await documentService(db).upsertIssueDocument({ issueId: f.issueId, key, format: "markdown", body, createdByAgentId: f.agentId });
      return { issueId: f.issueId, key, documentId: d.id, revisionId: d.latestRevisionId! };
    };
    const artifact = await doc("plan", "Noncredential implementation plan");
    const policySource = await doc("review-policy", "Two independent reviews. Deploy excluded.");
    const scope = { action: "implement", target: "example.test/demo", exclusions: ["deploy"] };
    const conditions = options.condition ? [{ id: "check", proof: await doc("condition-proof", "Verified read-only check in target context"), reviewerAgentId: reviewers[0], receiptId: randomUUID() }] : [];
    const prerequisiteIssueIds = options.prerequisite ? [randomUUID()] : [];
    if (options.prerequisite) {
      const issueId = prerequisiteIssueIds[0];
      await db.insert(issues).values({ id: issueId, companyId: f.companyId, title: "Mandatory separate pre-review", status: "todo" });
      const { document } = await documentService(db).upsertIssueDocument({ issueId, key: "review-result", format: "markdown", body: "Independent pre-review passed", createdByAgentId: f.agentId });
      const proof = { issueId, key: "review-result", documentId: document.id, revisionId: document.latestRevisionId! };
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: reviewers[0], status: "running", runtimeMode: "native", nativeIssueId: issueId });
      const svc = issueThreadInteractionService(db);
      const card = await svc.create({ id: issueId, companyId: f.companyId }, { kind: "request_confirmation", resolverPolicy: "not_creator", addresseeAgentId: reviewers[0], payload: { version: 1, prompt: "Accept independent prerequisite evidence?", target: { type: "issue_document", ...proof } } }, { agentId: f.agentId });
      await svc.acceptInteraction({ id: issueId, companyId: f.companyId, projectId: null, goalId: null, status: "todo" }, card.id, {}, { agentId: reviewers[0], runId });
      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, runId));
      conditions.push({ id: "prerequisite", proof, reviewerAgentId: reviewers[0], receiptId: card.id });
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
    }
    const pack = { schemaVersion: 1, subjectIssueId: f.issueId, purpose: "execution_authorization", scope, policySource,
      artifacts: [artifact], requiredReviewerAgentIds: reviewers, prerequisiteIssueIds, conditions,
      freshness: { context: await doc("target-context", JSON.stringify({ target: scope.target, adapterType: "evidence_test", environmentId: options.environmentDriver === "sandbox" ? randomUUID() : null, environmentDriver: options.environmentDriver ?? "local", executionWorkspaceId: null })), expiresAt: new Date(Date.now() + (options.expired ? -1000 : options.expiresInMs ?? 3600000)).toISOString() } };
    const packRef = await doc("evidence-pack", JSON.stringify(pack));
    const receipts: string[] = [], runs: string[] = [];
    for (const reviewer of reviewers) {
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: reviewer, status: "running", runtimeMode: "native", invocationSource: "manual", nativeIssueId: f.issueId, contextSnapshot: { issueId: f.issueId } });
      const svc = issueThreadInteractionService(db);
      const card = await svc.create({ id: f.issueId, companyId: f.companyId }, {
        kind: "request_confirmation", resolverPolicy: "not_creator", addresseeAgentId: reviewer,
        payload: { version: 1, prompt: "Accept this exact execution pack?", target: { type: "issue_document", ...packRef } },
      }, { agentId: f.agentId });
      const accepted = await svc.acceptInteraction({ id: f.issueId, companyId: f.companyId, projectId: null, goalId: null, status: "todo" }, card.id, {}, { agentId: reviewer, runId });
      expect(accepted.interaction.status).toBe("accepted");
      receipts.push(card.id); runs.push(runId);
    }
    for (const condition of conditions.filter((c) => c.id !== "prerequisite")) {
      const svc = issueThreadInteractionService(db);
      const card = await svc.create({ id: f.issueId, companyId: f.companyId }, {
        kind: "request_confirmation", resolverPolicy: "not_creator", addresseeAgentId: condition.reviewerAgentId,
        payload: { version: 1, prompt: "Accept this exact condition proof?", target: { type: "issue_document", ...condition.proof } },
      }, { agentId: f.agentId });
      await svc.acceptInteraction({ id: f.issueId, companyId: f.companyId, projectId: null, goalId: null, status: "todo" }, card.id, {}, { agentId: condition.reviewerAgentId, runId: runs[0] });
      // The pack was written before the native receipt existed. Rebind it below.
      condition.receiptId = card.id;
    }
    if (conditions.length) {
      const revised = await documentService(db).upsertIssueDocument({ issueId: f.issueId, key: "evidence-pack", format: "markdown", body: JSON.stringify(pack), baseRevisionId: packRef.revisionId, createdByAgentId: f.agentId });
      packRef.revisionId = revised.document.latestRevisionId!;
      // Refresh native pack votes for the new revision, never fabricate accepted rows.
      receipts.length = 0;
      for (const [i, reviewer] of reviewers.entries()) {
        const svc = issueThreadInteractionService(db);
        const card = await svc.create({ id: f.issueId, companyId: f.companyId }, { kind: "request_confirmation", resolverPolicy: "not_creator", addresseeAgentId: reviewer,
          payload: { version: 1, prompt: "Accept the final pack revision?", target: { type: "issue_document", ...packRef } } }, { agentId: f.agentId });
        await svc.acceptInteraction({ id: f.issueId, companyId: f.companyId, projectId: null, goalId: null, status: "todo" }, card.id, {}, { agentId: reviewer, runId: runs[i] });
        receipts.push(card.id);
      }
    }
    for (const runId of runs) await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, runId));
    const binding = { schemaVersion: 1, documentId: packRef.documentId, revisionId: packRef.revisionId, scope, receipts };
    await db.update(issues).set({ executionPolicy: { evidencePack: binding } }).where(eq(issues.id, f.issueId));
    return { ...f, reviewers, pack, packRef, artifact, policySource, binding, receipts, runs };
  }
  it.each(["unreviewed", "changed_proof", "separate_prereview"])("does not infer condition fulfillment from task disposition: %s", async (fault) => {
    const f = await reviewedFixture({ condition: true, prerequisite: true });
    const c = f.pack.conditions[0];
    if (fault === "unreviewed") await db.update(issueThreadInteractions).set({ status: "pending", result: null }).where(eq(issueThreadInteractions.id, c.receiptId));
    if (fault === "changed_proof") await documentService(db).upsertIssueDocument({ issueId: c.proof.issueId, key: c.proof.key, format: "markdown", body: "Context changed", baseRevisionId: c.proof.revisionId });
    if (fault === "separate_prereview") await db.update(issues).set({ status: "todo" }).where(eq(issues.id, f.pack.prerequisiteIssueIds[0]));
    const error = await issueService(db).update(f.issueId, { status: "in_progress", actorUserId: "local-board" }).then(() => null, (e: Error) => e.message);
    expect(error).toEqual(expect.stringContaining("Evidence pack"));
  });
  it("accepts current independently reviewed conditions without dropping separate pre-review", async () => {
    const f = await reviewedFixture({ condition: true, prerequisite: true });
    expect((await issueService(db).update(f.issueId, { status: "in_progress", actorUserId: "local-board" }))?.status).toBe("in_progress");
  });
  it.each(["artifact", "policy", "scope", "subject"])("revalidates current revision and exact authorization: %s", async (fault) => {
    const f = await reviewedFixture();
    if (fault === "artifact" || fault === "policy") {
      const ref = fault === "artifact" ? f.artifact : f.policySource;
      await documentService(db).upsertIssueDocument({ issueId: ref.issueId, key: ref.key, format: "markdown", body: "Changed after review", baseRevisionId: ref.revisionId });
    }
    if (fault === "scope") await db.update(issues).set({ executionPolicy: { evidencePack: { ...f.binding, scope: { ...f.binding.scope, action: "deploy" } } } }).where(eq(issues.id, f.issueId));
    if (fault === "subject") {
      const revised = await documentService(db).upsertIssueDocument({ issueId: f.issueId, key: "evidence-pack", format: "markdown", body: JSON.stringify({ ...f.pack, subjectIssueId: randomUUID() }), baseRevisionId: f.packRef.revisionId });
      await db.update(issues).set({ executionPolicy: { evidencePack: { ...f.binding, revisionId: revised.document.latestRevisionId } } }).where(eq(issues.id, f.issueId));
    }
    const error = await issueService(db).update(f.issueId, { status: "in_progress", actorUserId: "local-board" }).then(() => null, (e: Error) => e.message);
    expect(error).toContain("Evidence pack");
  });
  it.each(["wrong_run", "wrong_company", "self_review", "wrong_target", "human_vote", "rejected"])("rejects an invalid required reviewer receipt: %s", async (fault) => {
    const f = await reviewedFixture();
    if (fault === "wrong_run") await db.update(issueThreadInteractions).set({ resolvedByRunId: f.runs[0] }).where(eq(issueThreadInteractions.id, f.receipts[1]));
    if (fault === "wrong_company") { const other = await fixture(); await db.update(heartbeatRuns).set({ companyId: other.companyId }).where(eq(heartbeatRuns.id, f.runs[1])); }
    if (fault === "self_review") await db.update(issueThreadInteractions).set({ createdByAgentId: f.reviewers[1] }).where(eq(issueThreadInteractions.id, f.receipts[1]));
    if (fault === "wrong_target") await db.update(issueThreadInteractions).set({ payload: { title: "Wrong target", confirmLabel: "Accept", target: { type: "issue_document", ...f.artifact } } }).where(eq(issueThreadInteractions.id, f.receipts[1]));
    if (fault === "human_vote") await db.update(issueThreadInteractions).set({ resolvedByUserId: "local-board" }).where(eq(issueThreadInteractions.id, f.receipts[1]));
    if (fault === "rejected") await db.update(issueThreadInteractions).set({ result: { outcome: "rejected" } }).where(eq(issueThreadInteractions.id, f.receipts[1]));
    await expect(issueService(db).update(f.issueId, { status: "in_progress", actorUserId: "local-board" })).rejects.toThrow("Evidence pack");
  });
  it("rejects duplicate condition IDs before proof provenance can be overwritten", async () => {
    const f = await reviewedFixture({ condition: true });
    const c = f.pack.conditions[0];
    const second = await documentService(db).upsertIssueDocument({ issueId: f.issueId, key: "second-proof", format: "markdown", body: "Different author", createdByAgentId: f.reviewers[1] });
    const changed = { ...f.pack, conditions: [c, { ...c, proof: { issueId: f.issueId, key: "second-proof", documentId: second.document.id, revisionId: second.document.latestRevisionId! } }] };
    const { evidencePackSchema } = await import("@paperclipai/shared/evidence-pack");
    expect(evidencePackSchema.safeParse(changed).success).toBe(false);
  });
  it("uses the locked executor after a concurrent reassignment", async () => {
    const f = await reviewedFixture();
    let release!: () => void;
    let locked!: () => void;
    const held = new Promise<void>((r) => { locked = r; });
    const resume = new Promise<void>((r) => { release = r; });
    const writer = db.transaction(async (tx) => {
      await tx.select().from(issues).where(eq(issues.id, f.issueId)).for("update");
      locked(); await resume;
      await tx.update(issues).set({ assigneeAgentId: f.reviewers[0] }).where(eq(issues.id, f.issueId));
    });
    await held;
    const attempt = issueService(db).update(f.issueId, { status: "in_progress", actorUserId: "local-board" }).then(() => "admitted", (e: Error) => e.message);
    try {
      const { sql } = await import("drizzle-orm");
      let waiting = false;
      for (let i = 0; i < 200; i++) {
        const rows = await db.execute(sql`select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`);
        if (rows.length) { waiting = true; break; }
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(waiting).toBe(true);
    } finally { release(); }
    await writer;
    expect(await attempt).toContain("Evidence pack");
  });
  it("starts only with both real accepted reviews", async () => {
    const f = await reviewedFixture();
    const result = await issueService(db).update(f.issueId, { status: "in_progress", actorUserId: "local-board" });
    expect(result?.status).toBe("in_progress");
  });
  it("requires both independent reviewers even when the review ticket is done", async () => {
    const f = await reviewedFixture();
    await db.insert(issues).values({ companyId: f.companyId, title: "Completed review ticket is not approval", status: "done" });
    await db.update(issueThreadInteractions).set({ status: "pending", result: null }).where(eq(issueThreadInteractions.id, f.receipts[1]));
    await expect(issueService(db).update(f.issueId, { status: "in_progress", actorUserId: "local-board" })).rejects.toThrow("Evidence pack");
  });
  it.each(["todo", "in_progress"])("checkout fails closed for an opted-in missing pack (%s)", async (status) => {
    const f = await fixture();
    await db.update(issues).set({ status }).where(eq(issues.id, f.issueId));
    await expect(issueService(db).checkout(f.issueId, f.agentId, [status], null)).rejects.toThrow("Evidence pack");
    const [row] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(row.status).toBe(status);
    expect(row.executionRunId).toBeNull();
  });
  it("checkout admits a native reviewed pack", async () => {
    const f = await reviewedFixture();
    expect((await issueService(db).checkout(f.issueId, f.agentId, ["todo"], null)).status).toBe("in_progress");
  });
  it.each(["todo", "in_progress"])("real heartbeat never dispatches an invalid opted-in pack (%s)", async (status) => {
    const f = await fixture();
    await db.update(issues).set({ status }).where(eq(issues.id, f.issueId));
    const execute = vi.fn(async () => ({ exitCode: 0, signal: null, timedOut: false }));
    registerServerAdapter({ type: "evidence_test", supportsLocalAgentJwt: false, execute, testEnvironment: async () => ({ adapterType: "evidence_test", status: "pass", checks: [], testedAt: new Date().toISOString() }) });
    await db.update(agents).set({ adapterType: "evidence_test" }).where(eq(agents.id, f.agentId));
    const heartbeat = heartbeatService(db);
    try {
      const queued = await heartbeat.invoke(f.agentId, "on_demand", { issueId: f.issueId }, "manual");
      await heartbeat.drainActiveRunExecutions();
      expect(queued).not.toBeNull();
      expect(execute).not.toHaveBeenCalled();
      const row = await heartbeat.getRun(queued!.id);
      expect(row?.status).not.toBe("succeeded");
    } finally { await heartbeat.drainActiveRunExecutions(); unregisterServerAdapter("evidence_test"); }
  });
  it.each(["valid", "artifact_changed_after_claim", "policy_removed_after_claim", "executor_changed_after_claim", "runtime_context_mismatch", "context_changed_after_claim", "adapter_changed_during_preparation"])("atomic heartbeat dispatch admission: %s", async (fault) => {
    const f = await reviewedFixture({ environmentDriver: fault === "runtime_context_mismatch" ? "sandbox" : "local" });
    const provider = vi.fn(), tool = vi.fn();
    const execute = vi.fn(async () => {
      provider(); tool();
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId));
      return { exitCode: 0, signal: null, timedOut: false };
    });
    registerServerAdapter({ type: "evidence_test", supportsLocalAgentJwt: false, execute, testEnvironment: async () => ({ adapterType: "evidence_test", status: "pass", checks: [], testedAt: new Date().toISOString() }) });
    await db.update(agents).set({ adapterType: "evidence_test" }).where(eq(agents.id, f.agentId));
    registerServerAdapter({ type: "evidence_other", supportsLocalAgentJwt: false, execute, testEnvironment: async () => ({ adapterType: "evidence_other", status: "pass", checks: [], testedAt: new Date().toISOString() }) });
    if (fault === "adapter_changed_during_preparation") await db.update(agents).set({ adapterType: "evidence_other" }).where(eq(agents.id, f.agentId));
    const heartbeat = heartbeatService(db, { beforeResolvedInteractionContinuationDispatchCheck: async () => {
      if (fault === "adapter_changed_during_preparation") await db.update(agents).set({ adapterType: "evidence_test" }).where(eq(agents.id, f.agentId));
      if (fault === "context_changed_after_claim") await documentService(db).upsertIssueDocument({ issueId: f.issueId, key: f.pack.freshness.context.key, format: "markdown", body: "Target environment changed, proof bytes unchanged", baseRevisionId: f.pack.freshness.context.revisionId });
      if (fault === "artifact_changed_after_claim") await documentService(db).upsertIssueDocument({ issueId: f.issueId, key: f.artifact.key, format: "markdown", body: "Changed during setup", baseRevisionId: f.artifact.revisionId });
      if (fault === "policy_removed_after_claim") await db.update(issues).set({ executionPolicy: null }).where(eq(issues.id, f.issueId));
      if (fault === "executor_changed_after_claim") await db.update(issues).set({ assigneeAgentId: f.reviewers[0] }).where(eq(issues.id, f.issueId));
    } });
    try {
      const queued = await heartbeat.invoke(f.agentId, "on_demand", { issueId: f.issueId }, "manual");
      await heartbeat.drainActiveRunExecutions();
      expect(queued).not.toBeNull();
      const admitted = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agentId));
      const row = admitted.find((r) => r.runnerProfileJson?.evidenceAdmission);
      expect(row?.runnerProfileJson?.evidenceAdmission).toMatchObject({ revisionId: f.packRef.revisionId, executorAgentId: f.agentId, scope: f.binding.scope, receipts: f.receipts, fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
      if (fault === "valid") expect(execute).toHaveBeenCalledOnce();
      else { expect(execute).not.toHaveBeenCalled(); expect(provider).not.toHaveBeenCalled(); expect(tool).not.toHaveBeenCalled(); }
    } finally { await heartbeat.drainActiveRunExecutions(); unregisterServerAdapter("evidence_test"); unregisterServerAdapter("evidence_other"); }
  });
  it.each([null, "native_safe_replacement", "native_provider_overloaded", "resolved_interaction"])("queued heartbeat rechecks a revision changed before start (%s)", async (scheduledRetryReason) => {
    const f = await reviewedFixture();
    const execute = vi.fn(async () => ({ exitCode: 0, signal: null, timedOut: false }));
    registerServerAdapter({ type: "evidence_test", supportsLocalAgentJwt: false, execute, testEnvironment: async () => ({ adapterType: "evidence_test", status: "pass", checks: [], testedAt: new Date().toISOString() }) });
    await db.update(agents).set({ adapterType: "evidence_test" }).where(eq(agents.id, f.agentId));
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({ id, companyId: f.companyId, agentId: f.agentId, status: "queued", invocationSource: "manual", contextSnapshot: { issueId: f.issueId, ...(scheduledRetryReason === "resolved_interaction" ? { mutation: "interaction", wakeReason: "issue_commented", interactionId: f.receipts[0], interactionStatus: "accepted" } : {}) }, scheduledRetryReason: scheduledRetryReason === "resolved_interaction" ? null : scheduledRetryReason });
    await documentService(db).upsertIssueDocument({ issueId: f.issueId, key: f.artifact.key, format: "markdown", body: "Changed after queue", baseRevisionId: f.artifact.revisionId });
    const heartbeat = heartbeatService(db);
    try {
      await heartbeat.resumeQueuedRuns(); await heartbeat.drainActiveRunExecutions();
      expect(execute).not.toHaveBeenCalled();
      expect((await heartbeat.getRun(id))?.status).not.toBe("running");
    } finally { unregisterServerAdapter("evidence_test"); }
  });
  it("never treats a completed prerequisite without a native independent receipt as approval", async () => {
    const f = await reviewedFixture();
    const prerequisiteId = randomUUID();
    await db.insert(issues).values({ id: prerequisiteId, companyId: f.companyId, title: "Review performed, not approved", status: "done" });
    const revised = await documentService(db).upsertIssueDocument({ issueId: f.issueId, key: "evidence-pack", format: "markdown", body: JSON.stringify({ ...f.pack, prerequisiteIssueIds: [prerequisiteId] }), baseRevisionId: f.packRef.revisionId });
    const { assertIssueEvidencePack } = await import("../services/evidence-pack.js");
    // No vote can cover this new pack; assert the more specific prerequisite check.
    await expect(db.transaction((tx) => assertIssueEvidencePack(tx as unknown as typeof db, { id: f.issueId, companyId: f.companyId, executionPolicy: { evidencePack: { ...f.binding, revisionId: revised.document.latestRevisionId } } }, f.agentId))).rejects.toMatchObject({ details: { code: "evidence_pack_prerequisite_review_missing" } });
  });
  it("rejects expired context evidence even when every byte/revision and vote is current", async () => {
    const f = await reviewedFixture({ expired: true });
    await expect(issueService(db).checkout(f.issueId, f.agentId, ["todo"], null)).rejects.toMatchObject({ details: { code: "evidence_pack_expired" } });
  });
  it.each(["checkout", "execution"])("stale %s adoption cannot bypass a missing pack", async (lock) => {
    const f = await fixture();
    const oldId = randomUUID(), newId = randomUUID();
    await db.insert(heartbeatRuns).values([{ id: oldId, companyId: f.companyId, agentId: f.agentId, status: "failed" }, { id: newId, companyId: f.companyId, agentId: f.agentId, status: "running" }]);
    await db.update(issues).set({ status: "in_progress", executionRunId: oldId, checkoutRunId: lock === "checkout" ? oldId : null }).where(eq(issues.id, f.issueId));
    await expect(issueService(db).checkout(f.issueId, f.agentId, ["in_progress"], newId)).rejects.toThrow("Evidence pack");
    const [row] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(row.executionRunId).not.toBe(newId);
  });
  it("condition proof author cannot review their own proof through another creator's native card", async () => {
    const f = await reviewedFixture({ condition: true });
    const c = f.pack.conditions[0];
    await db.update(documentRevisions).set({ createdByAgentId: c.reviewerAgentId }).where(eq(documentRevisions.id, c.proof.revisionId));
    await expect(issueService(db).checkout(f.issueId, f.agentId, ["todo"], null)).rejects.toMatchObject({ details: { code: "evidence_pack_condition_open" } });
  });
  it("checks freshness after a real document lock wait at checkout", async () => {
    const f = await reviewedFixture({ expiresInMs: 1500 });
    let release!: () => void, locked!: () => void;
    const held = new Promise<void>((r) => { locked = r; });
    const resume = new Promise<void>((r) => { release = r; });
    const writer = db.transaction(async (tx) => {
      await tx.select().from(documents).where(eq(documents.id, f.pack.freshness.context.documentId)).for("update");
      locked(); await resume;
    });
    await held;
    const attempt = issueService(db).checkout(f.issueId, f.agentId, ["todo"], null).then(() => null, (e: unknown) => e);
    try {
      const { sql } = await import("drizzle-orm");
      let waiting = false;
      for (let i = 0; i < 200; i++) {
        const rows = await db.execute(sql`select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`);
        if (rows.length) { waiting = true; break; }
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(waiting).toBe(true);
      await new Promise((r) => setTimeout(r, Math.max(0, Date.parse(f.pack.freshness.expiresAt) - Date.now()) + 100));
    } finally { release(); }
    await writer;
    expect(await attempt).toMatchObject({ details: { code: "evidence_pack_expired" } });
  });
  it("rechecks late opt-in for an ordinary noPack heartbeat before dispatch", async () => {
    const f = await fixture();
    const [original] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    await db.update(issues).set({ executionPolicy: null }).where(eq(issues.id, f.issueId));
    const provider = vi.fn(), tool = vi.fn();
    const execute = vi.fn(async () => {
      provider(); tool();
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId));
      return { exitCode: 0, signal: null, timedOut: false };
    });
    registerServerAdapter({ type: "evidence_test", supportsLocalAgentJwt: false, execute, testEnvironment: async () => ({ adapterType: "evidence_test", status: "pass", checks: [], testedAt: new Date().toISOString() }) });
    await db.update(agents).set({ adapterType: "evidence_test" }).where(eq(agents.id, f.agentId));
    const preparation = vi.fn(async () => {
      await db.update(issues).set({ executionPolicy: original.executionPolicy }).where(eq(issues.id, f.issueId));
    });
    const heartbeat = heartbeatService(db, { beforeChatControlRecoveryCheck: async ({ stage }) => {
      if (stage === "dispatch") await preparation();
    } });
    try {
      await heartbeat.invoke(f.agentId, "automation", { issueId: f.issueId }, "system");
      await heartbeat.drainActiveRunExecutions();
      expect(execute).not.toHaveBeenCalled();
      expect(preparation).toHaveBeenCalledOnce();
      expect(provider).not.toHaveBeenCalled();
      expect(tool).not.toHaveBeenCalled();
    } finally { await heartbeat.drainActiveRunExecutions(); unregisterServerAdapter("evidence_test"); }
  });
  it("preserves noPack heartbeat execution", async () => {
    const f = await fixture();
    await db.update(issues).set({ executionPolicy: null }).where(eq(issues.id, f.issueId));
    const execute = vi.fn(async () => { await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId)); return { exitCode: 0, signal: null, timedOut: false }; });
    registerServerAdapter({ type: "evidence_test", supportsLocalAgentJwt: false, execute, testEnvironment: async () => ({ adapterType: "evidence_test", status: "pass", checks: [], testedAt: new Date().toISOString() }) });
    await db.update(agents).set({ adapterType: "evidence_test" }).where(eq(agents.id, f.agentId));
    const heartbeat = heartbeatService(db);
    try {
      await heartbeat.invoke(f.agentId, "on_demand", { issueId: f.issueId }, "manual");
      await heartbeat.drainActiveRunExecutions();
      expect(execute).toHaveBeenCalledOnce();
    } finally { unregisterServerAdapter("evidence_test"); }
  });
  it.each(["valid", "forged", "human_only", "revoked_during_preparation"])("trusted native reviewer heartbeat admission: %s", async (scenario) => {
    const f = await reviewedFixture();
    const { completionContracts, nativeRunResults, workAssessments, statusDecisions } = await import("@paperclipai/db");
    const { prepareNativeHeartbeatRun } = await import("../services/native-runtime/prepare-native-run.js");
    const sourceRunId = randomUUID(), resultId = randomUUID(), assessmentId = randomUUID(), decisionId = randomUUID();
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    const [sourceRun] = await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId: f.companyId, agentId: f.agentId, status: "succeeded", runtimeMode: "native", nativeIssueId: f.issueId, contextSnapshot: { issueId: f.issueId } }).returning();
    await prepareNativeHeartbeatRun({ db, run: sourceRun, issue, environmentLeaseId: randomUUID() });
    const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.issueId, f.issueId));
    await db.insert(nativeRunResults).values({ id: resultId, companyId: f.companyId, issueId: f.issueId, runId: sourceRunId, completionContractId: contract.id, serverFingerprint: resultId, schemaStatus: "accepted", resultJson: {}, canonicalSha256: resultId });
    await db.insert(workAssessments).values({ id: assessmentId, companyId: f.companyId, issueId: f.issueId, runId: sourceRunId, contractId: contract.id, resultId, triggerKind: "native_result", triggerActorCompanyId: f.companyId, priorIssueStatus: "todo", priorStatusVersion: issue.statusVersion, policyVersion: "fixture", assessmentJson: {}, inputDigest: assessmentId });
    const [reviewIssue] = await db.update(issues).set({ status: "in_review" }).where(eq(issues.id, f.issueId)).returning();
    await db.insert(statusDecisions).values({ id: decisionId, companyId: f.companyId, issueId: f.issueId, runId: sourceRunId, assessmentId, decisionVersion: 1, policyVersion: "fixture", fromStatus: "todo", toStatus: "in_review", reasonCode: "explicit_review", decisionJson: { projectedStatusVersion: reviewIssue.statusVersion }, decisionDigest: decisionId, applicationState: "applied" });
    await db.update(issues).set({ lastStatusDecisionId: decisionId }).where(eq(issues.id, f.issueId));
    const interactions = issueThreadInteractionService(db);
    const assignment = await interactions.create({ id: f.issueId, companyId: f.companyId }, {
      kind: "request_confirmation", sourceRunId, resolverPolicy: "not_creator", addresseeAgentId: f.reviewers[0],
      payload: { version: 1, prompt: "Review the evidence before productive execution", target: { type: "custom", key: "native_completion_review", revisionId: decisionId } },
    }, { agentId: f.agentId, runId: sourceRunId });
    await db.update(issueThreadInteractions).set({ status: "pending", result: null, resolvedAt: null, resolvedByRunId: null, resolvedByAgentId: null }).where(eq(issueThreadInteractions.id, f.receipts[0]));
    const execute = vi.fn(async ({ runId }: { runId: string }) => {
      await interactions.acceptInteraction({ id: f.issueId, companyId: f.companyId, projectId: null, goalId: null, status: "in_review" }, f.receipts[0], {}, { agentId: f.reviewers[0], runId });
      return { exitCode: 0, signal: null, timedOut: false };
    });
    registerServerAdapter({ type: "evidence_reviewer_test", supportsLocalAgentJwt: false, execute, testEnvironment: async () => ({ adapterType: "evidence_reviewer_test", status: "pass", checks: [], testedAt: new Date().toISOString() }) });
    await db.update(agents).set({ adapterType: "evidence_reviewer_test" }).where(eq(agents.id, f.reviewers[0]));
    if (scenario === "human_only") await db.update(issueThreadInteractions).set({ effectiveResolverPolicy: "human_only" }).where(eq(issueThreadInteractions.id, assignment.id));
    const preparation = vi.fn(async () => {
      if (scenario === "revoked_during_preparation") await db.update(issueThreadInteractions).set({ status: "cancelled" }).where(eq(issueThreadInteractions.id, assignment.id));
    });
    const heartbeat = heartbeatService(db, { beforeChatControlRecoveryCheck: async ({ stage }) => {
      if (stage === "dispatch") await preparation();
    } });
    try {
      const run = await heartbeat.invoke(f.reviewers[0], "automation", { issueId: f.issueId, wakeReason: "native_completion_review", nativeReviewInteractionId: scenario === "forged" ? randomUUID() : assignment.id, nativeReviewDecisionId: decisionId, evidenceReviewer: true }, "system");
      await heartbeat.drainActiveRunExecutions();
      expect(run).not.toBeNull();
      const [receipt] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, f.receipts[0]));
      if (scenario === "valid") {
        expect(execute).toHaveBeenCalledOnce();
        expect(receipt).toMatchObject({ status: "accepted", resolvedByAgentId: f.reviewers[0], resolvedByRunId: run!.id });
        expect((await heartbeat.getRun(run!.id))?.runnerProfileJson?.evidenceReviewerAdmission).toMatchObject({ interactionId: assignment.id, decisionId });
        expect((await issueService(db).checkout(f.issueId, f.agentId, ["in_review"], null)).status).toBe("in_progress");
      } else {
        expect(execute).not.toHaveBeenCalled();
        expect(receipt).toMatchObject({ status: "pending", resolvedByRunId: null });
        if (scenario === "revoked_during_preparation") expect(preparation).toHaveBeenCalledOnce();
      }
      expect((await heartbeat.getRun(run!.id))?.runnerProfileJson?.evidenceAdmission).toBeUndefined();
    } finally { await heartbeat.drainActiveRunExecutions(); unregisterServerAdapter("evidence_reviewer_test"); }
  });
  it.each(["remove", "weaken", "rebind"])("requires board governance before authenticated checkout: %s", async (change) => {
    const f = await fixture();
    const [{ default: express }, { default: request }, { actorMiddleware }, { errorHandler }, { issueRoutes }, { agentApiKeys }, { createHash }] = await Promise.all([
      import("express"), import("supertest"), import("../middleware/auth.js"), import("../middleware/error-handler.js"), import("../routes/issues.js"), import("@paperclipai/db"), import("node:crypto"),
    ]);
    const key = `test-only-${randomUUID()}`;
    const { authUsers, companyMemberships } = await import("@paperclipai/db");
    const userId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Test operator", email: `${userId}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values([
      { companyId: f.companyId, principalType: "user", principalId: userId, membershipRole: "operator", status: "active" },
      { companyId: f.companyId, principalType: "agent", principalId: f.agentId, membershipRole: "member", status: "active" },
    ]);
    await db.insert(agentApiKeys).values({ companyId: f.companyId, agentId: f.agentId, responsibleUserId: userId, name: "local test", keyHash: createHash("sha256").update(key).digest("hex") });
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "authenticated" }));
    app.use("/api", issueRoutes(db, {} as never));
    app.use(errorHandler);
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId, responsibleUserId: userId, status: "running", contextSnapshot: { issueId: f.issueId }, nativeIssueId: f.issueId });
    const [before] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    const { evidencePackBindingSchema } = await import("@paperclipai/shared/evidence-pack");
    const binding = evidencePackBindingSchema.parse((before.executionPolicy as { evidencePack: unknown }).evidencePack);
    const replacement = change === "remove" ? null : { evidencePack: { ...binding,
      ...(change === "weaken" ? { scope: { ...binding.scope, exclusions: [] } } : { revisionId: randomUUID() }),
    } };
    const removal = await request(app).patch(`/api/issues/${f.issueId}`).set("Authorization", `Bearer ${key}`).set("X-Paperclip-Run-Id", runId).send({ executionPolicy: replacement, actorUserId: userId });
    const checkout = await request(app).post(`/api/issues/${f.issueId}/checkout`).set("Authorization", `Bearer ${key}`).set("X-Paperclip-Run-Id", runId).send({ agentId: f.agentId, expectedStatuses: ["todo"] });
    expect(removal.status).toBe(403);
    expect(removal.body.details?.code).toBe("evidence_pack_governance_required");
    expect(checkout.status).toBe(422);
    const [stored] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(stored.executionPolicy).toHaveProperty("evidencePack");
    expect(stored.status).toBe("todo");
    expect(stored.executionRunId).toBeNull();
  });
  it("commits board governance and its audit atomically under the issue lock", async () => {
    const f = await fixture();
    const { activityLog } = await import("@paperclipai/db");
    const [before] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    await expect(db.transaction(async (tx) => {
      await issueService(db).update(f.issueId, { executionPolicy: null, actorUserId: "local-board" }, tx as unknown as typeof db);
      throw new Error("rollback governance");
    })).rejects.toThrow("rollback governance");
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].executionPolicy).toEqual(before.executionPolicy);
    expect(await db.select().from(activityLog).where(eq(activityLog.entityId, f.issueId))).toEqual([]);
    await issueService(db).update(f.issueId, { executionPolicy: null, actorUserId: "local-board" });
    const logs = await db.select().from(activityLog).where(eq(activityLog.entityId, f.issueId));
    expect(logs.filter((entry) => entry.action === "issue.evidence_policy_changed")).toMatchObject([
      { companyId: f.companyId, actorType: "user", actorId: "local-board", details: { previous: (before.executionPolicy as { evidencePack: unknown }).evidencePack, next: null } },
    ]);
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].executionPolicy).toBeNull();
  });
  it("blocks a real in_progress update when an opted-in pack is missing", async () => {
    const f = await fixture();
    await expect(issueService(db).update(f.issueId, { status: "in_progress", actorUserId: "local-board" })).rejects.toThrow("Evidence pack");
  });
});
