import { describe, expect, it } from "vitest";
import { decisionBriefAuthorizesEffects, decisionBriefSchema } from "./decision-brief.js";
import { createIssueThreadInteractionSchema } from "./issue.js";

export const factBrief = {
  version: 1, decisionClass: "personal_fact", subject: "Who used admin-219 on 7 October?",
  resolverTarget: { type: "human", reason: "Only the person knows their own action" },
  evidenceRefs: [{ source: "Access record, 7 October", revision: "window 08:00–09:00 UTC" }],
  selectionConsequences: [{ optionId: "me", consequence: "Record the actor only; no access authorized" }],
  safeDefault: "Unknown actor; no permissions change",
};

describe("version 1 decision brief", () => {
  it("centralizes complete explicit execution authorization without granting authority", () => {
    const full = { ...factBrief, decisionClass: "internal_detail", purpose: "execution_authorization", reason: "Routine scope", scope: "One row", excludedScope: "Other rows", risks: "Wrong row", preconditions: [], recommendationOptionId: "me", recommendationReason: "Within approved scope" };
    expect(decisionBriefAuthorizesEffects(full)).toBe(true);
    expect(decisionBriefAuthorizesEffects({ ...full, scope: undefined })).toBe(false);
    expect(decisionBriefAuthorizesEffects({ ...full, purpose: undefined, decisionClass: "expert_review" })).toBe(false);
    expect(decisionBriefAuthorizesEffects({ ...full, purpose: "plan_review", decisionClass: "expert_review" })).toBe(false);
    expect(decisionBriefAuthorizesEffects({ ...full, decisionClass: "personal_fact" })).toBe(false);
    expect(decisionBriefAuthorizesEffects({ ...full, version: 2 })).toBe(false);
  });
  it.each([
    ["internal_detail", "fact"], ["expert_review", "fact"],
    ["personal_fact", "execution_authorization"], ["personal_fact", "plan_review"],
    ["human_risk_decision", "fact"], ["internal_detail", "plan_review"],
  ])("rejects contradictory class %s and purpose %s", (decisionClass, purpose) => {
    const full = { ...factBrief, decisionClass, purpose, reason: "Reason", scope: "Scope", excludedScope: "Excluded", risks: "Risks", preconditions: [], recommendationOptionId: "me", recommendationReason: "Reason" };
    expect(decisionBriefSchema.safeParse(full).success).toBe(false);
  });
  it("preserves atomic item-verdict briefs with exactly the enabled verdicts", () => {
    const brief = { ...factBrief, decisionClass: "expert_review", selectionConsequences: ["approve", "reject"].map((optionId) => ({ optionId, consequence: "Record review only" })) };
    const input = { kind: "request_item_verdicts", payload: { version: 1, prompt: "Review documents", verdicts: ["approve", "reject"], items: [{ id: "doc", label: "Document", brief }] } };
    expect(createIssueThreadInteractionSchema.parse(input).payload).toMatchObject({ items: [{ brief }] });
    expect(createIssueThreadInteractionSchema.safeParse({ ...input, payload: { ...input.payload, verdicts: ["approve", "reject", "defer"] } }).success).toBe(false);
  });
  it("preserves checkbox briefs with option and accept/reject consequences", () => {
    const ids = ["criterion", "accept", "reject"];
    const brief = { ...factBrief, decisionClass: "expert_review", selectionConsequences: ids.map((optionId) => ({ optionId, consequence: "Record only; no execution" })) };
    const input = { kind: "request_checkbox_confirmation", payload: { version: 1, prompt: "Review criterion", options: [{ id: "criterion", label: "Evidence exists" }], brief } };
    expect(createIssueThreadInteractionSchema.parse(input).payload).toMatchObject({ brief });
    expect(createIssueThreadInteractionSchema.safeParse({ ...input, payload: { ...input.payload, brief: { ...brief, selectionConsequences: brief.selectionConsequences.slice(1) } } }).success).toBe(false);
  });
  it("preserves atomic question briefs and binds consequences to that question's options", () => {
    const question = { id: "actor", prompt: "Who used this account?", selectionMode: "single", options: [{ id: "me", label: "Me" }], brief: factBrief };
    const input = { kind: "ask_user_questions", payload: { version: 1, questions: [question] } };
    expect(createIssueThreadInteractionSchema.parse(input).payload).toMatchObject({ questions: [{ brief: factBrief }] });
    expect(createIssueThreadInteractionSchema.safeParse({ ...input, payload: { version: 1, questions: [{ ...question, brief: { ...factBrief, selectionConsequences: [{ optionId: "other-question", consequence: "No authority" }] } }] } }).success).toBe(false);
  });
  it("preserves and validates opted-in native confirmation briefs with exact accept/reject consequences", () => {
    const brief = { ...factBrief, decisionClass: "expert_review", selectionConsequences: [{ optionId: "accept", consequence: "Record review only" }, { optionId: "reject", consequence: "Revise document" }] };
    const input = { kind: "request_confirmation", payload: { version: 1, prompt: "Review revision 1", brief } };
    expect(createIssueThreadInteractionSchema.parse(input).payload).toMatchObject({ brief });
    expect(createIssueThreadInteractionSchema.safeParse({ ...input, payload: { ...input.payload, brief: { ...brief, subject: " " } } }).success).toBe(false);
    expect(createIssueThreadInteractionSchema.safeParse({ ...input, payload: { ...input.payload, brief: { ...brief, selectionConsequences: [{ optionId: "missing", consequence: "No action" }] } } }).success).toBe(false);
  });
  it("requires scoped risk authorization while accepting a bounded expert document review", () => {
    const risk = { ...factBrief, decisionClass: "human_risk_decision" };
    expect(decisionBriefSchema.safeParse(risk).success).toBe(false);
    expect(decisionBriefSchema.safeParse({ ...risk, reason: "Reserve a window", scope: "Reservation only", excludedScope: "No CA rotation", risks: "Availability unchanged", preconditions: ["Confirm availability"], recommendationOptionId: "me", recommendationReason: "No execution starts" }).success).toBe(true);
    expect(decisionBriefSchema.safeParse({ ...factBrief, decisionClass: "expert_review", resolverTarget: { type: "agent", agentId: "11111111-1111-4111-8111-111111111111", reason: "Independent reviewer" }, purpose: "plan_review" }).success).toBe(true);
    expect(decisionBriefSchema.safeParse({ ...factBrief, subject: " " }).success).toBe(false);
    expect(decisionBriefSchema.safeParse({ ...factBrief, version: 2 }).success).toBe(false);
    expect(decisionBriefSchema.safeParse({ ...factBrief, evidenceRefs: [] }).success).toBe(false);
  });
  it("accepts a short precise personal fact without risk forms and rejects a fabricated recommendation", () => {
    expect(decisionBriefSchema.safeParse(factBrief).success).toBe(true);
    expect(decisionBriefSchema.safeParse({ ...factBrief, recommendationOptionId: "me" }).success).toBe(false);
  });
});
