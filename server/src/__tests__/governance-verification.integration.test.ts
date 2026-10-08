import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { governanceMachineBoundary, governanceOwnerRoutes } from "../routes/governance-verification.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createDb, companies, companyMemberships, governanceServices, governanceCredentials, governanceAuditEvents, governanceVerifications, authUsers, agents, issues, heartbeatRuns, documents, documentRevisions, issueDocuments, issueThreadInteractions, activityLog } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { governanceService } from "../services/governance-verification.js";
import { createApp } from "../app.js";
import { companyService } from "../services/companies.js";

describe("isolated governance lifecycle", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let emptyPluginDir: string;
  beforeAll(async () => {
    emptyPluginDir = await mkdtemp(path.join(tmpdir(), "paperclip-governance-plugins-"));
    temporary = await startEmbeddedPostgresTestDatabase("governance-verification-");
    db = createDb(temporary.connectionString);
  }, 120_000);
  afterAll(async () => {
    await temporary?.cleanup();
    if (emptyPluginDir) await rm(emptyPluginDir, { recursive: true, force: true });
  });
  it("never passes a machine bearer into legacy routes, including implicit local Board", async () => {
    const app = express();
    app.use(express.json());
    app.use(governanceMachineBoundary(db));
    app.use(actorMiddleware(db, { deploymentMode: "local_trusted" }));
    app.use("/api", governanceOwnerRoutes(db));
    let calls = 0;
    app.use((_req, res) => { calls++; res.json({ unsafe: true }); });
    app.use(errorHandler);
    for (const method of ["get", "post", "patch", "put", "delete", "head", "options"] as const) {
      for (const path of ["/api/issues/" + randomUUID(), "/api/issues/x/comments", "/api/companies", "/api/agents/me/secrets", "/api/auth", "/mcp/gateways/gw_x", "/api/governance/dsm/v1/credentials", "/anything"]) {
        const response = await request(app)[method](path).set("Authorization", `Bearer pcgov_${"a".repeat(64)}`);
        expect(response.status, `${method} ${path}`).toBe(403);
      }
    }
    expect(calls).toBe(0);
    expect((await request(app).post("/api/governance/dsm/v1/verifications").send({})).status).toBe(401);
  });
  it("mediates real createApp ingress before implicit Board, auth and MCP routes", async () => {
    const app = await createApp(db, {
      uiMode: "none", serverPort: 3100, deploymentMode: "local_trusted", deploymentExposure: "private",
      allowedHostnames: ["127.0.0.1", "localhost"], bindHost: "127.0.0.1", authReady: true,
      companyDeletionEnabled: false, managedPluginAutoInstall: [], decisionServiceOptions: {},
      localPluginDir: emptyPluginDir,
      storageService: { provider: "local_disk", putFile: async () => { throw new Error("Unexpected storage call"); },
        getObject: async () => { throw new Error("Unexpected storage call"); }, headObject: async () => ({ exists: false }), deleteObject: async () => {} },
    });
    try {
      for (const path of ["/api/companies", "/api/auth/get-session", "/mcp/gateways/gw_fixture", "/api/agents/me/secrets"]) {
        const denied = await request(app).get(path).set("Host", "localhost").set("Authorization", `Bearer pcgov_${"a".repeat(64)}`);
        expect(denied.status, path).toBe(403);
        expect(denied.body.code).toBe("governance_route_denied");
      }
      const missingCredential = await request(app).post("/api/governance/dsm/v1/verifications").set("Host", "localhost").send({});
      expect(missingCredential.status, JSON.stringify(missingCredential.body)).toBe(401);
      expect(missingCredential.body.code).toBe("governance_credential_required");
      const f = await verifiedFixture();
      const post = (path: string, body: object) => request(app).post(path).set("Host", "localhost").set("Authorization", `Bearer ${f.credential.token}`).send(body);
      const verified = await post("/api/governance/dsm/v1/verifications", { invocationId: f.invocation.id, opHash: f.opHash, idempotencyKey: "verify" });
      expect(verified.status).toBe(200); expect(verified.body.decision).toBe("allow");
      const consumeUrl = `/api/governance/dsm/v1/verifications/${verified.body.verificationId}/consume`;
      const consumed = await post(consumeUrl, { opHash: f.opHash, idempotencyKey: "consume" });
      expect(consumed.status).toBe(200); expect(consumed.body.dispatchAllowed).toBe(true);
      const replay = await post(consumeUrl, { opHash: f.opHash, idempotencyKey: "consume" });
      expect(replay.status).toBe(200); expect(replay.body.dispatchAllowed).toBe(false);
      expect(replay.body.dispatchId).toBe(consumed.body.dispatchId);
      const outcome = await post(`/api/governance/dsm/v1/dispatches/${consumed.body.dispatchId}/events`, { type: "succeeded", reasonCode: "none", idempotencyKey: "outcome" });
      expect(outcome.status).toBe(200); expect(outcome.body.noReplay).toBe(true);
    } finally {
      await app.locals.bundledPluginsStartup;
      await app.locals.paperclipShutdown();
    }
  });
  let fixtureNumber = 0;
  type SharedScope = Pick<Awaited<ReturnType<typeof fixture>>, "companyId" | "ownerUserId" | "svc" | "service" | "credential" | "principal">;
  /** `shared` reuses an existing company, owner, service and credential for a second, independent operation. */
  async function fixture(registerOverride?: string, shared?: SharedScope) {
    const companyId = shared?.companyId ?? randomUUID(), ownerUserId = shared?.ownerUserId ?? randomUUID(), agentId = randomUUID(), reviewerAgentId = randomUUID();
    const issueId = randomUUID(), reviewIssueId = randomUUID(), runId = randomUUID(), reviewRunId = randomUUID();
    if (!shared) {
      await db.insert(companies).values({ id: companyId, name: "fixture", issuePrefix: `G${++fixtureNumber}` });
      await db.insert(authUsers).values({ id: ownerUserId, name: "Owner", email: `${ownerUserId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: ownerUserId, status: "active", membershipRole: "owner" });
    }
    await db.insert(agents).values([agentId, reviewerAgentId].map(id => ({ id, companyId, name: "fixture", status: "active" })));
    await db.insert(issues).values([
      { id: issueId, companyId, title: "secret poison @owner", status: "in_progress", assigneeAgentId: agentId },
      { id: reviewIssueId, companyId, title: "review", status: "done", assigneeAgentId: reviewerAgentId, createdByAgentId: agentId },
    ]);
    await db.insert(heartbeatRuns).values([
      { id: runId, companyId, agentId, status: "running", nativeIssueId: issueId, startedAt: new Date() },
      { id: reviewRunId, companyId, agentId: reviewerAgentId, status: "succeeded", nativeIssueId: reviewIssueId, startedAt: new Date(), finishedAt: new Date() },
    ]);
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const registerDocumentId = randomUUID(), registerRevision = randomUUID();
    const registerBody = registerOverride ?? JSON.stringify({ version: 1, entries: [{ entryId: "entry-1", effectClass: "NE", api: "SYNO.Fixture", method: "set", apiVersion: 1, targetIds: ["opaque-target"] }] });
    const operation = { version: 1 as const, companyId, nasTarget: "fixture-nas", agentId, issueId, runId,
      requesterAgentId: agentId, effectClass: "NE" as const, entryId: "entry-1", api: "SYNO.Fixture", method: "set", apiVersion: 1,
      paramsDigest: "a".repeat(64), targetIds: ["opaque-target"], registerDocumentId, registerRevision, preconditionDigest: "b".repeat(64) };
    const sorted = Object.fromEntries(Object.entries(operation).sort(([a], [b]) => a.localeCompare(b)));
    const body = JSON.stringify(sorted);
    const opHash = createHash("sha256").update(`paperclip.governance.dsm.v1\n${body}`).digest("hex");
    const operationDocumentId = randomUUID(), operationRevisionId = randomUUID();
    for (const doc of [{ id: registerDocumentId, revisionId: registerRevision, body: registerBody }, { id: operationDocumentId, revisionId: operationRevisionId, body }]) {
      await db.insert(documents).values({ id: doc.id, companyId, latestBody: doc.body, latestRevisionId: doc.revisionId, lockedAt: new Date(), lockedByUserId: ownerUserId });
      await db.insert(documentRevisions).values({ id: doc.revisionId, companyId, documentId: doc.id, revisionNumber: 1, body: doc.body, createdByUserId: ownerUserId });
      await db.insert(issueDocuments).values({ companyId, issueId, documentId: doc.id, key: doc.id === operationDocumentId ? "dsm-operation" : "dsm-register" });
    }
    // Actual native accepted interaction + resolver activity receipts, not caller assertions.
    const fpInteractionId = randomUUID(), humanInteractionId = randomUUID();
    for (const [id, human] of [[fpInteractionId, false], [humanInteractionId, true]] as const) {
      const targetIssueId = human ? issueId : reviewIssueId;
      await db.insert(issueThreadInteractions).values({ id, companyId, issueId: targetIssueId, kind: "request_confirmation", status: "accepted",
        requestedResolverPolicy: human ? "human_only" : "not_creator", effectiveResolverPolicy: human ? "human_only" : "not_creator",
        createdByAgentId: agentId, sourceRunId: runId, addresseeAgentId: human ? null : reviewerAgentId,
        addresseeUserId: human ? ownerUserId : null, resolvedByAgentId: human ? null : reviewerAgentId,
        resolvedByRunId: human ? null : reviewRunId, resolvedByUserId: human ? ownerUserId : null, resolvedAt: new Date(),
        payload: { version: 1, prompt: "Accept this exact operation without conditions", target: { type: "issue_document", issueId, documentId: operationDocumentId, key: "dsm-operation", revisionId: operationRevisionId } },
        result: { version: 1, outcome: "accepted" } });
      await db.insert(activityLog).values({ companyId, actorType: human ? "user" : "agent", actorId: human ? ownerUserId : reviewerAgentId,
        agentId: human ? null : reviewerAgentId, runId: human ? null : reviewRunId, action: "issue.thread_interaction_accepted", entityType: "issue", entityId: targetIssueId,
        details: { interactionId: id, interactionStatus: "accepted", effectiveResolverPolicy: human ? "human_only" : "not_creator" } });
    }
    const svc = shared?.svc ?? governanceService(db);
    const service = shared?.service ?? await svc.createService({ companyId, ownerUserId, nasTarget: "fixture-nas" });
    const credential = shared?.credential ?? await svc.issueCredential(service.id, ownerUserId, new Date(Date.now() + 60_000));
    const principal = shared?.principal ?? await svc.authenticate(credential.token);
    const binding = { serviceId: service.id, issuer: "paperclip-gateway", operation, operationDocumentId, operationRevisionId, reviewIssueId, reviewerAgentId, fpInteractionId, humanInteractionId };
    return { ...binding, companyId, ownerUserId, agentId, issueId, runId, reviewRunId, opHash, svc, service, credential, principal };
  }
  it("verifies authoritative NE evidence then atomically persists intent and grants one consume", async () => {
    const f = await fixture();
    const invocation = await f.svc.recordInvocation({ serviceId: f.service.id, issuer: f.issuer, operation: f.operation,
      operationDocumentId: f.operationDocumentId, operationRevisionId: f.operationRevisionId, reviewIssueId: f.reviewIssueId,
      reviewerAgentId: f.reviewerAgentId, fpInteractionId: f.fpInteractionId, humanInteractionId: f.humanInteractionId });
    const verified = await f.svc.verify(f.principal, { invocationId: invocation.id, opHash: f.opHash, idempotencyKey: "verify-1" });
    expect(verified.decision).toBe("allow");
    const consumed = await f.svc.consume(f.principal, verified.verificationId, { opHash: f.opHash, idempotencyKey: "consume-1" });
    expect(consumed).toMatchObject({ dispatchAllowed: true, noReplay: true, state: "claimed" });
    const replay = await f.svc.consume(f.principal, verified.verificationId, { opHash: f.opHash, idempotencyKey: "consume-1" });
    expect(replay).toMatchObject({ dispatchAllowed: false, noReplay: true, dispatchId: consumed.dispatchId });
    const auditRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: auditRunId, companyId: f.companyId, agentId: f.reviewerAgentId, nativeIssueId: f.reviewIssueId, status: "running", startedAt: new Date() });
    const audit = await f.svc.evidence(f.companyId, f.reviewerAgentId, auditRunId, f.issueId);
    expect(audit.map(e => e.type)).toEqual(["audit_intent"]);
    expect(JSON.stringify(audit)).not.toContain("secret poison");
  });
  async function verifiedFixture(shared?: SharedScope) {
    const f = await fixture(undefined, shared);
    const invocation = await f.svc.recordInvocation({ serviceId: f.service.id, issuer: f.issuer, operation: f.operation,
      operationDocumentId: f.operationDocumentId, operationRevisionId: f.operationRevisionId, reviewIssueId: f.reviewIssueId,
      reviewerAgentId: f.reviewerAgentId, fpInteractionId: f.fpInteractionId, humanInteractionId: f.humanInteractionId });
    const verified = await f.svc.verify(f.principal, { invocationId: invocation.id, opHash: f.opHash, idempotencyKey: "verify" });
    expect(verified.decision).toBe("allow");
    return { ...f, invocation, verified };
  }
  it.each(["stale_revision", "cancelled_run", "fake_self_review", "forged_human", "missing_resolver_receipt", "old_approval"])(
    "rechecks %s after verify and denies consume without an intent", async fault => {
      const f = await verifiedFixture();
      if (fault === "stale_revision") await db.update(documents).set({ latestRevisionId: randomUUID() }).where(eq(documents.id, f.operationDocumentId));
      if (fault === "cancelled_run") await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, f.runId));
      if (fault === "fake_self_review") await db.update(issueThreadInteractions).set({ resolvedByAgentId: f.agentId, resolvedByRunId: f.runId }).where(eq(issueThreadInteractions.id, f.fpInteractionId));
      if (fault === "forged_human") await db.update(issueThreadInteractions).set({ resolvedByAgentId: f.agentId, resolvedByUserId: null }).where(eq(issueThreadInteractions.id, f.humanInteractionId));
      if (fault === "missing_resolver_receipt") await db.delete(activityLog).where(eq(activityLog.companyId, f.companyId));
      if (fault === "old_approval") await db.update(issueThreadInteractions).set({ resolvedAt: new Date(Date.now() - 86_400_001) }).where(eq(issueThreadInteractions.id, f.humanInteractionId));
      await expect(f.svc.consume(f.principal, f.verified.verificationId, { opHash: f.opHash, idempotencyKey: "consume" })).rejects.toMatchObject({ status: 409 });
      const after = await f.svc.verify(f.principal, { invocationId: f.invocation.id, opHash: f.opHash, idempotencyKey: "verify" });
      expect(after.decision).toBe("deny");
    });
  it.each([
    ["missing register entry", JSON.stringify({ version: 1, entries: [] })],
    ["different method", JSON.stringify({ version: 1, entries: [{ entryId: "entry-1", effectClass: "NE", api: "SYNO.Fixture", method: "delete", apiVersion: 1, targetIds: ["opaque-target"] }] })],
    ["different target scope", JSON.stringify({ version: 1, entries: [{ entryId: "entry-1", effectClass: "NE", api: "SYNO.Fixture", method: "set", apiVersion: 1, targetIds: ["other-target"] }] })],
    ["different api version", JSON.stringify({ version: 1, entries: [{ entryId: "entry-1", effectClass: "NE", api: "SYNO.Fixture", method: "set", apiVersion: 2, targetIds: ["opaque-target"] }] })],
    ["unversioned free text", "fixture register"],
    ["unknown field", JSON.stringify({ version: 1, entries: [], extra: true })],
    ["unparseable JSON", '{"version":1,"entries":['],
  ])("denies when the bound register does not authorize the operation: %s", async (_name, registerBody) => {
    const f = await fixture(registerBody);
    const invocation = await f.svc.recordInvocation({ serviceId: f.service.id, issuer: f.issuer, operation: f.operation,
      operationDocumentId: f.operationDocumentId, operationRevisionId: f.operationRevisionId, reviewIssueId: f.reviewIssueId,
      reviewerAgentId: f.reviewerAgentId, fpInteractionId: f.fpInteractionId, humanInteractionId: f.humanInteractionId });
    const verified = await f.svc.verify(f.principal, { invocationId: invocation.id, opHash: f.opHash, idempotencyKey: "verify-register" });
    expect(verified).toMatchObject({ decision: "deny", reasonCode: "register_unauthorized", verificationId: null });
    expect(await db.select().from(governanceAuditEvents).where(eq(governanceAuditEvents.companyId, f.companyId))).toHaveLength(0);
  });
  it("maps an idempotency key reused by the same credential for another invocation to 409", async () => {
    const first = await verifiedFixture();
    const second = await fixture(undefined, first);
    const invocation = await second.svc.recordInvocation({ serviceId: second.service.id, issuer: second.issuer, operation: second.operation,
      operationDocumentId: second.operationDocumentId, operationRevisionId: second.operationRevisionId, reviewIssueId: second.reviewIssueId,
      reviewerAgentId: second.reviewerAgentId, fpInteractionId: second.fpInteractionId, humanInteractionId: second.humanInteractionId });
    expect(invocation.id).not.toBe(first.invocation.id);
    // Same credential, same key, different invocation: a clean conflict, never a 500.
    await expect(second.svc.verify(second.principal, { invocationId: invocation.id, opHash: second.opHash, idempotencyKey: "verify" }))
      .rejects.toMatchObject({ status: 409 });
    const app = express(); app.use(express.json()); app.use(governanceMachineBoundary(db)); app.use(errorHandler);
    const reused = await request(app).post("/api/governance/dsm/v1/verifications").set("Authorization", `Bearer ${first.credential.token}`)
      .send({ invocationId: invocation.id, opHash: second.opHash, idempotencyKey: "verify" });
    expect(reused.status).toBe(409);
    // The idempotent retry for the original invocation is unchanged.
    const retry = await first.svc.verify(first.principal, { invocationId: first.invocation.id, opHash: first.opHash, idempotencyKey: "verify" });
    expect(retry).toMatchObject({ decision: "allow", verificationId: first.verified.verificationId });
    // A fresh key still verifies the second invocation.
    expect((await second.svc.verify(second.principal, { invocationId: invocation.id, opHash: second.opHash, idempotencyKey: "verify-2" })).decision).toBe("allow");
  });
  async function registeredFixture(registerOverride?: string) {
    const f = await fixture(registerOverride);
    const invocation = await f.svc.recordInvocation({ serviceId: f.service.id, issuer: f.issuer, operation: f.operation,
      operationDocumentId: f.operationDocumentId, operationRevisionId: f.operationRevisionId, reviewIssueId: f.reviewIssueId,
      reviewerAgentId: f.reviewerAgentId, fpInteractionId: f.fpInteractionId, humanInteractionId: f.humanInteractionId });
    return { ...f, invocation };
  }
  it.each([
    ["register is not linked to the operation issue", "register_invalid"],
    ["bound register revision row is missing", "register_invalid"],
    ["register document is unlocked", "revision_stale"],
    ["register document is missing", "revision_stale"],
  ] as const)("denies when the %s with %s", async (fault, reasonCode) => {
    const f = await registeredFixture();
    const registerId = f.operation.registerDocumentId;
    if (fault === "register is not linked to the operation issue") await db.delete(issueDocuments).where(eq(issueDocuments.documentId, registerId));
    if (fault === "bound register revision row is missing") await db.delete(documentRevisions).where(eq(documentRevisions.documentId, registerId));
    if (fault === "register document is unlocked") await db.update(documents).set({ lockedAt: null }).where(eq(documents.id, registerId));
    if (fault === "register document is missing") {
      await db.delete(issueDocuments).where(eq(issueDocuments.documentId, registerId));
      await db.delete(documentRevisions).where(eq(documentRevisions.documentId, registerId));
      await db.delete(documents).where(eq(documents.id, registerId));
    }
    const verified = await f.svc.verify(f.principal, { invocationId: f.invocation.id, opHash: f.opHash, idempotencyKey: "verify-register" });
    expect(verified).toMatchObject({ decision: "deny", reasonCode, verificationId: null });
    expect(await db.select().from(governanceVerifications).where(eq(governanceVerifications.invocationId, f.invocation.id))).toHaveLength(0);
  });
  it("accepts every documented outcome claim and rejects mismatched type/reason pairs", async () => {
    for (const claim of [
      { type: "succeeded", reasonCode: "none" },
      { type: "failed", reasonCode: "provider_failed" },
      { type: "unknown", reasonCode: "outcome_unknown" },
    ]) {
      const f = await verifiedFixture();
      const consumed = await f.svc.consume(f.principal, f.verified.verificationId, { opHash: f.opHash, idempotencyKey: "consume" });
      for (const [type, reasonCode] of [["succeeded", "provider_failed"], ["succeeded", "outcome_unknown"], ["failed", "none"],
        ["failed", "outcome_unknown"], ["unknown", "none"], ["unknown", "provider_failed"]]) {
        await expect(f.svc.appendEvent(f.principal, consumed.dispatchId, { type, reasonCode, idempotencyKey: `bad-${type}-${reasonCode}` }), `${type}/${reasonCode}`)
          .rejects.toMatchObject({ status: 422 });
      }
      const event = { ...claim, idempotencyKey: "outcome", artifactDigest: "c".repeat(64) };
      const recorded = await f.svc.appendEvent(f.principal, consumed.dispatchId, event);
      expect(recorded.noReplay).toBe(true);
      expect((await f.svc.appendEvent(f.principal, consumed.dispatchId, event)).id).toBe(recorded.id);
      const rows = await db.select().from(governanceAuditEvents).where(eq(governanceAuditEvents.dispatchId, consumed.dispatchId));
      expect(rows.map(row => [row.type, row.reasonCode]).sort()).toEqual([["audit_intent", "none"], [claim.type, claim.reasonCode]].sort());
    }
  });
  it("bounds credential lifetime and never caches the issued token", async () => {
    const f = await fixture();
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "board", userId: f.ownerUserId, source: "session", companyIds: [f.companyId], memberships: [{ companyId: f.companyId, membershipRole: "owner", status: "active" }] }; next(); });
    app.use("/api", governanceOwnerRoutes(db)); app.use(errorHandler);
    const url = `/api/companies/${f.companyId}/governance/services/${f.service.id}/credentials`;
    for (const expiresAt of [new Date(Date.now() + 86_400_000 + 60_000), new Date(Date.now() - 1_000), new Date(Date.now() - 86_400_000)]) {
      const rejected = await request(app).post(url).send({ expiresAt: expiresAt.toISOString() });
      expect(rejected.status, expiresAt.toISOString()).toBe(422);
    }
    expect((await request(app).post(url).send({ expiresAt: "tomorrow" })).status).toBe(422);
    expect(await f.svc.listCredentials(f.service.id, f.ownerUserId)).toHaveLength(1);
    const issued = await request(app).post(url).send({ expiresAt: new Date(Date.now() + 86_400_000 - 60_000).toISOString() });
    expect(issued.status).toBe(201);
    expect(issued.headers["cache-control"]).toBe("no-store");
    expect(issued.body.token).toMatch(/^pcgov_[a-f0-9]{64}$/);
  });
  it("returns 404 when revoking an unknown or another service's credential", async () => {
    const f = await fixture();
    const sibling = await f.svc.createService({ companyId: f.companyId, ownerUserId: f.ownerUserId, nasTarget: "sibling-nas" });
    const siblingCredential = await f.svc.issueCredential(sibling.id, f.ownerUserId, new Date(Date.now() + 60_000));
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "board", userId: f.ownerUserId, source: "session", companyIds: [f.companyId], memberships: [{ companyId: f.companyId, membershipRole: "owner", status: "active" }] }; next(); });
    app.use("/api", governanceOwnerRoutes(db)); app.use(errorHandler);
    const url = `/api/companies/${f.companyId}/governance/services/${f.service.id}/credentials`;
    for (const id of [randomUUID(), siblingCredential.id, "not-a-uuid"]) {
      expect((await request(app).delete(`${url}/${id}`)).status, id).toBe(404);
    }
    expect((await f.svc.authenticate(siblingCredential.token)).credentialId).toBe(siblingCredential.id);
    expect((await f.svc.authenticate(f.credential.token)).credentialId).toBe(f.credential.id);
  });
  it("refuses company deletion with a clear conflict while a governance service exists", async () => {
    const f = await fixture();
    await expect(companyService(db).remove(f.companyId)).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(companies).where(eq(companies.id, f.companyId))).toHaveLength(1);
    expect(await db.select().from(governanceServices).where(eq(governanceServices.companyId, f.companyId))).toHaveLength(1);
  });
  it("denies consume after the service owner loses company authority", async () => {
    const f = await verifiedFixture();
    await db.update(companyMemberships).set({ membershipRole: "viewer" }).where(eq(companyMemberships.companyId, f.companyId));
    await expect(f.svc.consume(f.principal, f.verified.verificationId, { opHash: f.opHash, idempotencyKey: "revoked-owner" })).rejects.toMatchObject({ status: 401 });
  });
  it("checks expiry after waiting for the operation issue lock", async () => {
    const f = await verifiedFixture();
    let release!: () => void, locked!: () => void;
    const lockReady = new Promise<void>(resolve => { locked = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    const blocker = db.transaction(async tx => {
      await tx.select().from(issues).where(eq(issues.id, f.issueId)).for("update");
      locked(); await hold;
    });
    await lockReady;
    await db.update(governanceVerifications).set({ expiresAt: new Date(Date.now() + 500) }).where(eq(governanceVerifications.id, f.verified.verificationId!));
    const outcome = f.svc.consume(f.principal, f.verified.verificationId, { opHash: f.opHash, idempotencyKey: "blocked" }).then(value => ({ value, error: null }), error => ({ value: null, error }));
    try {
      await vi.waitFor(async () => {
        const waiters = await db.execute(sql`select pid from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and cardinality(pg_blocking_pids(pid)) > 0`);
        expect(waiters.length).toBeGreaterThan(0);
      });
      await db.execute(sql`select pg_sleep(0.6)`);
    } finally { release(); await blocker; }
    expect((await outcome).error).toMatchObject({ status: 409 });
  });
  it("requires an active assigned reviewer run for narrow evidence", async () => {
    const f = await verifiedFixture();
    await expect(f.svc.evidence(f.companyId, f.reviewerAgentId, f.reviewRunId, f.issueId)).rejects.toMatchObject({ status: 403 });
  });
  it("linearizes concurrent consume to one intent and refuses mismatched replay", async () => {
    const f = await verifiedFixture();
    const responses = await Promise.all(Array.from({ length: 8 }, () => f.svc.consume(f.principal, f.verified.verificationId, { opHash: f.opHash, idempotencyKey: "race" })));
    expect(responses.filter(r => r.dispatchAllowed)).toHaveLength(1);
    expect(new Set(responses.map(r => r.dispatchId)).size).toBe(1);
    await expect(f.svc.consume(f.principal, f.verified.verificationId, { opHash: f.opHash, idempotencyKey: "changed" })).rejects.toMatchObject({ status: 409 });
  });
  it("rechecks revoked credentials at consume and masks foreign invocation IDs", async () => {
    const f = await verifiedFixture(), other = await fixture();
    await expect(other.svc.verify(other.principal, { invocationId: f.invocation.id, opHash: f.opHash, idempotencyKey: "other" })).rejects.toMatchObject({ status: 404 });
    await f.svc.revokeCredential(f.service.id, f.credential.id, f.ownerUserId);
    await expect(f.svc.consume(f.principal, f.verified.verificationId, { opHash: f.opHash, idempotencyKey: "revoked" })).rejects.toMatchObject({ status: 401 });
  });
  it("appends structured unknown outcome once and never authorizes replay", async () => {
    const f = await verifiedFixture();
    const consumed = await f.svc.consume(f.principal, f.verified.verificationId, { opHash: f.opHash, idempotencyKey: "consume" });
    const unknown = await f.svc.appendEvent(f.principal, consumed.dispatchId, { type: "unknown", reasonCode: "outcome_unknown", idempotencyKey: "unknown-1" });
    expect(unknown.noReplay).toBe(true);
    expect((await f.svc.appendEvent(f.principal, consumed.dispatchId, { type: "unknown", reasonCode: "outcome_unknown", idempotencyKey: "unknown-1" })).id).toBe(unknown.id);
    await expect(f.svc.appendEvent(f.principal, consumed.dispatchId, { type: "succeeded", reasonCode: "none", idempotencyKey: "fake-reconcile" })).rejects.toMatchObject({ status: 409 });
    await expect(f.svc.appendEvent(f.principal, consumed.dispatchId, { type: "unknown", reasonCode: "outcome_unknown", idempotencyKey: "poison", rawLog: "password @Owner" })).rejects.toMatchObject({ status: 422 });
    expect((await f.svc.consume(f.principal, f.verified.verificationId, { opHash: f.opHash, idempotencyKey: "consume" })).dispatchAllowed).toBe(false);
  });
  it("makes the audit ledger append-only at the database boundary", async () => {
    const f = await verifiedFixture();
    await f.svc.consume(f.principal, f.verified.verificationId, { opHash: f.opHash, idempotencyKey: "consume" });
    await expect(db.execute(sql`update governance_audit_events set reason_code = 'forged' where company_id = ${f.companyId}`)).rejects.toThrow();
    await expect(db.execute(sql`delete from governance_audit_events where company_id = ${f.companyId}`)).rejects.toThrow();
  });
  it("rolls back consume when the intent sink fails", async () => {
    const f = await verifiedFixture();
    await db.execute(sql`create function governance_test_sink_failure() returns trigger language plpgsql as $$ begin raise exception 'fixture sink down'; end $$`);
    await db.execute(sql`create trigger governance_test_sink_failure before insert on governance_audit_events for each row execute function governance_test_sink_failure()`);
    try {
      await expect(f.svc.consume(f.principal, f.verified.verificationId, { opHash: f.opHash, idempotencyKey: "consume" })).rejects.toThrow();
    } finally {
      await db.execute(sql`drop trigger governance_test_sink_failure on governance_audit_events`);
      await db.execute(sql`drop function governance_test_sink_failure()`);
    }
    expect((await f.svc.consume(f.principal, f.verified.verificationId, { opHash: f.opHash, idempotencyKey: "consume" })).dispatchAllowed).toBe(true);
  });
  it("serves the dedicated HTTP path and owner-only credential rotation/revoke", async () => {
    const f = await verifiedFixture();
    const app = express(); app.use(express.json()); app.use(governanceMachineBoundary(db));
    app.use((req, _res, next) => { req.actor = { type: "board", userId: f.ownerUserId, source: "session", companyIds: [f.companyId], memberships: [{ companyId: f.companyId, membershipRole: "owner", status: "active" }] }; next(); });
    app.use("/api", governanceOwnerRoutes(db)); app.use(errorHandler);
    const url = `/api/companies/${f.companyId}/governance/services/${f.service.id}/credentials`;
    const created = await request(app).post(url).send({ expiresAt: new Date(Date.now() + 60_000).toISOString() });
    expect(created.status).toBe(201); expect(created.body.token).toMatch(/^pcgov_/);
    expect((await request(app).get(url)).body[0]).not.toHaveProperty("tokenHash");
    const denied = await request(app).post("/api/governance/dsm/v1/verifications").set("Authorization", `Bearer ${f.credential.token}`).send({ invocationId: f.invocation.id, opHash: f.opHash, idempotencyKey: "verify" });
    expect(denied.status).toBe(200); expect(denied.body.decision).toBe("allow");
    expect((await request(app).post(`/api/governance/dsm/v1/verifications/${f.verified.verificationId}/consume`).set("Authorization", `Bearer ${f.credential.token}`).send({ opHash: f.opHash, idempotencyKey: "consume" })).body.dispatchAllowed).toBe(true);
    expect((await request(app).delete(`${url}/${created.body.id}`)).status).toBe(204);
    await expect(f.svc.authenticate(created.body.token)).rejects.toMatchObject({ status: 401 });
    expect((await request(app).post(url.replace(f.companyId, randomUUID())).send({ expiresAt: new Date(Date.now() + 60_000).toISOString() })).status).toBe(403);
  });
  it("denies non-owner actors and cross-company service IDs without minting credentials", async () => {
    const f = await fixture(), other = await fixture();
    for (const actor of [
      { type: "none" },
      { type: "agent", companyId: f.companyId, agentId: f.agentId },
      { type: "board", userId: f.ownerUserId, source: "local_implicit" },
      { type: "board", userId: f.ownerUserId, source: "session", companyIds: [f.companyId], memberships: [{ companyId: f.companyId, status: "active", membershipRole: "viewer" }] },
    ]) {
      const app = express(); app.use(express.json());
      app.use((req, _res, next) => { req.actor = actor as typeof req.actor; next(); });
      app.use("/api", governanceOwnerRoutes(db)); app.use(errorHandler);
      expect((await request(app).post(`/api/companies/${f.companyId}/governance/services/${f.service.id}/credentials`).send({ expiresAt: new Date(Date.now() + 60_000).toISOString() })).status).toBe(403);
    }
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "board", userId: f.ownerUserId, source: "session", companyIds: [other.companyId], memberships: [{ companyId: other.companyId, status: "active", membershipRole: "owner" }] }; next(); });
    app.use("/api", governanceOwnerRoutes(db)); app.use(errorHandler);
    expect((await request(app).get(`/api/companies/${other.companyId}/governance/services/${f.service.id}/credentials`)).status).toBe(404);
    expect(await f.svc.listCredentials(f.service.id, f.ownerUserId)).toHaveLength(1);
  });
  it("rejects stale owner authority at service creation, credential issuance and invocation registration", async () => {
    const f = await fixture();
    await db.update(companyMemberships).set({ membershipRole: "viewer" }).where(eq(companyMemberships.companyId, f.companyId));
    await expect(f.svc.createService({ companyId: f.companyId, ownerUserId: f.ownerUserId, nasTarget: "another-nas" })).rejects.toMatchObject({ status: 403 });
    await expect(f.svc.issueCredential(f.service.id, f.ownerUserId, new Date(Date.now() + 60_000))).rejects.toMatchObject({ status: 403 });
    await expect(f.svc.recordInvocation({ serviceId: f.service.id, issuer: f.issuer, operation: f.operation,
      operationDocumentId: f.operationDocumentId, operationRevisionId: f.operationRevisionId, reviewIssueId: f.reviewIssueId,
      reviewerAgentId: f.reviewerAgentId, fpInteractionId: f.fpInteractionId, humanInteractionId: f.humanInteractionId })).rejects.toMatchObject({ status: 403 });
  });
  it("retries and renews only unused invocations, invalidates old reservations and never renews a dispatch", async () => {
    const f = await verifiedFixture();
    const input = { serviceId: f.service.id, issuer: f.issuer, operation: f.operation,
      operationDocumentId: f.operationDocumentId, operationRevisionId: f.operationRevisionId, reviewIssueId: f.reviewIssueId,
      reviewerAgentId: f.reviewerAgentId, fpInteractionId: f.fpInteractionId, humanInteractionId: f.humanInteractionId };
    expect((await f.svc.recordInvocation(input)).id).toBe(f.invocation.id);
    await db.execute(sql`update governance_invocations set expires_at = clock_timestamp() - interval '1 second' where id = ${f.invocation.id}`);
    const renewed = await f.svc.recordInvocation(input);
    expect(renewed.id).toBe(f.invocation.id);
    expect(renewed.expiresAt.getTime()).toBeGreaterThan(Date.now());
    await expect(f.svc.consume(f.principal, f.verified.verificationId, { opHash: f.opHash, idempotencyKey: "old" })).rejects.toMatchObject({ status: 404 });
    const verified = await f.svc.verify(f.principal, { invocationId: renewed.id, opHash: f.opHash, idempotencyKey: "new" });
    expect(verified.decision).toBe("allow");
    expect(verified.verificationId).not.toBe(f.verified.verificationId);
    await f.svc.consume(f.principal, verified.verificationId, { opHash: f.opHash, idempotencyKey: "dispatch" });
    await expect(f.svc.recordInvocation(input)).rejects.toMatchObject({ status: 409 });
    await expect(f.svc.recordInvocation({ ...input, humanInteractionId: randomUUID() })).rejects.toMatchObject({ status: 409 });
  });
  it.each(["expired", "revoked"])("allows %s original credentials only to close their existing dispatch over HTTP", async state => {
    const f = await verifiedFixture(), other = await verifiedFixture();
    const consumed = await f.svc.consume(f.principal, f.verified.verificationId, { opHash: f.opHash, idempotencyKey: "consume" });
    const foreign = await other.svc.consume(other.principal, other.verified.verificationId, { opHash: other.opHash, idempotencyKey: "consume" });
    const replacement = await f.svc.issueCredential(f.service.id, f.ownerUserId, new Date(Date.now() + 60_000));
    if (state === "expired") await db.execute(sql`update governance_credentials set expires_at = clock_timestamp() - interval '1 second' where id = ${f.credential.id}`);
    else await f.svc.revokeCredential(f.service.id, f.credential.id, f.ownerUserId);
    const app = express(); app.use(express.json()); app.use(governanceMachineBoundary(db)); app.use(errorHandler);
    const event = { type: "succeeded", reasonCode: "none", idempotencyKey: "result" };
    const report = () => request(app).post(`/api/governance/dsm/v1/dispatches/${consumed.dispatchId}/events`).set("Authorization", `Bearer ${f.credential.token}`).send(event);
    const result = await report();
    expect(result.status).toBe(200); expect(result.body.noReplay).toBe(true);
    expect((await report()).body.id).toBe(result.body.id);
    expect((await request(app).post(`/api/governance/dsm/v1/dispatches/${foreign.dispatchId}/events`).set("Authorization", `Bearer ${f.credential.token}`).send(event)).status).toBe(404);
    expect((await request(app).post(`/api/governance/dsm/v1/dispatches/${consumed.dispatchId}/events`).set("Authorization", `Bearer ${replacement.token}`).send(event)).status).toBe(404);
    expect((await request(app).post(`/api/governance/dsm/v1/verifications/${f.verified.verificationId}/consume`).set("Authorization", `Bearer ${f.credential.token}`).send({ opHash: f.opHash, idempotencyKey: "consume" })).status).toBe(401);
    expect((await request(app).post("/api/governance/dsm/v1/verifications").set("Authorization", `Bearer ${f.credential.token}`).send({ invocationId: f.invocation.id, opHash: f.opHash, idempotencyKey: "verify" })).status).toBe(401);
  });
  it.each(["issue", "register", "consume"])("rechecks owner membership after a concurrent revocation commits during %s", async action => {
    const f = await verifiedFixture();
    let release!: () => void, locked!: () => void;
    const ready = new Promise<void>(resolve => { locked = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    const blocker = db.transaction(async tx => {
      await tx.update(companyMemberships).set({ membershipRole: "viewer" }).where(eq(companyMemberships.companyId, f.companyId));
      locked(); await hold;
    });
    await ready;
    const pending = action === "issue" ? f.svc.issueCredential(f.service.id, f.ownerUserId, new Date(Date.now() + 60_000))
      : action === "register" ? f.svc.recordInvocation({ serviceId: f.service.id, issuer: f.issuer, operation: f.operation,
        operationDocumentId: f.operationDocumentId, operationRevisionId: f.operationRevisionId, reviewIssueId: f.reviewIssueId,
        reviewerAgentId: f.reviewerAgentId, fpInteractionId: f.fpInteractionId, humanInteractionId: f.humanInteractionId })
        : f.svc.consume(f.principal, f.verified.verificationId, { opHash: f.opHash, idempotencyKey: "race-owner" });
    const result = pending.then(value => ({ value, error: null }), error => ({ value: null, error }));
    try {
      await vi.waitFor(async () => {
        const waiters = await db.execute(sql`select pid from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and cardinality(pg_blocking_pids(pid)) > 0`);
        expect(waiters.length).toBeGreaterThan(0);
      });
    } finally { release(); await blocker; }
    expect((await result).error).toMatchObject({ status: action === "consume" ? 401 : 403 });
    expect(await db.select().from(governanceCredentials).where(eq(governanceCredentials.serviceId, f.service.id))).toHaveLength(1);
    expect(await db.select().from(governanceAuditEvents).where(eq(governanceAuditEvents.companyId, f.companyId))).toHaveLength(0);
  });
  it.each(["service_created", "service_revoked", "credential_issued", "credential_revoked"])("rolls back %s when its activity sink fails", async action => {
    const f = await fixture();
    const beforeServices = await db.select().from(governanceServices).where(eq(governanceServices.companyId, f.companyId));
    const beforeCredentials = await f.svc.listCredentials(f.service.id, f.ownerUserId);
    await db.execute(sql`create function governance_lifecycle_sink_failure() returns trigger language plpgsql as $$ begin if NEW.action = TG_ARGV[0] then raise exception 'fixture lifecycle sink down'; end if; return NEW; end $$`);
    // Fixed enum-derived trigger argument, no request data or live database.
    await db.execute(sql.raw(`create trigger governance_lifecycle_sink_failure before insert on activity_log for each row execute function governance_lifecycle_sink_failure('governance.${action}')`));
    try {
      const change = action === "service_created" ? f.svc.createService({ companyId: f.companyId, ownerUserId: f.ownerUserId, nasTarget: "rollback-nas" })
        : action === "service_revoked" ? f.svc.revokeService(f.service.id, f.ownerUserId)
          : action === "credential_issued" ? f.svc.issueCredential(f.service.id, f.ownerUserId, new Date(Date.now() + 60_000))
            : f.svc.revokeCredential(f.service.id, f.credential.id, f.ownerUserId);
      await expect(change).rejects.toThrow();
    } finally {
      await db.execute(sql`drop trigger governance_lifecycle_sink_failure on activity_log`);
      await db.execute(sql`drop function governance_lifecycle_sink_failure()`);
    }
    expect(await db.select().from(governanceServices).where(eq(governanceServices.companyId, f.companyId))).toEqual(beforeServices);
    expect(await f.svc.listCredentials(f.service.id, f.ownerUserId)).toEqual(beforeCredentials);
    expect((await f.svc.authenticate(f.credential.token)).credentialId).toBe(f.credential.id);
  });
  it.each([false, true])("rejects outcome after the 24h window, including post-lock expiry=%s", async waitForLock => {
    const f = await verifiedFixture();
    const dispatchId = randomUUID();
    // Seed historical committed intent rather than UPDATE an append-only row.
    await db.update(governanceVerifications).set({ dispatchId, consumeKey: "historical" }).where(eq(governanceVerifications.id, f.verified.verificationId!));
    await db.insert(governanceAuditEvents).values({ companyId: f.companyId, verificationId: f.verified.verificationId!, dispatchId,
      type: "audit_intent", reasonCode: "none", idempotencyKey: "intent", createdAt: new Date(Date.now() - 86_400_000 + (waitForLock ? 500 : -1000)) });
    let release!: () => void, locked!: () => void;
    const ready = new Promise<void>(resolve => { locked = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    const blocker = waitForLock ? db.transaction(async tx => {
      await tx.select().from(governanceServices).where(eq(governanceServices.id, f.service.id)).for("update");
      locked(); await hold;
    }) : Promise.resolve();
    if (waitForLock) await ready;
    const result = f.svc.appendEvent(f.principal, dispatchId, { type: "succeeded", reasonCode: "none", idempotencyKey: "late" }).then(value => ({ value, error: null }), error => ({ value: null, error }));
    if (waitForLock) {
      try {
        await vi.waitFor(async () => {
          const waiters = await db.execute(sql`select pid from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and cardinality(pg_blocking_pids(pid)) > 0`);
          expect(waiters.length).toBeGreaterThan(0);
        });
        await db.execute(sql`select pg_sleep(0.6)`);
      } finally { release(); await blocker; }
    }
    expect((await result).error).toMatchObject({ status: 403 });
    expect((await db.select().from(governanceAuditEvents).where(eq(governanceAuditEvents.dispatchId, dispatchId))).map(row => row.type)).toEqual(["audit_intent"]);
  });
  it("creates and revokes a service through owner HTTP with atomic content-free lifecycle audit", async () => {
    const f = await fixture();
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "board", userId: f.ownerUserId, source: "session", companyIds: [f.companyId], memberships: [{ companyId: f.companyId, membershipRole: "owner", status: "active" }] }; next(); });
    app.use("/api", governanceOwnerRoutes(db)); app.use(errorHandler);
    const base = `/api/companies/${f.companyId}/governance/services`;
    const created = await request(app).post(base).send({ nasTarget: "new-nas" });
    expect(created.status).toBe(201);
    const issued = await request(app).post(`${base}/${created.body.id}/credentials`).send({ expiresAt: new Date(Date.now() + 60_000).toISOString() });
    expect(issued.status).toBe(201);
    const principal = await f.svc.authenticate(issued.body.token);
    expect((await request(app).delete(`${base}/${created.body.id}/credentials/${issued.body.id}`)).status).toBe(204);
    expect((await request(app).delete(`${base}/${created.body.id}/credentials/${issued.body.id}`)).status).toBe(204);
    expect((await request(app).delete(`${base}/${created.body.id}`)).status).toBe(204);
    expect((await request(app).delete(`${base}/${created.body.id}`)).status).toBe(204);
    await expect(f.svc.authenticate(issued.body.token)).rejects.toMatchObject({ status: 401 });
    await expect(f.svc.verify(principal, { invocationId: randomUUID(), opHash: f.opHash, idempotencyKey: "revoked" })).rejects.toMatchObject({ status: 401 });
    expect((await request(app).post(`${base}/${created.body.id}/credentials`).send({ expiresAt: new Date(Date.now() + 60_000).toISOString() })).status).toBe(403);
    const events = (await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId))).filter(row => row.entityId === created.body.id);
    expect(events.map(row => row.action).sort()).toEqual(["governance.credential_issued", "governance.credential_revoked", "governance.service_created", "governance.service_revoked"].sort());
    expect(events.every(row => row.actorType === "user" && row.actorId === f.ownerUserId)).toBe(true);
    expect(JSON.stringify(events)).not.toContain(issued.body.token);
    expect(JSON.stringify(events)).not.toContain(createHash("sha256").update(issued.body.token).digest("hex"));
  });
  it("issues a company/NAS credential with expiry, hash-only storage and revocation", async () => {
    const companyId = randomUUID();
    const ownerUserId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "isolated governance", issuePrefix: "GOV" });
    await db.insert(authUsers).values({ id: ownerUserId, name: "Owner", email: `${ownerUserId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: ownerUserId, status: "active", membershipRole: "owner" });
    const svc = governanceService(db);
    const service = await svc.createService({ companyId, ownerUserId, nasTarget: "fixture-nas" });
    const credential = await svc.issueCredential(service.id, ownerUserId, new Date(Date.now() + 60_000));
    expect(credential.token).toMatch(/^pcgov_[a-f0-9]{64}$/);
    const principal = await svc.authenticate(credential.token);
    expect(principal).toMatchObject({ companyId, nasTarget: "fixture-nas", serviceId: service.id });
    const stored = await svc.listCredentials(service.id, ownerUserId);
    expect(JSON.stringify(stored)).not.toContain(credential.token);
    expect(stored[0]).not.toHaveProperty("tokenHash");
    await svc.revokeCredential(service.id, credential.id, ownerUserId);
    await expect(svc.authenticate(credential.token)).rejects.toMatchObject({ status: 401 });
  });
});
