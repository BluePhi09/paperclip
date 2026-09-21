import type { ContextIntegrityCase } from "./context-integrity-cases.js";

export interface ContextIntegrityCheckpoint {
  phase: "initial" | "comment-1" | "comment-2" | "comment-3" | "final";
  issue: { id: string; status: string };
  comments: Array<Record<string, unknown>>;
  queuedComments?: Record<string, unknown>;
  documents: Array<{ key: string; body?: string | null }>;
  runs: Array<Record<string, unknown>>;
  assignedSkill?: { key: string; runtimeName?: string; versionId?: string | null; markdown?: string };
  skillInvocationEvidence?: boolean;
}

function userComments(checkpoint: ContextIntegrityCheckpoint) {
  return checkpoint.comments
    .filter(
      (comment) =>
        !comment.createdByRunId &&
        (comment.authorType === "user" || comment.authorUserId),
    )
    .map((comment) => String(comment.body ?? ""));
}

function humanCommentRows(checkpoint: ContextIntegrityCheckpoint) {
  return checkpoint.comments.filter(
    (comment) =>
      !comment.createdByRunId &&
      (comment.authorType === "user" || comment.authorUserId),
  );
}

function oneOutput(checkpoint: ContextIntegrityCheckpoint, marker: string, requireMarker: boolean) {
  const outputs = checkpoint.documents.filter((document) =>
    !requireMarker || String(document.body ?? "").includes(marker),
  );
  return outputs.length === 1 ? outputs[0] : undefined;
}

export function gradeContextIntegrity(input: {
  id: ContextIntegrityCase;
  marker: string;
  comments: readonly string[];
  checkpoints: readonly ContextIntegrityCheckpoint[];
}) {
  const checks: Array<{ id: string; passed: boolean; detail: string }> = [];
  const check = (id: string, passed: boolean, detail: string) => checks.push({ id, passed, detail });
  const initial = input.checkpoints.find((checkpoint) => checkpoint.phase === "initial");
  const final = input.checkpoints.find((checkpoint) => checkpoint.phase === "final");
  const finalComments = final ? userComments(final) : [];
  if (input.id === "ordered-comment-continuation") {
    const queued = input.checkpoints.find((checkpoint) => checkpoint.phase === "comment-3")?.queuedComments;
    const queuedBodies = Array.isArray(queued?.entries) ? queued.entries.map((entry) => String(((entry as Record<string, unknown>).comment as Record<string, unknown> | undefined)?.body ?? "")) : [];
    check("comments-queued-as-batch", queuedBodies.length >= input.comments.length && input.comments.every((body, index) => queuedBodies[index] === body), "Paused-agent comments must remain queued as one ordered public batch before resume.");
    const initialBody = String(initial?.documents[0]?.body ?? "");
    check("initial-scope-recorded", initialBody.includes("passport") && initialBody.includes("charger") && initial?.issue.status !== "done", "The initial packing scope must be saved while the task remains available for continuation.");
    check(
      "ordered-comments",
      input.comments.every((body, index) => finalComments[index] === body) && finalComments.length >= input.comments.length,
      "The three user comments must remain distinct and ordered, including the intentional repeated comment.",
    );
    const humanRows = final ? humanCommentRows(final) : [];
    const ids = humanRows.map((comment) => String(comment.id ?? ""));
    check(
      "distinct-comment-identities",
      ids.length === new Set(ids).size && ids.every(Boolean),
      "Each delivered user comment must retain its own durable identity, including repeated wording.",
    );
    check(
      "changed-scope-preserved",
      finalComments.at(2) === input.comments[2] && finalComments.at(0) === finalComments.at(1),
      "The final changed-scope comment must follow two identical earlier comments.",
    );
    const body = String(final?.documents.find((document) => String(document.body ?? "").includes("passport"))?.body ?? "");
    const orderedTerms = [input.comments[0], input.comments[1], input.comments[2]];
    let cursor = -1;
    const ordered = orderedTerms.every((term) => {
      const position = body.indexOf(term, cursor + 1);
      if (position < 0) return false;
      cursor = position + term.length - 1;
      return true;
    });
    check(
      "packing-report-order",
      ordered,
      "The durable packing report must retain both initial items and each verbatim request in order, including the repeated request and final scope.",
    );
  }
  if (input.id === "assigned-skill-explicit-invocation") {
    check("assigned-skill-present", Boolean(initial?.assignedSkill?.key && initial.assignedSkill.versionId), "The task run must receive one pinned skill version through the public assignment state.");
    check("skill-explicitly-invoked", initial?.skillInvocationEvidence === true, "Evidence must show the assigned skill was explicitly invoked; assignment alone is insufficient.");
  }
  const output = final ? oneOutput(final, input.marker, input.id === "assigned-skill-explicit-invocation") : undefined;
  check("single-durable-output", Boolean(output) && final!.documents.length === 1, input.id === "assigned-skill-explicit-invocation" ? "Exactly one durable task document must contain the skill's marker." : "Exactly one durable packing report document must be saved.");
  check("completed-task", final?.issue.status === "done", `Final task status: ${final?.issue.status ?? "missing"}.`);
  check("successful-runs", Boolean(final?.runs.length) && final!.runs.every((run) => run.status === "succeeded"), "All recorded context-integrity runs must succeed.");
  return checks;
}
