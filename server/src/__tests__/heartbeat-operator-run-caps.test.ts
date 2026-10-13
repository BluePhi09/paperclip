import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { truncateTablesWithDeadlockRetry } from "./helpers/truncate-with-deadlock-retry.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";

// PAPERCLIP_MAX_CONCURRENT_RUNS_PER_AGENT and PAPERCLIP_MAX_CONCURRENT_RUNS_TOTAL
// bound how many queued heartbeat runs the scheduler starts. Runs over a cap
// stay queued; they are never cancelled.

const { adapterResult, mockAdapterExecute } = vi.hoisted(() => {
  const adapterResult = {
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Run cap test run.",
    provider: "test",
    model: "test-model",
  };
  return { adapterResult, mockAdapterExecute: vi.fn(async () => ({ ...adapterResult })) };
});

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat run cap tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat operator run caps", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let releaseAdapter: () => void = () => {};

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-operator-run-caps-");
    db = createDb(tempDb.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterEach(async () => {
    releaseAdapter();
    await heartbeatService(db).drainActiveRunExecutions();
    mockAdapterExecute.mockReset();
    mockAdapterExecute.mockImplementation(async () => ({ ...adapterResult }));
    runningProcesses.clear();
    await truncateTablesWithDeadlockRetry(db, "TRUNCATE companies CASCADE");
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // Keep dispatched runs "running" until the test releases them, so the
  // running count the caps read is observable.
  function holdAdapter() {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockAdapterExecute.mockImplementation(async () => {
      await held;
      return { ...adapterResult };
    });
    releaseAdapter = release;
  }

  async function insertCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Run Cap Co",
      status: "active",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function insertAgent(companyId: string, maxConcurrentRuns: number) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `Run Cap Agent ${agentId.slice(0, 6)}`,
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true, maxConcurrentRuns },
      },
      permissions: {},
    });
    return agentId;
  }

  async function insertQueuedRun(companyId: string, agentId: string) {
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "on_demand",
      triggerDetail: "manual",
      status: "queued",
      runId,
      requestedByActorType: "user",
      requestedByActorId: "board-user",
      payload: { manualUserWake: true },
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "queued",
      wakeupRequestId,
    });
    return runId;
  }

  async function statusCounts(runIds: string[]) {
    const rows = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns);
    const counts: Record<string, number> = {};
    for (const row of rows) {
      if (!runIds.includes(row.id)) continue;
      counts[row.status] = (counts[row.status] ?? 0) + 1;
    }
    return counts;
  }

  it("clamps an agent's stored maxConcurrentRuns to the per-agent ceiling", async () => {
    const companyId = await insertCompany();
    // Same value company import writes for every agent.
    const agentId = await insertAgent(companyId, 20);
    const runIds = [
      await insertQueuedRun(companyId, agentId),
      await insertQueuedRun(companyId, agentId),
      await insertQueuedRun(companyId, agentId),
    ];

    holdAdapter();
    await heartbeatService(db, {
      runtimeEnv: { ...process.env, PAPERCLIP_MAX_CONCURRENT_RUNS_PER_AGENT: "1" },
    }).resumeQueuedRuns();

    expect(await statusCounts(runIds)).toEqual({ running: 1, queued: 2 });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("keeps runs across agents and companies within the instance-wide total", async () => {
    const firstCompanyId = await insertCompany();
    const secondCompanyId = await insertCompany();
    const firstAgentId = await insertAgent(firstCompanyId, 5);
    const secondAgentId = await insertAgent(secondCompanyId, 5);
    const runIds = [
      await insertQueuedRun(firstCompanyId, firstAgentId),
      await insertQueuedRun(firstCompanyId, firstAgentId),
      await insertQueuedRun(secondCompanyId, secondAgentId),
      await insertQueuedRun(secondCompanyId, secondAgentId),
    ];

    holdAdapter();
    await heartbeatService(db, {
      runtimeEnv: { ...process.env, PAPERCLIP_MAX_CONCURRENT_RUNS_TOTAL: "3" },
    }).resumeQueuedRuns();

    expect(await statusCounts(runIds)).toEqual({ running: 3, queued: 1 });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("starts every claimable run when neither cap is set", async () => {
    const companyId = await insertCompany();
    const agentId = await insertAgent(companyId, 5);
    const runIds = [
      await insertQueuedRun(companyId, agentId),
      await insertQueuedRun(companyId, agentId),
      await insertQueuedRun(companyId, agentId),
    ];

    holdAdapter();
    await heartbeatService(db, {
      runtimeEnv: {
        ...process.env,
        PAPERCLIP_MAX_CONCURRENT_RUNS_PER_AGENT: undefined,
        PAPERCLIP_MAX_CONCURRENT_RUNS_TOTAL: undefined,
      },
    }).resumeQueuedRuns();

    expect(await statusCounts(runIds)).toEqual({ running: 3 });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});
