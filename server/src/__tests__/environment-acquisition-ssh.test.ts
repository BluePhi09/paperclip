import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { agents, companies, createDb, environmentLeases, environments, heartbeatRuns, issues } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const ssh = vi.hoisted(() => ({ ready: null as null | ((config: { remoteWorkspacePath: string }) => Promise<{ remoteCwd: string }>) }));
// No host connection: the SSH workspace probe is the only remote call of the driver.
vi.mock("@paperclipai/adapter-utils/ssh", async (importOriginal) => ({
  ...await importOriginal<typeof import("@paperclipai/adapter-utils/ssh")>(),
  ensureSshWorkspaceReady: (config: { remoteWorkspacePath: string }) => ssh.ready!(config),
}));

import { environmentRuntimeService } from "../services/environment-runtime.js";

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("runtime-acquisition-ssh-"); db = createDb(database.connectionString); }, 120000);
afterEach(async () => { await db.transaction(async tx => { await tx.execute(sql`set local client_min_messages = warning`); await tx.execute(sql`truncate companies, environments cascade`); }); });
afterAll(async () => { await database?.cleanup(); });

async function seed() {
  const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID(), environmentId = randomUUID(), bootId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "SSH fixture", issuePrefix: `S${companyId.slice(0, 6)}` });
  await db.insert(agents).values({ id: agentId, companyId, name: "Fixture", role: "engineer", adapterType: "codex_local" });
  await db.insert(issues).values({ id: issueId, companyId, title: "SSH fixture", status: "in_progress", assigneeAgentId: agentId });
  await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", controllerBootId: bootId,
    controllerLeaseExpiresAt: new Date(Date.now() + 60000), contextSnapshot: { issueId } });
  const [environment] = await db.insert(environments).values({ id: environmentId, name: `SSH ${environmentId}`, driver: "ssh",
    config: { host: "ssh-fixture.invalid", username: "fixture", remoteWorkspacePath: "/workspace/fixture" } }).returning();
  return { companyId, agentId, issueId, runId, environmentId, bootId,
    environment: { ...environment!, driver: "ssh" as const, status: "active" as const, envVars: {} } };
}
type Fixture = Awaited<ReturnType<typeof seed>>;
const acquire = (f: Fixture) => environmentRuntimeService(db).acquireRunLease({ ...f, heartbeatRunId: f.runId,
  expectedControllerBootId: f.bootId, persistedExecutionWorkspace: null, adapterType: "codex_local" } as never);
async function ledger(runId: string) {
  const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
  return run!.runnerProfileJson?.runAcquisition as Record<string, unknown> | undefined;
}

it.each(["workspace_probe_failed", "publication_rejected"] as const)(
  "an SSH acquisition that fails before publication leaves no unknown hold (%s)",
  async (mode) => {
    const f = await seed();
    ssh.ready = async (config) => {
      if (mode === "workspace_probe_failed") throw new Error("synthetic ssh failure");
      // Authority is lost between the probe and the lease publication.
      await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: new Date(0) }).where(eq(heartbeatRuns.id, f.runId));
      return { remoteCwd: config.remoteWorkspacePath };
    };
    await expect(acquire(f)).rejects.toThrow(mode === "workspace_probe_failed" ? "synthetic ssh failure" : "authority lost");
    expect(await ledger(f.runId)).toMatchObject({ generation: 1, state: "cleanup_confirmed" });
    expect(await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, f.runId))).toHaveLength(0);
    // The run is not fenced: once authority is valid again it can acquire.
    await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: new Date(Date.now() + 60000) }).where(eq(heartbeatRuns.id, f.runId));
    ssh.ready = async (config) => ({ remoteCwd: config.remoteWorkspacePath });
    await expect(acquire(f)).resolves.toMatchObject({ lease: { status: "active", provider: "ssh" } });
    expect(await ledger(f.runId)).toMatchObject({ generation: 2, state: "published" });
  },
);
