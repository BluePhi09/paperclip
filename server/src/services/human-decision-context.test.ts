import { describe, expect, it } from "vitest";
import { createIssueThreadInteractionSchema } from "@paperclipai/shared";
import { assertHumanDecisionContext, assertHumanInteractionContext } from "./human-decision-context.js";
const brief = {
  version: 1, decisionClass: "expert_review", purpose: "plan_review", subject: "Plan für den Neustart prüfen?",
  mainSummary: "Prüfe nur den Neustartplan. Ein positives Votum erlaubt noch keinen Neustart.",
  resolverTarget: { type: "human", reason: "Der Mensch prüft den Plan." },
  evidenceRefs: [{ source: "Neustartplan", revision: "5" }],
  selectionConsequences: [{ optionId: "accept", label: "Plan als geprüft markieren", consequence: "Prüfung dokumentieren, nichts ausführen." }, { optionId: "reject", label: "Plan überarbeiten lassen", consequence: "Plan überarbeiten, nichts ausführen." }],
  safeDefault: "Plan bleibt ungeprüft; nichts ausführen.", scope: "Nur diesen Neustartplan prüfen.", excludedScope: "Kein Neustart und kein Agentenstopp.", risks: "Umsetzung würde die Erreichbarkeit unterbrechen.", preconditions: [],
};
const labels = { acceptLabel: brief.selectionConsequences[0].label, rejectLabel: brief.selectionConsequences[1].label };
const parse = (input: unknown) => createIssueThreadInteractionSchema.parse(input);
describe("human creation path context preflight", () => {
  it.each(["request_confirmation", "request_checkbox_confirmation", "ask_user_questions", "request_item_verdicts"])("rejects brief-less new %s with field-specific 422", (kind) => {
    const payload = kind === "ask_user_questions" ? { version: 1, questions: [{ id: "q", prompt: "Choose", selectionMode: "single", options: [{ id: "a", label: "Answer" }] }] }
      : kind === "request_item_verdicts" ? { version: 1, prompt: "Choose", items: [{ id: "i", label: "Document" }] }
      : { version: 1, prompt: "Choose", ...(kind === "request_checkbox_confirmation" ? { options: [{ id: "a", label: "Criterion" }] } : {}) };
    expect(() => assertHumanInteractionContext(parse({ kind, resolverPolicy: "human_only", payload }), "human_only")).toThrow(expect.objectContaining({ status: 422, details: expect.objectContaining({ code: "decision_context_missing" }) }));
  });
  it("accepts the complete native confirmation and rejects mismatched decisive labels", () => {
    const data = parse({ kind: "request_confirmation", resolverPolicy: "human_only", payload: { version: 1, prompt: brief.subject, ...labels, brief } });
    expect(() => assertHumanInteractionContext(data, "human_only")).not.toThrow();
    expect(() => assertHumanInteractionContext(parse({ ...data, payload: { ...data.payload, acceptLabel: "Approve everything" } }), "human_only")).toThrow();
  });
  it("does not let an agent label bypass human-only preflight", () => {
    const data = parse({ kind: "request_confirmation", payload: { version: 1, prompt: "see task" } });
    const addressed = { ...data, addresseeAgentId: "11111111-1111-4111-8111-111111111111" };
    expect(() => assertHumanInteractionContext(addressed, "human_only")).toThrow();
    expect(() => assertHumanInteractionContext(addressed, "not_creator")).not.toThrow();
  });
  it("keeps open coordination cards agent-internal and brief-free", () => {
    const data = parse({ kind: "request_confirmation", payload: { version: 1, prompt: "see task" } });
    expect(() => assertHumanInteractionContext(data, "anyone")).not.toThrow();
    expect(() => assertHumanInteractionContext(data, "not_creator")).not.toThrow();
    expect(() => assertHumanInteractionContext(data, "human_only")).toThrow();
    const userAddressed = { ...data, addresseeUserId: "user-1" };
    expect(() => assertHumanInteractionContext(userAddressed, "anyone")).toThrow();
  });
  it("requires standalone Decision option labels to match the explanation", () => {
    expect(() => assertHumanDecisionContext(brief, "metadata.brief", brief.selectionConsequences.map(e => ({ id: e.optionId, label: e.label })))).not.toThrow();
    expect(() => assertHumanDecisionContext(undefined, "metadata.brief", [])).toThrow();
    expect(() => assertHumanDecisionContext(brief, "metadata.brief", [{ id: "accept", label: "Different effect" }])).toThrow();
  });
});
