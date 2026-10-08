import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createDb, companies, companyMemberships, authUsers, agents, issues, heartbeatRuns, agentWakeupRequests, governanceAuditEvents } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { documentService } from "../services/documents.js";
import { issueService } from "../services/issues.js";
import { governanceService, canonicalGovernanceOperation, hashGovernanceOperation } from "../services/governance-verification.js";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/error-handler.js";
const adapterExecute = vi.hoisted(() => vi.fn());
vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return { ...actual, getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: adapterExecute })) };
});


// This is an isolated native creator/resolver qualification, not a Synology
// integration; the register is an isolated test register. Only prerequisite company/agent/source-run state is seeded.
// No accepted interactions, resolver receipts or document revisions are seeded.
describe("governance native approval services and API", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("governance-native-");
    db = createDb(temporary.connectionString);
  }, 120_000);
  afterAll(async () => { await temporary?.cleanup(); });
  let sequence = 0;
  async function setup(continuation = false) {
    const companyId = randomUUID(), ownerUserId = randomUUID(), agentId = randomUUID(), reviewerAgentId = randomUUID();
    const issueId = randomUUID(), reviewIssueId = randomUUID(), runId = randomUUID(), reviewRunId = randomUUID();
    const outsiderId = randomUUID(), outsiderRunId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "native approval test", issuePrefix: `N${++sequence}` });
    await db.insert(authUsers).values({ id: ownerUserId, name: "Owner", email: `${ownerUserId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: ownerUserId, status: "active", membershipRole: "owner" });
    await db.insert(agents).values([agentId, reviewerAgentId, outsiderId].map(id => ({ id, companyId, name: id, status: "active", adapterType: "codex_local", runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } })));
    await db.insert(issues).values([
      { id: issueId, companyId, title: "isolated operation", status: "in_progress", assigneeAgentId: agentId },
      { id: reviewIssueId, companyId, title: "independent review", status: "in_progress", assigneeAgentId: reviewerAgentId, createdByAgentId: agentId },
    ]);
    await db.insert(heartbeatRuns).values([
      { id: outsiderRunId, companyId, agentId: outsiderId, status: "running", nativeIssueId: reviewIssueId, contextSnapshot: { issueId: reviewIssueId }, startedAt: new Date() },
      { id: runId, companyId, agentId, status: "running", nativeIssueId: issueId, contextSnapshot: { issueId }, startedAt: new Date() },
      { id: reviewRunId, companyId, agentId: reviewerAgentId, status: "running", nativeIssueId: reviewIssueId, contextSnapshot: { issueId: reviewIssueId }, startedAt: new Date() },
    ]);
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    await db.update(issues).set({ executionRunId: reviewRunId }).where(eq(issues.id, reviewIssueId));
    const docs = documentService(db);
    const register = (await docs.upsertIssueDocument({ issueId, key: "dsm-register", format: "markdown", body: JSON.stringify({ version: 1, entries: [{ entryId: "isolated-test", effectClass: "NE", api: "isolated", method: "isolated", apiVersion: 1, targetIds: ["isolated-target"] }] }), createdByUserId: ownerUserId })).document;
    const operation = { version: 1 as const, companyId, nasTarget: "isolated-seam", agentId, issueId, runId, requesterAgentId: agentId,
      effectClass: "NE" as const, entryId: "isolated-test", api: "isolated", method: "isolated", apiVersion: 1,
      paramsDigest: "a".repeat(64), targetIds: ["isolated-target"], registerDocumentId: register.id, registerRevision: register.latestRevisionId!, preconditionDigest: "b".repeat(64) };
    const doc = (await docs.upsertIssueDocument({ issueId, key: "dsm-operation", format: "markdown", body: canonicalGovernanceOperation(operation), createdByAgentId: agentId, createdByRunId: runId })).document;
    await docs.lockIssueDocument({ issueId, key: "dsm-register", lockedByUserId: ownerUserId });
    await docs.lockIssueDocument({ issueId, key: "dsm-operation", lockedByUserId: ownerUserId });
    const interactions = issueThreadInteractionService(db);
    const target = { type: "issue_document" as const, issueId, documentId: doc.id, key: "dsm-operation", revisionId: doc.latestRevisionId! };
    const fp = await interactions.create({ id: reviewIssueId, companyId }, {
      kind: "request_confirmation", resolverPolicy: "not_creator", addresseeAgentId: reviewerAgentId, continuationPolicy: "none", sourceRunId: runId,
      payload: { version: 1, prompt: "Review only this isolated operation revision.", target },
    }, { agentId, runId });
    const human = await interactions.create({ id: issueId, companyId }, {
      kind: "request_confirmation", resolverPolicy: "human_only", addresseeUserId: ownerUserId, continuationPolicy: continuation ? "wake_assignee_on_accept" : "none", sourceRunId: runId,
      payload: { version: 1, prompt: "Authorize only this isolated operation revision.", target },
    }, { agentId, runId });
    expect(fp.status).toBe("pending"); expect(human.status).toBe("pending");
    const svc = governanceService(db);
    const service = await svc.createService({ companyId, ownerUserId, nasTarget: operation.nasTarget });
    const credential = await svc.issueCredential(service.id, ownerUserId, new Date(Date.now() + 60_000));
    const principal = await svc.authenticate(credential.token);
    const invocation = await svc.recordInvocation({ serviceId: service.id, issuer: "paperclip-gateway", operation,
      operationDocumentId: doc.id, operationRevisionId: doc.latestRevisionId!, reviewIssueId, reviewerAgentId, fpInteractionId: fp.id, humanInteractionId: human.id });
    const app = express(); app.use(express.json());
    // Explicit auth-boundary test actors. Native resolver authorization remains real.
    const actors = {
      outsider: { type: "agent", companyId, agentId: outsiderId, runId: outsiderRunId, keyScope: "standard", responsibleUserId: ownerUserId },
      owner: { type: "board", userId: ownerUserId, source: "session", companyIds: [companyId], memberships: [{ companyId, membershipRole: "owner", status: "active" }] },
      creator: { type: "agent", companyId, agentId, runId, keyScope: "standard", responsibleUserId: ownerUserId },
      reviewer: { type: "agent", companyId, agentId: reviewerAgentId, runId: reviewRunId, keyScope: "standard", responsibleUserId: ownerUserId },
    };
    app.use((req, _res, next) => { req.actor = actors[req.header("x-test-actor") as keyof typeof actors] as typeof req.actor; next(); });
    app.use("/api", issueRoutes(db, { provider: "local_disk", putFile: async () => { throw new Error("unexpected storage"); }, getObject: async () => { throw new Error("unexpected storage"); }, headObject: async () => ({ exists: false }), deleteObject: async () => {} }));
    app.use(errorHandler);
    const accept = (id: string, interactionId: string, actor: keyof typeof actors) => {
      const req = request(app).post(`/api/issues/${id}/interactions/${interactionId}/accept`).set("x-test-actor", actor);
      if (actor !== "owner") req.set("X-Paperclip-Run-Id", actor === "reviewer" ? reviewRunId : actor === "outsider" ? outsiderRunId : runId);
      return req.send({});
    };
    const provider = vi.fn(async () => ({ outcome: "isolated-only" }));
    const opHash = hashGovernanceOperation(operation);
    async function dispatch() {
      const verified = await svc.verify(principal, { invocationId: invocation.id, opHash, idempotencyKey: "verify" });
      if (verified.decision === "deny") return verified;
      const consumed = await svc.consume(principal, verified.verificationId, { opHash, idempotencyKey: "consume" });
      if (consumed.dispatchAllowed) await provider();
      return consumed;
    }
    async function approve() {
      const review = await accept(reviewIssueId, fp.id, "reviewer");
      expect(review.status, JSON.stringify(review.body)).toBe(200);
      await issueService(db).update(reviewIssueId, { status: "done", actorAgentId: reviewerAgentId, actorRunId: reviewRunId });
      // Isolated worker completion prerequisite; approval and its audit are native.
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, reviewRunId));
      if (continuation) {
        await issueService(db).update(issueId, { status: "in_review", actorAgentId: agentId, actorRunId: runId });
        await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
        await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, issueId));
      }
      const approval = await accept(issueId, human.id, "owner");
      expect(approval.status, JSON.stringify(approval.body)).toBe(200);
    }
    return { companyId, issueId, reviewIssueId, runId, reviewRunId, agentId, ownerUserId, fp, human, doc, docs, accept, approve, dispatch, provider, svc, principal, invocation, opHash };
  }
  it("native named reviewer and human approvals reach exactly one isolated dispatch in the source run", async () => {
    const f = await setup(); await f.approve();
    expect(await f.dispatch()).toMatchObject({ dispatchAllowed: true });
    expect(f.provider).toHaveBeenCalledTimes(1);
    await expect(f.dispatch()).rejects.toMatchObject({ status: 409 });
    expect(f.provider).toHaveBeenCalledTimes(1);
  });
  it("accepted native approval creates a fresh continuation run that can consume the unchanged approved operation", async () => {
    const f = await setup(true);
    const outcomes: Array<{ runId: string; result: unknown }> = [];
    adapterExecute.mockReset();
    adapterExecute.mockImplementation(async (context) => {
      await issueService(db).checkout(f.issueId, f.agentId, ["todo", "in_progress"], context.runId);
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, context.runId));
      const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, run!.wakeupRequestId!));
      // The continuation run must be causally linked to the accepted human interaction and the originating run.
      expect(run!.id).toBe(context.runId);
      expect(run!.contextSnapshot).toMatchObject({ issueId: f.issueId, interactionId: f.human.id, interactionStatus: "accepted", sourceRunId: f.runId });
      expect(wake).toMatchObject({ runId: context.runId, source: "automation", reason: "issue_commented", requestedByActorType: "user",
        requestedByActorId: f.ownerUserId, idempotencyKey: `interaction:${f.human.id}:accepted` });
      expect(wake!.payload).toMatchObject({ issueId: f.issueId, interactionId: f.human.id, interactionStatus: "accepted", sourceRunId: f.runId });
      const result = await f.dispatch();
      await issueService(db).update(f.issueId, { status: "done", actorAgentId: f.agentId, actorRunId: context.runId });
      outcomes.push({ runId: context.runId, result });
      return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "Isolated governance seam", provider: "test", model: "test" };
    });
    await f.approve();
    await vi.waitFor(() => expect(outcomes).toHaveLength(1));
    expect(outcomes[0]!.runId).not.toBe(f.runId);
    expect(outcomes[0]!.result).toMatchObject({ dispatchAllowed: true });
    expect(f.provider).toHaveBeenCalledTimes(1);
  });
  it.each(["wrong_resolver", "self_review", "human_only", "stale_revision"] as const)("native %s denial has zero provider dispatches", async fault => {
    const f = await setup();
    if (fault === "stale_revision") {
      await f.docs.unlockIssueDocument(f.issueId, "dsm-operation");
      await f.docs.upsertIssueDocument({ issueId: f.issueId, key: "dsm-operation", format: "markdown", body: "new unapproved revision", baseRevisionId: f.doc.latestRevisionId, createdByUserId: f.ownerUserId });
      expect((await f.accept(f.issueId, f.human.id, "owner")).status).toBe(409);
    } else {
      const human = fault === "human_only";
      expect((await f.accept(human ? f.issueId : f.reviewIssueId, human ? f.human.id : f.fp.id, fault === "wrong_resolver" ? "outsider" : "creator")).status).toBe(403);
    }
    expect(await f.dispatch()).toMatchObject({ decision: "deny" });
    expect(f.provider).not.toHaveBeenCalled();
    expect(await db.select().from(governanceAuditEvents).where(eq(governanceAuditEvents.companyId, f.companyId))).toHaveLength(0);
  });
});
