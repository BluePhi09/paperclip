import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalDocumentIssueId, contextCommentGateSelected, holdCommittedDocumentResponse, release, waitUntilHeld } from "./context-comment-gate.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("context comment gate", () => {
  it("selects only the ordered comment execution", () => {
    expect(contextCommentGateSelected(["context_integrity.runner-codex.ordered-comment-continuation"])).toBe(true);
    expect(contextCommentGateSelected(["context_integrity.runner-codex.assigned-skill-explicit-invocation"])).toBe(false);
  });

  it("uses the canonical issue ID returned by a successful document response", () => {
    expect(canonicalDocumentIssueId("/api/issues/RUN-1/documents/packing-report", JSON.stringify({ issueId: "issue-uuid" }))).toBe("issue-uuid");
    expect(canonicalDocumentIssueId("/api/issues/RUN-1/documents/packing-report", "not-json")).toBe("RUN-1");
    expect(canonicalDocumentIssueId("/api/issues/RUN-1/feedback", JSON.stringify({ issueId: "issue-uuid" }))).toBeUndefined();
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
    await expect(holdCommittedDocumentResponse("issue-1", Date.now() + 100)).resolves.toBeUndefined();
  });

  it("times out without release", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "context-comment-gate-"));
    roots.push(root);
    vi.stubEnv("PAPERCLIP_RUNNER_E2E_PRIVATE_DIR", root);
    await expect(holdCommittedDocumentResponse("issue-1", Date.now() + 10)).rejects.toThrow("gate release");
  });
});
