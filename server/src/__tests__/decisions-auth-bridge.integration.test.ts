import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, heartbeatRuns, issueThreadInteractions } from "@paperclipai/db";
import { authorizeSandboxCallbackBridgeRequestWithRoutes, HTTP2_SANDBOX_CALLBACK_BRIDGE_ROUTE_ALLOWLIST } from "../../../packages/adapter-utils/src/sandbox-callback-bridge.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { documentService } from "../services/documents.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { startRunnerApiTestServer } from "./helpers/runner-api-server.js";

describe("Decisions sandbox read boundary", () => {
  it("permits only the expert GET across both bridge transports", () => {
    const path = "/api/companies/company-id/attention/expert";
    for (const routes of [undefined, HTTP2_SANDBOX_CALLBACK_BRIDGE_ROUTE_ALLOWLIST]) {
      expect(authorizeSandboxCallbackBridgeRequestWithRoutes({ method: "GET", path }, routes)).toBeNull();
      for (const denied of [
        ...["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].map((method) => ({ method, path })),
        { method: "GET", path: "/api/companies/company-id/attention" },
        { method: "GET", path: `${path}/extra` },
        { method: "GET", path: `${path}/` },
        { method: "GET", path: "/api/companies//attention/expert" },
        { method: "GET", path: "/api/companies/company-id/attention/human" },
        { method: "GET", path: "/api/decisions/decision-id/decide" },
        { method: "POST", path: "/api/decisions/decision-id/decide" },
      ]) expect(authorizeSandboxCallbackBridgeRequestWithRoutes(denied, routes)).not.toBeNull();
    }
  });
});

describe("Decisions through the production authenticated app", () => {
  let server: Awaited<ReturnType<typeof startRunnerApiTestServer>>;
  const originalSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  beforeAll(async () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "disposable-decisions-test-secret";
    server = await startRunnerApiTestServer();
    await instanceSettingsService(server.db).updateExperimental({ enableIsolatedWorkspaces: false });
  }, 60_000);
  afterAll(async () => {
    await server?.close();
    if (originalSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = originalSecret;
  });

  async function fixture() {
    const f = await server.fixture({ disableWakeOnDemand: true });
    const reviewerId = randomUUID(), reviewerRunId = randomUUID();
    await server.db.insert(agents).values({ id: reviewerId, companyId: f.companyId, name: "Independent reviewer", adapterType: "codex_local", status: "active", runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } } });
    await server.db.insert(heartbeatRuns).values({ id: reviewerRunId, companyId: f.companyId, agentId: reviewerId, status: "running", contextSnapshot: { issueId: f.issueId } });
    const token = createLocalAgentJwt(reviewerId, f.companyId, "codex_local", reviewerRunId, null)!;
    const call = (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) => fetch(`${server.apiUrl}${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const svc = issueThreadInteractionService(server.db);
    const create = (resolverPolicy: "not_creator" | "human_only" = "not_creator", target?: Record<string, unknown>) => svc.create({ id: f.issueId, companyId: f.companyId }, {
      kind: "request_confirmation", addresseeAgentId: reviewerId, resolverPolicy, continuationPolicy: "none",
      payload: { version: 1, prompt: "Review this revision only; no implementation authorized", ...(target ? { target } : {}), ...(resolverPolicy === "not_creator" ? { brief: { version: 1, decisionClass: "expert_review", purpose: "plan_review", subject: "Independent revision review", resolverTarget: { type: "agent", agentId: reviewerId, reason: "Independent expert" }, evidenceRefs: [{ source: "Issue document", revision: "1" }], selectionConsequences: [{ optionId: "accept", consequence: "Record review only" }, { optionId: "reject", consequence: "Revise" }], safeDefault: "No implementation" } } : {}) },
    } as Parameters<typeof svc.create>[1], { agentId: f.agentId, runId: f.runId }, { supersedePendingSiblingInteractions: false });
    return { ...f, reviewerId, reviewerRunId, call, create };
  }

  it("uses verified JWT identity for own read and denies foreign, Board, spoofed and anonymous reads", async () => {
    const f = await fixture();
    const own = await f.create();
    await f.create("human_only");
    const otherReviewerId = randomUUID();
    await server.db.insert(agents).values({ id: otherReviewerId, companyId: f.companyId, name: "Other reviewer", adapterType: "codex_local", status: "active", runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } } });
    await issueThreadInteractionService(server.db).create({ id: f.issueId, companyId: f.companyId }, {
      kind: "request_confirmation", addresseeAgentId: otherReviewerId, resolverPolicy: "not_creator", continuationPolicy: "none",
      payload: { version: 1, prompt: "Only the other reviewer may answer" },
    }, { agentId: f.agentId, runId: f.runId }, { supersedePendingSiblingInteractions: false });
    const path = `/api/companies/${f.companyId}/attention/expert`;
    const response = await f.call(path);
    expect(response.status).toBe(200);
    const feed = await response.json();
    expect(feed.items.map((item: { subject: { id: string } }) => item.subject.id)).toEqual([own.id]);
    expect((await f.call(`/api/companies/${f.foreignCompanyId}/attention/expert`)).status).toBe(403);
    expect((await f.call(`/api/companies/${f.companyId}/attention`)).status).toBe(403);
    for (const query of [`resolverAgentId=${f.agentId}`, "audience=human", "all=true", "queue=board"]) {
      expect((await f.call(`${path}?${query}`)).status).toBe(400);
    }
    expect((await f.call(path, "GET", undefined, { "X-Paperclip-Run-Id": f.runId })).status).toBe(422);
    expect((await fetch(`${server.apiUrl}${path}`)).status).toBe(401);
    expect((await fetch(`${server.apiUrl}${path}`, { headers: { Authorization: "Bearer invalid-test-token" } })).status).toBe(401);
    expect((await f.call(`/api/decisions/${randomUUID()}/decide`, "POST", { optionId: "accept" })).status).toBe(403);
  });

  it("rejects human-only agent votes and records a genuine independent agent plus run on native acceptance", async () => {
    const f = await fixture();
    const human = await issueThreadInteractionService(server.db).create({ id: f.issueId, companyId: f.companyId }, {
      kind: "request_confirmation", sourceRunId: f.runId, resolverPolicy: "human_only", continuationPolicy: "none",
      payload: { version: 1, prompt: "Independent Board review only", brief: { version: 1, decisionClass: "expert_review", purpose: "plan_review", subject: "Human Board review", resolverTarget: { type: "human", reason: "Independent Board reviewer" }, evidenceRefs: [{ source: "Issue document", revision: "1" }], selectionConsequences: [{ optionId: "accept", consequence: "Record review only" }, { optionId: "reject", consequence: "Revise" }], safeDefault: "No implementation" } },
    }, { agentId: f.agentId, runId: f.runId }, { supersedePendingSiblingInteractions: false });
    const humanPath = `/api/issues/${f.issueId}/interactions/${human.id}/accept`;
    expect((await f.call(humanPath, "POST", {})).status).toBe(403);
    const creatorToken = createLocalAgentJwt(f.agentId, f.companyId, "paperclip_runner", f.runId, null)!;
    expect((await fetch(`${server.apiUrl}${humanPath}`, { method: "POST", headers: { Authorization: `Bearer ${creatorToken}`, "Content-Type": "application/json" }, body: "{}" })).status).toBe(403);
    expect(await issueThreadInteractionService(server.db).getById(human.id)).toMatchObject({ status: "pending", createdByAgentId: f.agentId, resolvedByAgentId: null, sourceRunId: f.runId });
    const own = await f.create();
    expect((await f.call(`/api/issues/${f.issueId}/interactions/${own.id}/accept`, "POST", {}, { "X-Paperclip-Run-Id": f.runId })).status).toBe(422);
    const [unspoofed] = await server.db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, own.id));
    expect(unspoofed).toMatchObject({ status: "pending", resolvedByAgentId: null, resolvedByRunId: null });
    const accepted = await f.call(`/api/issues/${f.issueId}/interactions/${own.id}/accept`, "POST", {});
    expect(accepted.status).toBe(200);
    const [row] = await server.db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, own.id));
    expect(row).toMatchObject({ status: "accepted", resolvedByAgentId: f.reviewerId, resolvedByRunId: f.reviewerRunId, resolvedByUserId: null });
    const [protectedRow] = await server.db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, human.id));
    expect(protectedRow?.status).toBe("pending");
  });

  it("rejects a real agent acceptance after the native bound document revision changes", async () => {
    const f = await fixture();
    const docs = documentService(server.db);
    const revision = await docs.upsertIssueDocument({ issueId: f.issueId, key: "review", title: "Bound review", format: "markdown", body: "Revision one", baseRevisionId: null, changeSummary: null, createdByAgentId: f.agentId, createdByRunId: f.runId });
    const own = await f.create("not_creator", { type: "issue_document", issueId: f.issueId, documentId: revision.document.id, key: "review", revisionId: revision.document.latestRevisionId, revisionNumber: revision.document.latestRevisionNumber });
    await docs.upsertIssueDocument({ issueId: f.issueId, key: "review", title: "Bound review", format: "markdown", body: "Revision two", baseRevisionId: revision.document.latestRevisionId, changeSummary: null, createdByAgentId: f.agentId, createdByRunId: f.runId });
    const rejected = await f.call(`/api/issues/${f.issueId}/interactions/${own.id}/accept`, "POST", {});
    expect(rejected.status).toBe(409);
    const [row] = await server.db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, own.id));
    expect(row).toMatchObject({ status: "expired", result: { outcome: "stale_target" }, resolvedByAgentId: f.reviewerId, resolvedByRunId: f.reviewerRunId });
  });
});
