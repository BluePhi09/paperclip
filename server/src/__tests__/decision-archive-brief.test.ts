import { describe, expect, it } from "vitest";
import { attentionArchiveProposalBrief } from "../routes/decisions.js";
import { assertHumanDecisionContext } from "../services/human-decision-context.js";

const entry = (n: number) => ({ id: String(n) }) as never;

describe("attention archive proposal brief", () => {
  it.each([1, 3])("is a complete human brief matching the native options (%i items)", (count) => {
    const brief = attentionArchiveProposalBrief(Array.from({ length: count }, (_, i) => entry(i)), "hash-1");
    expect(() => assertHumanDecisionContext(brief, "metadata.brief", [
      { id: "archive", label: "Archive reviewed items" },
      { id: "keep", label: "Keep items" },
    ])).not.toThrow();
    expect(brief.subject).toContain(count === 1 ? "1 aging item" : "3 aging items");
    expect(brief.mainSummary).toMatch(/not answered, approved or deleted/);
    expect(brief.evidenceRefs[0]).toEqual({ source: "attention-archive-manifest", revision: "hash-1" });
  });
});
