import { afterEach, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import * as execution from "@paperclipai/adapter-utils/execution-target";
import * as fs from "node:fs/promises";
import { assertManagedAiProjectAuth, managedAiProjectAuthFailure } from "./ai-connection-runtime.js";
vi.mock("node:fs/promises", async importOriginal => ({ ...await importOriginal<typeof import("node:fs/promises")>(), readFile: vi.fn() }));
const target = { kind: "remote", transport: "sandbox", remoteCwd: "/fixture/workspace" } as execution.AdapterExecutionTarget;
afterEach(() => vi.restoreAllMocks());
it("executes the remote shell and rejects an inaccessible settings directory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "astra-scanner-"));
  const settings = path.join(root, ".codex");
  await fs.mkdir(settings);
  await fs.writeFile(path.join(settings, "config.toml"), "OPENAI_API_KEY=synthetic-fixture\n");
  await fs.chmod(settings, 0o000);
  vi.spyOn(execution, "runAdapterExecutionTargetProcess").mockImplementation(async (_id, _target, command, args) => {
    const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
    expect(result.error).toBeUndefined();
    return { exitCode: result.status, signal: result.signal, timedOut: false, stdout: "", stderr: "" } as Awaited<ReturnType<typeof execution.runAdapterExecutionTargetProcess>>;
  });
  try {
    await expect(assertManagedAiProjectAuth({}, "openai", { ...target, remoteCwd: root } as execution.AdapterExecutionTarget))
      .rejects.toMatchObject({ details: { reason: "scanner_failed", exitCode: 43 } });
  } finally {
    await fs.chmod(settings, 0o700);
    await fs.rm(root, { recursive: true, force: true });
  }
});
it.each([
  [42, false, null, "key_detected"], [43, false, null, "scanner_failed"],
  [2, false, null, "remote_execution_failed"], [null, false, "SIGTERM", "remote_execution_failed"],
  [0, true, null, "remote_timeout"], [42, true, null, "remote_timeout"],
  [0, false, "SIGTERM", "remote_execution_failed"],
])("fails closed with safe remote diagnosis %s/%s/%s", async (exitCode, timedOut, signal, reason) => {
  vi.spyOn(execution, "runAdapterExecutionTargetProcess").mockResolvedValue({ exitCode, timedOut, signal, stdout: "private-fixture", stderr: "private-fixture" } as Awaited<ReturnType<typeof execution.runAdapterExecutionTargetProcess>>);
  const error = await assertManagedAiProjectAuth({}, "openai", target).catch(e => e);
  expect(error?.details?.reason).toBe(reason);
  expect(error.details.exitCode).toBe(exitCode);
  expect(JSON.stringify(error)).not.toContain("private-fixture");
});
it("sanitizes transport errors instead of exposing their contents", async () => {
  vi.spyOn(execution, "runAdapterExecutionTargetProcess").mockRejectedValue(new Error("private-fixture transport credentials"));
  const error = await assertManagedAiProjectAuth({}, "openai", target).catch(e => e);
  expect(error.details?.reason).toBe("remote_execution_failed");
  expect(error.message).not.toContain("private-fixture");
});
it("accepts only a clean scan", async () => {
  vi.spyOn(execution, "runAdapterExecutionTargetProcess").mockResolvedValue({ exitCode: 0, timedOut: false, signal: null, stdout: "", stderr: "" } as Awaited<ReturnType<typeof execution.runAdapterExecutionTargetProcess>>);
  await expect(assertManagedAiProjectAuth({}, "openai", target)).resolves.toBeUndefined();
});
it.each([42, 43])("preserves the safe scanner diagnosis through the heartbeat gate (%s)", async exitCode => {
  vi.spyOn(execution, "runAdapterExecutionTargetProcess").mockResolvedValue({ exitCode, timedOut: false, signal: null, stdout: "private-fixture", stderr: "private-fixture" } as Awaited<ReturnType<typeof execution.runAdapterExecutionTargetProcess>>);
  const cause = await assertManagedAiProjectAuth({}, "openai", target).catch(e => e);
  const error = managedAiProjectAuthFailure(cause, "/agents/fixture/runtime");
  expect(error.resultJson.configurationIncomplete).toMatchObject({ reason: "ai_connection_incompatible", diagnostic: { code: "ai_connection_incompatible", reason: exitCode === 42 ? "key_detected" : "scanner_failed", phase: "remote_scan", exitCode } });
  expect(JSON.stringify(error)).not.toContain("private-fixture");
  expect(error.message.includes("conflict")).toBe(exitCode === 42);
});
it("reports argument overrides without echoing the argument", async () => {
  const error = await assertManagedAiProjectAuth({ args: ["--api-key=private-fixture"] }, "openai").catch(e => e);
  expect(error.details?.reason).toBe("auth_override_argument");
  expect(JSON.stringify(error)).not.toContain("private-fixture");
});
it("sanitizes local IO errors while accepting absent project settings", async () => {
  const read = vi.spyOn(fs, "readFile").mockRejectedValue(Object.assign(new Error("private-fixture path and data"), { code: "EACCES" }));
  const error = await assertManagedAiProjectAuth({ cwd: "/fixture/workspace" }, "openai").catch(e => e);
  expect(error.details?.reason).toBe("scanner_io_failed");
  expect(error.message).not.toContain("private-fixture");
  read.mockRejectedValue(Object.assign(new Error("absent"), { code: "ENOENT" }));
  await expect(assertManagedAiProjectAuth({ cwd: "/fixture/workspace" }, "openai")).resolves.toBeUndefined();
});
it("distinguishes scanner failure from detected keys without exposing output", async () => {
  vi.spyOn(execution, "runAdapterExecutionTargetProcess").mockResolvedValue({
    exitCode: 43, signal: null, timedOut: false, stdout: "private-fixture", stderr: "private-fixture",
  } as Awaited<ReturnType<typeof execution.runAdapterExecutionTargetProcess>>);
  const error = await assertManagedAiProjectAuth({}, "openai", target).catch(e => e);
  expect(error.details).toEqual({ code: "ai_connection_incompatible", reason: "scanner_failed", phase: "remote_scan", targetKind: "remote", exitCode: 43, timedOut: false });
  expect(JSON.stringify(error)).not.toContain("private-fixture");
});
