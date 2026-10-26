import { execFile } from "node:child_process";
import { summarizeStartupReuse } from "@paperclipai/adapter-utils/startup-reuse";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { finished } from "node:stream/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import type { EnvironmentLease } from "@paperclipai/shared";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import * as restoreMerge from "@paperclipai/adapter-utils/workspace-restore-merge";
import * as workspaceSeedCache from "@paperclipai/adapter-utils/workspace-seed-cache";
import * as gitWorkspaceSync from "@paperclipai/adapter-utils/git-workspace-sync";
import { runLocalGit } from "@paperclipai/adapter-utils/git-workspace-sync";
import { prepareNativeWorkspaceSync, nativeWorkspaceSyncInternals } from "../services/native-runtime/native-workspace-sync.js";

const runner: CommandManagedRuntimeRunner = {
  execute: async (input) => {
    let stdinCompletion: Promise<Error | undefined> = Promise.resolve(undefined);
    const startedAt = new Date().toISOString();
    const result = await new Promise<Awaited<ReturnType<CommandManagedRuntimeRunner["execute"]>>>((resolve) => {
      const child = execFile(input.command, input.args ?? [], {
        cwd: input.cwd, env: { ...process.env, ...input.env },
        timeout: input.timeoutMs, maxBuffer: 16 * 1024 * 1024,
      }, (error, stdout, stderr) => resolve({
        exitCode: error ? (typeof error.code === "number" ? error.code : 1) : 0,
        signal: error?.signal ?? null, timedOut: error?.killed ?? false, stdout, stderr,
        pid: child.pid ?? null, startedAt,
      }));
      if (child.stdin) {
        // Observe transfer errors immediately, but settle only after the child exits.
        stdinCompletion = finished(child.stdin, { readable: false }).then(
          () => undefined, (error: Error) => error,
        );
        if (input.stdin) child.stdin.end(input.stdin);
        else child.stdin.end(); // EOF is not an empty data write.
      }
    });
    const stdinError = await stdinCompletion;
    if (stdinError) throw stdinError;
    return result;
  },
};

describe("history fixture command runner", () => {
  it.each([undefined, ""])("sends EOF for stdin %s", async (stdin) => {
    const result = await runner.execute({ command: "cat", stdin });
    expect(result).toEqual({ pid: expect.any(Number), startedAt: expect.any(String), exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "" });
  });

  it("preserves a nonempty payload", async () => {
    const stdin = "payload with UTF-8: ä\n\0end\n";
    const result = await runner.execute({ command: "cat", stdin });
    expect(result).toEqual({ pid: expect.any(Number), startedAt: expect.any(String), exitCode: 0, signal: null, timedOut: false, stdout: stdin, stderr: "" });
  });

  it("rejects a failed transfer when the payload reader closes early", async () => {
    // Exceed the pipe buffer so a child that never reads cannot accept the payload.
    await expect(runner.execute({
      command: "sh", args: ["-c", "exec 0<&-; printf closed"], stdin: "x".repeat(2 * 1024 * 1024),
    })).rejects.toMatchObject({ code: "EPIPE" });
  });

  it("retains a failed child command's status and output", async () => {
    const result = await runner.execute({ command: "sh", args: ["-c", "printf failure >&2; exit 23"] });
    expect(result).toEqual({ pid: expect.any(Number), startedAt: expect.any(String), exitCode: 23, signal: null, timedOut: false, stdout: "", stderr: "failure" });
  });
});

async function git(cwd: string, ...args: string[]) {
  return (await runLocalGit(cwd, args)).stdout.trim();
}

describe("native warm workspace Git history", () => {
  const oldHome = process.env.PAPERCLIP_HOME;
  const oldInstance = process.env.PAPERCLIP_INSTANCE_ID;
  const roots: string[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    if (oldHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = oldHome;
    if (oldInstance === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = oldInstance;
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  });

  it.each(["unchanged", "host_commit", "host_branch", "host_origin", "remote_commit", "remote_commit_corrupt_seed", "remote_commit_missing_seed", "remote_commit_cache_refused", "host_bytes_cache_refused", "remote_commit_missing_run_seed", "remote_commit_corrupt_run_seed", "nested_commit", "plain_nested_commit"] as const)(
    "checks Git identity before reusing a warm sandbox: %s", async (change) => {
      const invalidRunSeed = change === "remote_commit_missing_run_seed" || change === "remote_commit_corrupt_run_seed";
      const cacheRefused = change === "remote_commit_cache_refused" || change === "host_bytes_cache_refused" || invalidRunSeed;
      const snapshotWorker = vi.spyOn(restoreMerge, "captureDirectorySnapshotOffThread");
      const packClone = vi.spyOn(gitWorkspaceSync, "withShallowGitWorkspaceClone");
      const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-warm-history-"));
      roots.push(root);
      process.env.PAPERCLIP_HOME = path.join(root, "home");
      process.env.PAPERCLIP_INSTANCE_ID = "test";
      const host = path.join(root, "host");
      const remote = path.join(root, "remote");
      async function initRepo(dir: string) {
        await mkdir(dir, { recursive: true });
        await git(dir, "init", "-b", "work");
        await git(dir, "config", "user.name", "Test");
        await git(dir, "config", "user.email", "test@paperclip.dev");
        await writeFile(path.join(dir, "file.txt"), "unchanged contents\n");
        await git(dir, "add", ".");
        await git(dir, "commit", "-m", "base");
      }
      if (change === "plain_nested_commit") await mkdir(host, { recursive: true });
      else await initRepo(host);
      const nestedPath = path.join(".paperclip-repositories", "nested");
      if (change === "nested_commit" || change === "plain_nested_commit") await initRepo(path.join(host, nestedPath));
      const lease = { id: "lease", providerLeaseId: "sandbox", metadata: {} } as EnvironmentLease;
      let runnerProfileJson: Record<string, unknown> = {};
      // Persist the real service's descriptors and stamps; only the DB query
      // plumbing is in memory. Git, staging, warm adoption, and restore are real.
      const db = {
        select: () => {
          const query = {
            from: () => query, where: () => query, for: () => query,
            // One row shape serves the run and lease reads, including the
            // company/provider-lease binding the transfer receipt verifies.
            limit: async () => rows(),
            then: (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve(rows()).then(resolve, reject),
          };
          const rows = () => [{ runnerProfileJson, metadata: lease.metadata, companyId: "company", providerLeaseId: lease.providerLeaseId, nativeIssueId: null, contextSnapshot: null }];
          return query;
        },
        update: (table: unknown) => ({
          set: (value: { runnerProfileJson?: Record<string, unknown>; metadata?: Record<string, unknown> }) => ({
            where: async () => {
              if (table === heartbeatRuns) runnerProfileJson = value.runnerProfileJson!;
              else lease.metadata = value.metadata!;
            },
          }),
        }),
        transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
      };
      const target: AdapterSandboxExecutionTarget = {
        kind: "remote", transport: "sandbox", providerKey: "test", leaseId: lease.id,
        remoteCwd: remote, runner, timeoutMs: 30_000,
        sandboxLeaseAcquisition: { outcome: "created", providerLeaseId: "sandbox" },
      };
      const input = { db: db as unknown as Db, companyId: "company", workspaceId: "workspace", workspaceLocalDir: host, lease, target };
      const first = (await prepareNativeWorkspaceSync({ ...input, runId: "first" }))!;
      expect(first.mode).toBe("host_current");
      expect(snapshotWorker).toHaveBeenCalled();
      expect(first.reference.schema).toBe("paperclip.native-workspace-sync/v3");
      if (change === "plain_nested_commit") {
        const recovered = await nativeWorkspaceSyncInternals.readDescriptor({ runId: "first", reference: first.reference });
        expect(recovered.descriptor.gitSnapshot).toBeNull();
        expect(recovered.descriptor.repositories?.[0]?.path).toBe(nestedPath);
      }
      await first.restoreWorkspace();
      await first.cleanup();

      if (change === "host_commit" || change === "nested_commit" || change === "plain_nested_commit") {
        await git(change === "nested_commit" || change === "plain_nested_commit" ? path.join(host, nestedPath) : host, "commit", "--allow-empty", "-m", "host only");
      } else if (change === "host_branch") {
        await git(host, "checkout", "-b", "other");
      } else if (change === "host_origin") {
        await git(host, "remote", "add", "origin", "https://github.com/paperclipai/new-source.git");
      } else if (change === "host_bytes_cache_refused") {
        await writeFile(path.join(host, "file.txt"), "updated host content\n");
        await writeFile(path.join(host, "extra.txt"), "new host file\n");
      } else if (change.startsWith("remote_commit")) {
        await git(remote, "-c", "user.name=Test", "-c", "user.email=test@paperclip.dev", "commit", "--allow-empty", "-m", "remote only");
      }
      if (change === "remote_commit_corrupt_seed" || change === "remote_commit_missing_seed") {
        const cache = path.join(process.env.PAPERCLIP_HOME!, "instances", "test", "native-workspace-sync", "generations", "company", "workspace");
        const [generation] = (await readdir(cache)).filter(name => /^[a-f0-9]{64}$/.test(name));
        expect(generation).toBeDefined();
        const archive = path.join(cache, generation!, "workspace.tar");
        await rm(archive);
        if (change === "remote_commit_corrupt_seed") await writeFile(archive, "invalid cached archive");
      }
      if (cacheRefused) {
        await rm(path.join(process.env.PAPERCLIP_HOME!, "instances", "test", "native-workspace-sync", "generations", "company", "workspace"), { recursive: true, force: true });
        vi.spyOn(workspaceSeedCache, "publishWorkspaceSeedGeneration").mockResolvedValue(false);
      }
      const hostRepo = change === "plain_nested_commit" ? path.join(host, nestedPath) : host;
      const remoteRepo = change === "plain_nested_commit" ? path.join(remote, nestedPath) : remote;
      const expectedContents = await readFile(path.join(hostRepo, "file.txt"), "utf8");
      const expectedHead = await git(hostRepo, "rev-parse", "HEAD");
      const expectedBranch = await git(hostRepo, "symbolic-ref", "--short", "HEAD");
      const nestedHead = change === "nested_commit" || change === "plain_nested_commit" ? await git(path.join(host, nestedPath), "rev-parse", "HEAD") : null;
      runnerProfileJson = {};
      packClone.mockClear();
      let invalidatedRunSeed = false;
      const secondRunner: CommandManagedRuntimeRunner = {
        execute: async operation => {
          const result = await runner.execute(operation);
          if (invalidRunSeed && !invalidatedRunSeed && operation.args?.some(arg => arg.includes("cat ") && arg.includes("workspace-sync-v1.json"))) {
            invalidatedRunSeed = true;
            const seed = nativeWorkspaceSyncInternals.durableSeedPaths("second");
            await rm(seed.workspaceArchivePath);
            if (change === "remote_commit_corrupt_run_seed") await writeFile(seed.workspaceArchivePath, "invalid prepared archive");
          }
          return result;
        },
      };
      const reuseEvents: import("@paperclipai/adapter-utils").AdapterRuntimeEvent[] = [];
      const second = (await prepareNativeWorkspaceSync({ ...input, runId: "second", onEvent: async event => { reuseEvents.push(event); }, target: {
        ...target, runner: secondRunner, sandboxLeaseAcquisition: { outcome: "resumed", providerLeaseId: "sandbox" },
      } }))!;
      try {
        if (change === "remote_commit") expect(packClone).not.toHaveBeenCalled();
        if (cacheRefused) expect(packClone).toHaveBeenCalledTimes(invalidRunSeed ? 2 : 1);
        if (invalidRunSeed) expect(invalidatedRunSeed).toBe(true);
        if (change === "remote_commit_corrupt_seed" || change === "remote_commit_missing_seed") expect(packClone).toHaveBeenCalled();
        expect(second.mode).toBe(change === "unchanged" ? "adopt_remote" : "host_current");
        expect(summarizeStartupReuse(reuseEvents).layers.workspace).toEqual(change === "unchanged"
          ? { state: "reused", reason: "verified_reuse" }
          : { state: "fresh", reason: "workspace_changed" });
        expect(await readFile(path.join(remoteRepo, "file.txt"), "utf8")).toBe(expectedContents);
        if (change === "host_bytes_cache_refused") expect(await readFile(path.join(remote, "extra.txt"), "utf8")).toBe("new host file\n");
        expect(await git(remoteRepo, "rev-parse", "HEAD")).toBe(expectedHead);
        expect(await git(remoteRepo, "symbolic-ref", "--short", "HEAD")).toBe(expectedBranch);
        if (change === "host_origin") expect(await git(remote, "remote", "get-url", "origin")).toBe("https://github.com/paperclipai/new-source.git");
        await second.restoreWorkspace();
        expect(await readFile(path.join(hostRepo, "file.txt"), "utf8")).toBe(expectedContents);
        expect(await git(hostRepo, "rev-parse", "HEAD")).toBe(expectedHead);
        if (nestedHead) {
          expect(await git(path.join(remote, nestedPath), "rev-parse", "HEAD")).toBe(nestedHead);
          expect(await git(path.join(host, nestedPath), "rev-parse", "HEAD")).toBe(nestedHead);
        }
      } finally { await second.cleanup(); }
    }, 30_000,
  );
});
