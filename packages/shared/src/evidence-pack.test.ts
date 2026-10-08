import { describe, expect, it } from "vitest";
import * as shared from "./index.js";
import * as evidencePack from "./evidence-pack.js";

describe("evidence pack schemas", () => {
  it("are exported from the package root like the other schemas", () => {
    expect(shared.evidencePackSchema).toBe(evidencePack.evidencePackSchema);
    expect(shared.evidencePackBindingSchema).toBe(evidencePack.evidencePackBindingSchema);
    expect(shared.evidenceDocumentRefSchema).toBe(evidencePack.evidenceDocumentRefSchema);
    expect(shared.evidenceScopeSchema).toBe(evidencePack.evidenceScopeSchema);
    expect(shared.evidenceTargetContextSchema).toBe(evidencePack.evidenceTargetContextSchema);
  });
});
