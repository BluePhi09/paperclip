import { describe, expect, it } from "vitest";
import { contextIntegrityScenario } from "./context-integrity-cases.js";
import { gradeContextIntegrity } from "./context-integrity-scoring.js";
import { runnerMatrix } from "./catalog.js";

function recording(id: "ordered-comment-continuation" | "assigned-skill-explicit-invocation", valid = true) {
  const scenario = contextIntegrityScenario(id, "nonce");
  const initial = {
    phase: "initial" as const,
    issue: { id: "issue", status: "in_progress" },
    comments: [],
    documents: id === "ordered-comment-continuation" ? [{ key: "packing-report", body: "passport\ncharger" }] : [],
    runs: [{ id: "run-1", status: "running" }],
    ...(id === "assigned-skill-explicit-invocation" ? {
      assignedSkill: { key: scenario.skillKey, runtimeName: scenario.skillKey, versionId: "version-1", markdown: `write ${scenario.marker}` },
      skillInvocationEvidence: valid,
    } : {}),
  };
  const final = {
    ...initial,
    phase: "final" as const,
    issue: { id: "issue", status: "done" },
    comments: scenario.comments.map((body, index) => ({ body, authorType: "user", id: `comment-${index}` })),
    documents: [{ key: "output", body: id === "ordered-comment-continuation" ? `passport\ncharger\n${scenario.comments.join("\n")}\n${scenario.marker}` : `Final ${scenario.marker}` }],
    runs: [{ id: "run-1", status: "succeeded" }, { id: "run-2", status: "succeeded" }],
  };
  const queued = {
    ...initial,
    phase: "comment-3" as const,
    queuedComments: { entries: scenario.comments.map((body, index) => ({ comment: { body, id: `comment-${index}` } })) },
  };
  return { scenario, checkpoints: id === "ordered-comment-continuation" ? [initial, queued, final] : [initial, final] };
}

describe("context integrity Product E2E contract", () => {
  it("is explicit-only and covers the seven qualified legacy/native profiles", () => {
    const cells = runnerMatrix.filter((execution) => execution.suite.id === "context-integrity");
    expect(cells).toHaveLength(14);
    expect(new Set(cells.map((execution) => execution.profile.id))).toEqual(new Set([
      "legacy-codex", "legacy-claude", "legacy-acp-codex", "legacy-acp-claude", "runner-codex", "runner-opencode", "runner-acpx-claude",
    ]));
    expect(cells.every((execution) => execution.suite.manualOnly)).toBe(true);
    expect(runnerMatrix.filter((execution) => execution.suite.id === "context-integrity" && execution.suite.manualOnly).every((execution) => !execution.suite.groups.includes("core"))).toBe(true);
  });

  it("requires distinct ordered comments, including intentional repetition", () => {
    const { scenario, checkpoints } = recording("ordered-comment-continuation");
    expect(gradeContextIntegrity({ id: scenario.id, marker: scenario.marker, comments: scenario.comments, checkpoints }).every((check) => check.passed)).toBe(true);
    const wrong = structuredClone(checkpoints);
    (wrong[2].comments[1] as { body: string }).body = String(scenario.changed);
    expect(gradeContextIntegrity({ id: scenario.id, marker: scenario.marker, comments: scenario.comments, checkpoints: wrong })).toEqual(expect.arrayContaining([expect.objectContaining({ id: "ordered-comments", passed: false })]));
    const echoed = structuredClone(checkpoints);
    (echoed[2].documents[0] as { body: string }).body = `passport\ncharger\n${scenario.comments[2]}\n${scenario.comments[0]}\n${scenario.comments[1]}`;
    expect(gradeContextIntegrity({ id: scenario.id, marker: scenario.marker, comments: scenario.comments, checkpoints: echoed })).toEqual(expect.arrayContaining([expect.objectContaining({ id: "packing-report-order", passed: false })]));
    const missingQueue = structuredClone(checkpoints);
    missingQueue[1].queuedComments = { entries: (missingQueue[1].queuedComments?.entries as Array<unknown>).slice(0, 2) };
    expect(gradeContextIntegrity({ id: scenario.id, marker: scenario.marker, comments: scenario.comments, checkpoints: missingQueue })).toEqual(expect.arrayContaining([expect.objectContaining({ id: "comments-queued-as-batch", passed: false })]));
    const missingInitialItem = structuredClone(checkpoints);
    (missingInitialItem[2].documents[0] as { body: string }).body = `passport\n${scenario.comments.join("\n")}`;
    expect(gradeContextIntegrity({ id: scenario.id, marker: scenario.marker, comments: scenario.comments, checkpoints: missingInitialItem })).toEqual(expect.arrayContaining([expect.objectContaining({ id: "packing-report-order", passed: false })]));
    const missingSecondRun = structuredClone(checkpoints);
    missingSecondRun[2].runs = [{ id: "run-1", status: "succeeded" }];
    expect(gradeContextIntegrity({ id: scenario.id, marker: scenario.marker, comments: scenario.comments, checkpoints: missingSecondRun })).toEqual(expect.arrayContaining([expect.objectContaining({ id: "continuation-run-count", passed: false })]));
  });

  it("ignores run-authored comments and rejects duplicate durable comment identities", () => {
    const { scenario, checkpoints } = recording("ordered-comment-continuation");
    const forged = structuredClone(checkpoints);
    (forged[2].comments as Array<Record<string, unknown>>).unshift({ body: scenario.comments[2], authorType: "user", authorUserId: "human", createdByRunId: "run-1", id: "run-comment" });
    expect(gradeContextIntegrity({ id: scenario.id, marker: scenario.marker, comments: scenario.comments, checkpoints: forged }).every((check) => check.passed)).toBe(true);
    const duplicate = structuredClone(checkpoints);
    (duplicate[2].comments[1] as { id: string }).id = "comment-0";
    expect(gradeContextIntegrity({ id: scenario.id, marker: scenario.marker, comments: scenario.comments, checkpoints: duplicate })).toEqual(expect.arrayContaining([expect.objectContaining({ id: "distinct-comment-identities", passed: false })]));
  });

  it("fails closed when assigned skill invocation evidence is missing", () => {
    const { scenario, checkpoints } = recording("assigned-skill-explicit-invocation", false);
    const checks = gradeContextIntegrity({ id: scenario.id, marker: scenario.marker, comments: scenario.comments, checkpoints });
    expect(checks.find((check) => check.id === "assigned-skill-present")?.passed).toBe(true);
    expect(checks.find((check) => check.id === "skill-explicitly-invoked")?.passed).toBe(false);
    expect(checks.some((check) => !check.passed)).toBe(true);
  });
});
