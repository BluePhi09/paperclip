import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { beforeAll, afterAll, afterEach, it, expect, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRuns, heartbeatRunEvents } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.js";
import * as execution from "@paperclipai/adapter-utils/execution-target";

vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => ({ track() {} }) }));
vi.mock("../services/ai-connection-runtime.js", async original => ({
  ...await original<typeof import("../services/ai-connection-runtime.js")>(),
  prepareManagedAiRuntime: vi.fn(async (_db: ReturnType<typeof createDb>, input: Parameters<typeof import("../services/ai-connection-runtime.js").prepareManagedAiRuntime>[1]) => ({ config: input.config,
    identity: "synthetic-identity", sessionIdentity: "synthetic-session", accountName: "Synthetic",
    attribution: { provider: "openai", method: "api_key" }, cleanup: async () => {} })),
}));
// Provision no remote resource. Real local orchestration runs; only its transport
// boundary is replaced so the production scanner exercises remote outcomes.
vi.mock("../services/environment-run-orchestrator.js", async original => {
  const real = await original<typeof import("../services/environment-run-orchestrator.js")>();
  return { ...real, environmentRunOrchestrator: (...args: Parameters<typeof real.environmentRunOrchestrator>) => {
    const service = real.environmentRunOrchestrator(...args);
    return { ...service, realizeForRun: async (...input: Parameters<typeof service.realizeForRun>) => {
      const result = await service.realizeForRun(...input);
      return { ...result, executionTarget: { kind: "remote", transport: "sandbox", remoteCwd: "/synthetic/workspace" } };
    } };
  } };
});
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let heartbeat: ReturnType<typeof heartbeatService>;
let cwd: string;
const adapter = vi.fn(async () => { throw new Error("Adapter dispatch forbidden in scanner failure tests"); });
beforeAll(async () => {
  database = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-auth-");
  db = createDb(database.connectionString);
  cwd = await mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "runtime-auth-workspace-"));
  heartbeat = heartbeatService(db);
  registerServerAdapter({ type: "codex_local", supportsLocalAgentJwt: false, execute: adapter,
    testEnvironment: async () => ({ adapterType: "codex_local", status: "pass", checks: [], testedAt: new Date(0).toISOString() }) });
}, 120000);
afterEach(async () => {
  await drainHeartbeatRunsToQuiescence(db, heartbeat);
  await db.transaction(async tx => { await tx.execute(sql`set local client_min_messages = warning`); await tx.execute(sql`truncate companies cascade`); });
  vi.restoreAllMocks(); adapter.mockClear();
});
afterAll(async () => { unregisterServerAdapter("codex_local"); await database?.cleanup(); if (cwd) await rm(cwd, { recursive: true, force: true }); });
it.each([
  [42, false, null, "key_detected"], [43, false, null, "scanner_failed"],
  [0, true, null, "remote_timeout"], [null, false, "SIGTERM", "remote_execution_failed"],
  [2, false, null, "remote_execution_failed"], ["throw", false, null, "remote_execution_failed"],
] as const)("real heartbeat preserves %s scan failure and never dispatches adapter/tools", async (exitCode, timedOut, signal, reason) => {
  const remote = vi.spyOn(execution, "runAdapterExecutionTargetProcess");
  if (exitCode === "throw") remote.mockRejectedValue(new Error("private-fixture credentials transport"));
  else remote.mockResolvedValue({ exitCode, timedOut, signal, stdout: "private-fixture", stderr: "private-fixture" } as Awaited<ReturnType<typeof execution.runAdapterExecutionTargetProcess>>);
  const companyId = randomUUID(), agentId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Synthetic auth", issuePrefix: `S${companyId.slice(0,6)}`, defaultResponsibleUserId: "synthetic-board", requireBoardApprovalForNewAgents: false });
  await db.insert(agents).values({ id: agentId, companyId, name: "Synthetic", role: "engineer", status: "idle", adapterType: "codex_local", adapterConfig: { cwd }, runtimeConfig: { aiConnection: { provider: "openai", method: "api_key", mode: "responsible_user" } } });
  const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
  expect(queued).not.toBeNull();
  await drainHeartbeatRunsToQuiescence(db, heartbeat);
  const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued!.id));
  expect(remote).toHaveBeenCalledOnce();
  expect(run).toMatchObject({ status: "failed", errorCode: "configuration_incomplete", resultJson: {
    configurationIncomplete: { diagnostic: { reason, phase: "remote_scan" } },
  } });
  expect(JSON.stringify({ error: run!.error, result: run!.resultJson })).not.toContain("private-fixture");
  expect(adapter).not.toHaveBeenCalled();
  expect(await db.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, run!.id),
    sql`${heartbeatRunEvents.eventType} in ('adapter.invoke', 'tool.execution.started')`))).toHaveLength(0);
});
