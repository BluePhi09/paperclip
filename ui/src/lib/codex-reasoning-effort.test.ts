// @vitest-environment node

import { describe, expect, it } from "vitest";
import { codexReasoningEffortOptions } from "./codex-reasoning-effort";

describe("codexReasoningEffortOptions", () => {
  it.each(["gpt-6-astra", "gpt-6-sol"])("exposes only the supported %s reasoning efforts", (model) => {
    expect(codexReasoningEffortOptions(model)).toEqual([
      { value: "", label: "Default" },
      { value: "low", label: "Low" },
      { value: "medium", label: "Medium" },
      { value: "high", label: "High" },
      { value: "xhigh", label: "X-High" },
      { value: "max", label: "Max" },
      { value: "ultra", label: "Ultra" },
    ]);
  });

  it("preserves the existing choices for other and manual models", () => {
    expect(codexReasoningEffortOptions("gpt-5.6-sol").map((option) => option.value)).toEqual([
      "",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });
});
