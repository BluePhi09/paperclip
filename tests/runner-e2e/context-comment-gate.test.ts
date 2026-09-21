import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clear, contextCommentGateSelected, holdCommittedDocumentResponse, release, waitUntilHeld } from "./context-comment-gate.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await clear("issue-1").catch(() => undefined);
  await Promise.all([]);
});

describe("context comment gate", () => {
  it("selects only the ordered comment execution", () => {
    expect(contextCommentGateSelected(["context_integrity.runner-codex.ordered-comment-continuation"])).toBe(true);
    expect(contextCommentGateSelected(["context_integrity.runner-codex.assigned-skill-explicit-invocation"])).toBe(false);
  });

  it("waits for a committed hold and releases it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "context-comment-gate-"));
    roots.push(root);
    vi.stubEnv("PAPERCLIP_RUNNER_E2E_PRIVATE_DIR", root);
    const held = holdCommittedDocumentResponse("issue-1", Date.now() + 2_000);
    await waitUntilHeld("issue-1", Date.now() + 2_000);
    await release("issue-1");
    await expect(held).resolves.toBeUndefined();
    await expect(readFile(path.join(root, "context-comment-gates", "issue-1", "held"))).resolves.toBeTruthy();
  });

  it("holds only the first write and times out without release", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "context-comment-gate-"));
    roots.push(root);
    vi.stubEnv("PAPERCLIP_RUNNER_E2E_PRIVATE_DIR", root);
    await expect(holdCommittedDocumentResponse("issue-1", Date.now() + 10)).rejects.toThrow("gate release");
  });
});
