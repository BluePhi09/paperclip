import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { agents, companies, createDb, environmentLeases, environments, heartbeatRuns, issues } from "@paperclipai/db";
import { captureDirectorySnapshot, directorySnapshotSha256 } from "@paperclipai/adapter-utils/workspace-restore-merge";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const transfer = vi.hoisted(() => ({
  restoreCalls: 0,
  duringSyncIn: null as null | (() => Promise<void>),
  duringSyncOut: null as null | (() => Promise<void>),
  syncOutError: null as null | Error,
}));
vi.mock("@paperclipai/adapter-utils/execution-target", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  // Fake transfer boundary: writes the durable seed the real sync-in would
  // upload, then lets a test interleave a concurrent ledger change mid-transfer.
  prepareAdapterExecutionTargetRuntime: vi.fn(async (input: { workspaceLocalDir: string; workspaceDurableSeed?: { workspaceArchivePath: string } }) => {
    if (input.workspaceDurableSeed?.workspaceArchivePath) {
      await mkdir(path.dirname(input.workspaceDurableSeed.workspaceArchivePath), { recursive: true });
      await writeFile(input.workspaceDurableSeed.workspaceArchivePath, "seed-archive-bytes");
    }
    await transfer.duringSyncIn?.();
    const baseline = await captureDirectorySnapshot(input.workspaceLocalDir, {});
    return {
      workspaceSyncSnapshot: { baseline, gitSnapshot: null },
      cleanupWorkspaceSnapshot: async () => {},
      restoreWorkspace: async () => {
        transfer.restoreCalls += 1;
        await transfer.duringSyncOut?.();
        if (transfer.syncOutError) throw transfer.syncOutError;
        await writeFile(path.join(input.workspaceLocalDir, "result.txt"), "changed in sandbox");
      },
    };
  }),
}));

import { nativeWorkspaceSyncInternals, prepareNativeWorkspaceSync, resumeNativeWorkspaceSync } from "../services/native-runtime/native-workspace-sync.js";
import { writeRunAcquisition, type RunAcquisition } from "../services/environment-acquisition-authority.js";

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let home: string;
const originalHome = process.env.PAPERCLIP_HOME;
const originalInstance = process.env.PAPERCLIP_INSTANCE_ID;
beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("native-transfer-receipt-"); db = createDb(database.connectionString); }, 120000);
beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "paperclip-transfer-receipt-"));
  process.env.PAPERCLIP_HOME = home;
  process.env.PAPERCLIP_INSTANCE_ID = "transfer-receipt";
  transfer.duringSyncIn = null; transfer.duringSyncOut = null; transfer.syncOutError = null; transfer.restoreCalls = 0;
});
afterEach(async () => {
  await db.transaction(async tx => { await tx.execute(sql`set local client_min_messages = warning`); await tx.execute(sql`truncate companies, environments cascade`); });
  await rm(home, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = originalHome;
  if (originalInstance === undefined) delete process.env.PAPERCLIP_INSTANCE_ID; else process.env.PAPERCLIP_INSTANCE_ID = originalInstance;
});
afterAll(async () => { await database?.cleanup(); });

async function seed(options: { ledger?: "published" | "absent" | "other_lease" } = {}) {
  const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID(), environmentId = randomUUID(), leaseId = randomUUID();
  const providerLeaseId = `sandbox-${leaseId.slice(0, 8)}`;
  await db.insert(companies).values({ id: companyId, name: "Transfer fixture", issuePrefix: `T${companyId.slice(0, 6)}` });
  await db.insert(agents).values({ id: agentId, companyId, name: "Fixture", role: "engineer", adapterType: "codex_local" });
  await db.insert(issues).values({ id: issueId, companyId, title: "Transfer fixture", status: "in_progress", assigneeAgentId: agentId });
  const ledger: RunAcquisition = { version: 1, token: randomUUID(), generation: 3, state: "published", leaseId: options.ledger === "other_lease" ? randomUUID() : leaseId,
    controllerBootId: null, runnerInstanceId: null, runtimeMode: "native", environmentId, issueId, executionWorkspaceId: null };
  await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", contextSnapshot: { issueId },
    runnerProfileJson: options.ledger === "absent" ? {} : { runAcquisition: ledger } });
  await db.insert(environments).values({ id: environmentId, name: `Transfer ${environmentId}`, driver: "sandbox", config: { provider: "fixture-provider" } });
  await db.insert(environmentLeases).values({ id: leaseId, companyId, environmentId, issueId, heartbeatRunId: runId, providerLeaseId, status: "active", metadata: {} });
  const workspace = path.join(home, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "input.txt"), "host revision");
  const target = { kind: "remote", transport: "sandbox", remoteCwd: "/workspace", leaseId,
    sandboxLeaseAcquisition: { providerLeaseId, outcome: "created" },
    runner: { execute: vi.fn(async () => ({ exitCode: 0, timedOut: false, stdout: "", stderr: "" })) } };
  return { companyId, issueId, runId, leaseId, providerLeaseId, ledger, workspace, target,
    lease: { id: leaseId, companyId, providerLeaseId, metadata: {} } };
}
type Fixture = Awaited<ReturnType<typeof seed>>;
const prepare = (f: Fixture) => prepareNativeWorkspaceSync({ db, runId: f.runId, companyId: f.companyId, workspaceId: "workspace-1",
  workspaceLocalDir: f.workspace, target: f.target as never, lease: f.lease as never });
async function runProfile(runId: string) {
  const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
  return run!.runnerProfileJson as Record<string, any>;
}
async function hostSha(dir: string) { return directorySnapshotSha256(await captureDirectorySnapshot(dir, { exclude: [], diskBacked: true })); }

it("records sync-in and sync-out receipts bound to run, lease, provider lease and acquisition generation", async () => {
  const f = await seed();
  const prepared = await prepare(f);
  const afterIn = await runProfile(f.runId);
  expect(afterIn.nativeWorkspaceTransferReceipts?.sync_in).toMatchObject({
    schema: "paperclip.native-workspace-transfer-receipt/v1", operation: "sync_in", status: "completed",
    runId: f.runId, companyId: f.companyId, workspaceId: "workspace-1", leaseId: f.leaseId, providerLeaseId: f.providerLeaseId,
    acquisition: { token: f.ledger.token, generation: 3 }, inboundMode: prepared!.mode,
    baselineSha256: prepared!.reference.baselineSha256, descriptorSha256: prepared!.reference.descriptorSha256,
    seed: { workspaceArchiveSha256: expect.stringMatching(/^[a-f0-9]{64}$/), gitArchiveSha256: null },
  });
  expect(afterIn.nativeWorkspaceTransferReceipts.sync_out).toBeUndefined();
  await prepared!.restoreWorkspace();
  expect(await readFile(path.join(f.workspace, "result.txt"), "utf8")).toBe("changed in sandbox");
  const afterOut = await runProfile(f.runId);
  expect(afterOut.nativeWorkspaceTransferReceipts.sync_out).toMatchObject({
    operation: "sync_out", status: "completed", leaseId: f.leaseId, providerLeaseId: f.providerLeaseId,
    acquisition: { token: f.ledger.token, generation: 3 }, baselineSha256: prepared!.reference.baselineSha256,
    finalHostSha256: afterOut.nativeWorkspaceSync.finalHostSha256, descriptorSha256: afterOut.nativeWorkspaceSync.descriptorSha256,
  });
  expect(afterOut.nativeWorkspaceSync.state).toBe("finalized");
  expect(afterOut.nativeWorkspaceTransferReceipts.sync_out.finalHostSha256).toBe(await hostSha(f.workspace));
  // The authority ledger itself is untouched by receipt persistence.
  expect(afterOut.runAcquisition).toEqual(f.ledger);
});

it.each(["new_generation", "same_generation_reset"] as const)("rejects a sync-in whose acquisition generation changed mid-transfer (%s)", async (change) => {
  const f = await seed();
  transfer.duringSyncIn = async () => {
    await writeRunAcquisition(db as never, f.runId, change === "new_generation"
      ? { ...f.ledger, token: randomUUID(), generation: 4, state: "pending", leaseId: undefined }
      : { ...f.ledger, state: "unknown" });
  };
  await expect(prepare(f)).rejects.toThrow("native_workspace_transfer_generation_stale");
  const profile = await runProfile(f.runId);
  expect(profile.nativeWorkspaceTransferReceipts).toBeUndefined();
  expect(profile.nativeWorkspaceSync).toBeUndefined();
});

const descriptorFiles = (runId: string) => readdir(path.dirname(nativeWorkspaceSyncInternals.descriptorPath(runId, "0".repeat(64)))).then(names => names.sort());
async function leaseMetadata(leaseId: string) {
  const [lease] = await db.select({ metadata: environmentLeases.metadata }).from(environmentLeases).where(eq(environmentLeases.id, leaseId));
  return lease!.metadata;
}

it("rejects a sync-out whose acquisition generation changed mid-transfer and keeps the prepared reference", async () => {
  const f = await seed();
  const prepared = await prepare(f);
  const descriptorsBefore = await descriptorFiles(f.runId);
  const remoteCallsBefore = f.target.runner.execute.mock.calls.length;
  transfer.duringSyncOut = async () => {
    await writeRunAcquisition(db as never, f.runId, { ...f.ledger, token: randomUUID(), generation: 4, state: "pending", leaseId: undefined });
  };
  await expect(prepared!.restoreWorkspace()).rejects.toThrow("native_workspace_transfer_generation_stale");
  const profile = await runProfile(f.runId);
  expect(profile.nativeWorkspaceTransferReceipts.sync_out).toBeUndefined();
  expect(profile.nativeWorkspaceSync.state).toBe("prepared");
  // The host merge already ran inside the transfer, but nothing after it is
  // published: no remote stamp, no finalized descriptor, no lease stamp.
  expect(f.target.runner.execute.mock.calls.length).toBe(remoteCallsBefore);
  expect(await descriptorFiles(f.runId)).toEqual(descriptorsBefore);
  expect(await leaseMetadata(f.leaseId)).toEqual({});
});

it("does not start a sync-out whose acquisition generation is already stale", async () => {
  const f = await seed();
  const prepared = await prepare(f);
  const descriptorsBefore = await descriptorFiles(f.runId);
  const remoteCallsBefore = f.target.runner.execute.mock.calls.length;
  await writeRunAcquisition(db as never, f.runId, { ...f.ledger, token: randomUUID(), generation: 4, state: "pending", leaseId: undefined });
  await expect(prepared!.restoreWorkspace()).rejects.toThrow("native_workspace_transfer_generation_stale");
  expect(transfer.restoreCalls).toBe(0);
  await expect(readFile(path.join(f.workspace, "result.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  expect(f.target.runner.execute.mock.calls.length).toBe(remoteCallsBefore);
  expect(await descriptorFiles(f.runId)).toEqual(descriptorsBefore);
  expect(await leaseMetadata(f.leaseId)).toEqual({});
  const profile = await runProfile(f.runId);
  expect(profile.nativeWorkspaceTransferReceipts.sync_out).toBeUndefined();
  expect(profile.nativeWorkspaceSync.state).toBe("prepared");
});

it("does not record a sync-out receipt for a failed or partial transfer", async () => {
  const f = await seed();
  const prepared = await prepare(f);
  transfer.syncOutError = Object.assign(new Error("workspace_restore_permission_denied"), { code: "EACCES" });
  await expect(prepared!.restoreWorkspace()).rejects.toThrow("workspace_restore_permission_denied");
  const profile = await runProfile(f.runId);
  expect(profile.nativeWorkspaceTransferReceipts.sync_out).toBeUndefined();
  expect(profile.nativeWorkspaceSync.state).toBe("prepared");
});

it("rejects a transfer whose lease row no longer carries the bound provider lease", async () => {
  const f = await seed();
  transfer.duringSyncIn = async () => {
    await db.update(environmentLeases).set({ providerLeaseId: "replacement-sandbox" }).where(eq(environmentLeases.id, f.leaseId));
  };
  await expect(prepare(f)).rejects.toThrow("native_workspace_transfer_lease_mismatch");
  expect((await runProfile(f.runId)).nativeWorkspaceTransferReceipts).toBeUndefined();
});

it.each(["absent", "other_lease"] as const)("records an explicitly unbound receipt when the ledger does not publish this lease (%s)", async (ledger) => {
  const f = await seed({ ledger });
  const prepared = await prepare(f);
  await prepared!.restoreWorkspace();
  const profile = await runProfile(f.runId);
  expect(profile.nativeWorkspaceTransferReceipts.sync_in).toMatchObject({ status: "completed", acquisition: null });
  expect(profile.nativeWorkspaceTransferReceipts.sync_out).toMatchObject({ status: "completed", acquisition: null });
});

it("restart recovery binds the sync-out receipt to the generation observed before its own transfer", async () => {
  const f = await seed();
  await prepare(f);
  // A restarted controller finalizes from the persisted reference, not the in-memory handle.
  expect(await resumeNativeWorkspaceSync({ db, runId: f.runId, target: f.target as never })).toBe(true);
  const profile = await runProfile(f.runId);
  expect(profile.nativeWorkspaceSync.state).toBe("finalized");
  expect(profile.nativeWorkspaceTransferReceipts.sync_out).toMatchObject({ status: "completed", acquisition: { token: f.ledger.token, generation: 3 } });
});
