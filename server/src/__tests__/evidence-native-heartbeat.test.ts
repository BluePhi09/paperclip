import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, agentWakeupRequests, authUsers, companies, createDb, heartbeatRuns, issueRecoveryActions, issues } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { nativeEvidenceFixture } from "./helpers/native-evidence-fixture.js";
import { documentService } from "../services/documents.js";
import { heartbeatService } from "../services/heartbeat.js";
import type { NativeSessionBackend } from "../../../packages/paperclip-runner/src/contracts/native-session-backend.js";

// Real heartbeat with a native (paperclip_runner/codex) agent and a provider
// boundary seam; never connects to a configured instance or a live provider.
describe("native evidence denial through the heartbeat", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  let previousHome: string | undefined;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("evidence-native-heartbeat-");
    db = createDb(database.connectionString);
    const now = new Date();
    await db.insert(authUsers).values({ id: "responsible-user", name: "Responsible User", email: "responsible-user@example.test", emailVerified: true, createdAt: now, updatedAt: now });
    home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-evidence-native-"));
    previousHome = process.env.PAPERCLIP_HOME;
    process.env.PAPERCLIP_HOME = home;
  }, 120000);
  afterAll(async () => {
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousHome;
    await database?.cleanup();
    await fs.rm(home, { recursive: true, force: true }).catch(() => undefined);
  });

  async function seed(contextSnapshot: Record<string, unknown> = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID(), wakeupRequestId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Evidence native", issuePrefix: `N${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, defaultResponsibleUserId: "responsible-user", requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "NativeExecutor", role: "engineer", status: "idle", adapterType: "paperclip_runner",
      adapterConfig: { provider: "codex", model: "gpt-5.6-luna" }, runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Bound native execution", description: "Implement the reviewed change.", status: "in_progress", assigneeAgentId: agentId });
    const evidence = await nativeEvidenceFixture(db, { companyId, issueId, agentId });
    await db.insert(agentWakeupRequests).values({ id: wakeupRequestId, companyId, agentId, source: "assignment", triggerDetail: "system", reason: "issue_assigned", payload: { issueId }, status: "queued", runId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "assignment", triggerDetail: "system", status: "queued", wakeupRequestId,
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned", ...contextSnapshot } });
    return { companyId, agentId, issueId, runId, evidence };
  }

  type Execution = { binding: { companyId: string; issueId: string; agentId: string; runId: string }; session: { normalizedSessionId: string | null } };
  function backendInvalidatingOnOpen(onOpen: () => Promise<void>) {
    const startTurn = vi.fn(async () => ({ turnId: "turn-evidence" }));
    const capabilities = { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true };
    const openSession = vi.fn();
    const factory = vi.fn((execution: Execution): NativeSessionBackend => {
      const identity = { ...execution.binding, sessionId: execution.session.normalizedSessionId ?? "session-evidence" };
      return {
        async descriptor() {
          return { kind: "mock", name: "evidence-native", version: "1", capabilities,
            runtimeContextCapabilities: { instructions: "native", skills: "native", mcp: "native" } } as never;
        },
        async openSession() {
          openSession();
          await onOpen();
          // Only used if the next admission passed; startTurn must stay unused.
          return {
            identity: () => identity, async capabilities() { return capabilities; },
            async *events() { /* no provider events */ },
            startTurn, close: async () => {}, cancel: () => ({ cleanup: Promise.resolve() }),
            result: async () => null,
            snapshot: async () => ({ backendKind: "mock", sessionId: "driver-evidence", identity, providerSessionId: "provider-evidence", cursor: null, activeTurnId: null, pendingRuntimeRequests: [], lineage: [] }),
          } as never;
        },
      };
    });
    return { factory, openSession, startTurn };
  }

  async function runToDrain(heartbeat: ReturnType<typeof heartbeatService>, runId: string) {
    await heartbeat.resumeQueuedRuns();
    for (let i = 0; i < 400; i++) {
      const row = await heartbeat.getRun(runId);
      if (row && !["queued", "running"].includes(row.status)) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    await heartbeat.waitForRunExecutionDrain(runId);
    await heartbeat.drainActiveRunExecutions();
  }

  // Current behavior, recorded as-is (not a target design): a denial at the
  // native provider-operation admission is a permanent native failure. The run
  // fails with evidence_pack_denied, the issue is blocked with a board-owned
  // recovery action, and no heartbeat.evidence_denied activity is written.
  it("records the end state of a native operation-admission denial", async () => {
    const f = await seed();
    const { factory, openSession, startTurn } = backendInvalidatingOnOpen(async () => {
      // Asynchronous provider preparation: the reviewed artifact changes.
      await documentService(db).upsertIssueDocument({ issueId: f.issueId, key: f.evidence.artifact.key, format: "markdown", body: "Changed during provider bootstrap", baseRevisionId: f.evidence.artifact.revisionId });
    });
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: factory as never });
    await runToDrain(heartbeat, f.runId);
    expect(openSession).toHaveBeenCalledOnce();
    expect(startTurn).not.toHaveBeenCalled();
    const run = await heartbeat.getRun(f.runId);
    expect(run).toMatchObject({ status: "failed", errorCode: "evidence_pack_denied", runtimeMode: "native" });
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(issue.status).toBe("blocked");
    const actions = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    expect(actions).toEqual(expect.arrayContaining([expect.objectContaining({ ownerType: "board" })]));
    const denials = await db.select().from(activityLog).where(eq(activityLog.action, "heartbeat.evidence_denied"));
    expect(denials.filter((entry) => entry.runId === f.runId)).toEqual([]);
  }, 60000);
});
