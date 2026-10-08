import { describe, expect, it } from "vitest";
import { decisionBriefSchema, humanDecisionQualityIssues } from "./decision-brief.js";
const brief = {
  version: 1, decisionClass: "personal_fact", purpose: "fact", subject: "Does anyone outside your team use the shared services?",
  mainSummary: "Name the group and the service, no names. Your answer only records a fact and permits no change.",
  resolverTarget: { type: "human", reason: "Only you know who uses the services." },
  evidenceRefs: [{ source: "Usage question", revision: "1" }],
  selectionConsequences: [{ optionId: "team_only", label: "Only my team", consequence: "Record this usage only; permit no change." }],
  safeDefault: "Usage stays unknown; change nothing.",
};
describe("new human decision quality preflight", () => {
  it("requires a brief rather than silently accepting a task reference", () => {
    expect(humanDecisionQualityIssues(undefined)).toEqual(expect.arrayContaining([expect.objectContaining({ path: "brief", code: "decision_context_missing" })]));
  });
  it("accepts a concise personal fact without recommendation or rollback fiction", () => {
    expect(humanDecisionQualityIssues(brief)).toEqual([]);
    expect(decisionBriefSchema.parse(brief)).toMatchObject({ mainSummary: brief.mainSummary, selectionConsequences: [{ label: "Only my team" }] });
  });
  it.each([undefined, "Siehe Task", "ABC-123", "TBD"])("rejects missing or referential summary %s", (mainSummary) => {
    expect(humanDecisionQualityIssues({ ...brief, mainSummary })).toEqual(expect.arrayContaining([expect.objectContaining({ path: "brief.mainSummary" })]));
  });
  it("requires explicit purpose and readable option labels", () => {
    const errors = humanDecisionQualityIssues({ ...brief, purpose: undefined, selectionConsequences: [{ optionId: "team_only", label: "OK", consequence: "siehe Task" }] });
    expect(errors.map(e => e.path)).toEqual(expect.arrayContaining(["brief.purpose", "brief.selectionConsequences.0.label", "brief.selectionConsequences.0.consequence"]));
  });
  it("requires non-factual human scope, exceptions, risk and explicit prerequisite review", () => {
    const review = { ...brief, decisionClass: "expert_review", purpose: "plan_review" };
    expect(humanDecisionQualityIssues(review).map(e => e.path)).toEqual(expect.arrayContaining(["brief.scope", "brief.excludedScope", "brief.risks", "brief.preconditions"]));
    expect(humanDecisionQualityIssues({ ...review, scope: "Review the restart plan only.", excludedScope: "No restart is permitted yet.", risks: "If implemented, the service is briefly unreachable.", preconditions: [] })).toEqual([]);
  });
  it("keeps old stored briefs readable but refuses them as new human cards", () => {
    const legacy = { ...brief, mainSummary: undefined };
    expect(decisionBriefSchema.safeParse(legacy).success).toBe(true);
    expect(humanDecisionQualityIssues(legacy).length).toBeGreaterThan(0);
  });
});

describe("question brief option coverage", () => {
  const base = { id: "q", prompt: "Who?", selectionMode: "single" as const };
  const options = [{ id: "team_only", label: "Only my team" }, { id: "other", label: "Something else", freeText: true }];
  it("lets a brief omit the free-text slot but never a fixed option or an unknown one", async () => {
    const { askUserQuestionsQuestionSchema } = await import("./issue.js");
    expect(askUserQuestionsQuestionSchema.safeParse({ ...base, options, brief }).success).toBe(true);
    expect(askUserQuestionsQuestionSchema.safeParse({ ...base, options, brief: { ...brief, selectionConsequences: [] } }).success).toBe(false);
    const unknown = [...brief.selectionConsequences, { optionId: "ghost", label: "Ghost option", consequence: "Does nothing." }];
    expect(askUserQuestionsQuestionSchema.safeParse({ ...base, options, brief: { ...brief, selectionConsequences: unknown } }).success).toBe(false);
  });
});
