import { describe, expect, it } from "vitest";
import { humanDecisionQualityIssues } from "@paperclipai/shared";
import { BRIEF_TEXT_LIMITS, clipBriefText, nativeConnectionAuthorizationBrief, nativeHumanActionBrief } from "./native-human-action-brief.js";

const input = {
  subject: "Approve Delete everything?", summary: "Allow this agent to run Delete everything once.",
  scope: "One action with these arguments: {}", excludedScope: "No other action is authorized.",
  risks: "This action may remove data.", preconditions: ["Review the arguments before authorizing."],
  source: "tool-action:1", revision: "hash-1", acceptLabel: "Approve action", rejectLabel: "Reject action",
  acceptConsequence: "Run this one action.", rejectConsequence: "Do not run this action.",
};

describe("native human action brief limits", () => {
  it("shortens over-long generated fields with a visible marker instead of failing the native card", () => {
    const longName = "Delete " + "x".repeat(400);
    const brief = nativeHumanActionBrief({
      ...input,
      subject: `Approve ${longName}?`,
      summary: `Allow this agent to run ${longName} once. `.repeat(3),
      scope: `One action with these arguments: ${"a".repeat(4000)}`,
    });
    expect(humanDecisionQualityIssues(brief)).toEqual([]);
    expect(brief.subject.length).toBeLessThanOrEqual(BRIEF_TEXT_LIMITS.subject);
    expect(brief.subject.endsWith("…")).toBe(true);
    expect(brief.mainSummary!.length).toBeLessThanOrEqual(BRIEF_TEXT_LIMITS.summary);
    expect(brief.mainSummary!.endsWith("…")).toBe(true);
    expect(brief.scope!.length).toBeLessThanOrEqual(BRIEF_TEXT_LIMITS.text);
    expect(brief.scope!.endsWith("…")).toBe(true);
  });

  it("keeps fitting text unchanged", () => {
    const brief = nativeHumanActionBrief(input);
    expect(brief).toMatchObject({ subject: input.subject, mainSummary: input.summary, scope: input.scope });
  });

  it("lets callers name where the complete text lives", () => {
    const clipped = clipBriefText("a".repeat(3000), 2000, " … (shortened; see details)");
    expect(clipped).toHaveLength(2000);
    expect(clipped.endsWith(" … (shortened; see details)")).toBe(true);
  });

  it("never splits a surrogate pair at the cut", () => {
    const clipped = clipBriefText("a".repeat(158) + "😀".repeat(10), 160);
    expect(clipped).toBe("a".repeat(158) + "…");
  });

  it("builds a valid connection brief for very long provider names", () => {
    const name = "Provider " + "p".repeat(300);
    const brief = nativeConnectionAuthorizationBrief(name, "connection:1", "rev", `Connect ${name}`);
    expect(humanDecisionQualityIssues(brief)).toEqual([]);
    expect(brief.selectionConsequences[0]!.label!.length).toBeLessThanOrEqual(BRIEF_TEXT_LIMITS.label);
  });
});
