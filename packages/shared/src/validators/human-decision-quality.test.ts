import { describe, expect, it } from "vitest";
import { decisionBriefSchema, humanDecisionQualityIssues } from "./decision-brief.js";
const brief = {
  version: 1, decisionClass: "personal_fact", purpose: "fact", subject: "Nutzen Personen außerhalb deines Haushalts deine Dienste?",
  mainSummary: "Nenne Personengruppe und Dienst, keine Namen. Deine Antwort hält nur eine Tatsache fest und erlaubt keine Änderungen.",
  resolverTarget: { type: "human", reason: "Nur du kennst die Nutzergruppe." },
  evidenceRefs: [{ source: "Frage nach aktueller Nutzung", revision: "2026-10-07" }],
  selectionConsequences: [{ optionId: "household", label: "Nur mein Haushalt", consequence: "Nur diese Nutzung festhalten; keine Änderung erlauben." }],
  safeDefault: "Nutzung bleibt ungeklärt; nichts ändern.",
};
describe("new human decision quality preflight", () => {
  it("requires a brief rather than silently accepting a task reference", () => {
    expect(humanDecisionQualityIssues(undefined)).toEqual(expect.arrayContaining([expect.objectContaining({ path: "brief", code: "decision_context_missing" })]));
  });
  it("accepts a concise personal fact without recommendation or rollback fiction", () => {
    expect(humanDecisionQualityIssues(brief)).toEqual([]);
    expect(decisionBriefSchema.parse(brief)).toMatchObject({ mainSummary: brief.mainSummary, selectionConsequences: [{ label: "Nur mein Haushalt" }] });
  });
  it.each([undefined, "Siehe Task", "BLU-425", "TBD"])("rejects missing or referential summary %s", (mainSummary) => {
    expect(humanDecisionQualityIssues({ ...brief, mainSummary })).toEqual(expect.arrayContaining([expect.objectContaining({ path: "brief.mainSummary" })]));
  });
  it("requires explicit purpose and readable option labels", () => {
    const errors = humanDecisionQualityIssues({ ...brief, purpose: undefined, selectionConsequences: [{ optionId: "household", label: "OK", consequence: "siehe Task" }] });
    expect(errors.map(e => e.path)).toEqual(expect.arrayContaining(["brief.purpose", "brief.selectionConsequences.0.label", "brief.selectionConsequences.0.consequence"]));
  });
  it("requires non-factual human scope, exceptions, risk and explicit prerequisite review", () => {
    const review = { ...brief, decisionClass: "expert_review", purpose: "plan_review" };
    expect(humanDecisionQualityIssues(review).map(e => e.path)).toEqual(expect.arrayContaining(["brief.scope", "brief.excludedScope", "brief.risks", "brief.preconditions"]));
    expect(humanDecisionQualityIssues({ ...review, scope: "Nur den Plan für einen Neustart prüfen.", excludedScope: "Noch keinen Neustart erlauben.", risks: "Bei Umsetzung wäre Paperclip kurz unerreichbar.", preconditions: [] })).toEqual([]);
  });
  it("keeps old stored briefs readable but refuses them as new human cards", () => {
    const legacy = { ...brief, mainSummary: undefined };
    expect(decisionBriefSchema.safeParse(legacy).success).toBe(true);
    expect(humanDecisionQualityIssues(legacy).length).toBeGreaterThan(0);
  });
});
