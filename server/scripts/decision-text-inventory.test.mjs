import { describe, expect, it } from "vitest";
import { decisionTextInventory } from "../../scripts/decision-text-inventory.mjs";
describe("read-only decision text inventory", () => {
  it("is deterministic, deduplicates snapshots and preserves human-only status, target and effects", () => {
    const row = { companyId: "company", id: "card", status: "pending", resolverPolicy: "human_only", createdByAgentId: "source", payload: { target: { revisionId: "revision-5" }, questions: [{ id: "fact" }, { id: "delete" }] } };
    const input = JSON.stringify(row);
    const single = decisionTextInventory(input);
    expect(decisionTextInventory(`${input}\n${input}`)).toEqual(single);
    expect(single).toMatchObject({ mode: "read_only", mutations: false, automaticApproval: false, entries: [{ preservation: { status: "pending", resolverPolicy: "human_only", target: row.payload.target }, proposedText: null, atomic: [{ id: "fact" }, { id: "delete" }] }] });
  });
  it("preserves requested and effective policies independently and blocks unknown effective policy", () => {
    const row = { companyId: "company", id: "card", status: "pending", requestedResolverPolicy: "anyone", effectiveResolverPolicy: "human_only", createdByAgentId: "source", payload: { target: null } };
    expect(decisionTextInventory(JSON.stringify(row)).entries[0]).toMatchObject({ preservation: { requestedResolverPolicy: "anyone", effectiveResolverPolicy: "human_only" }, missingContext: [] });
    expect(decisionTextInventory(JSON.stringify({ ...row, effectiveResolverPolicy: undefined })).entries[0].missingContext).toContain("Verified effective resolver policy / human_only");
  });
  it("refuses conflicting snapshots rather than selecting a stale revision", () => {
    expect(() => decisionTextInventory('{"companyId":"c","id":"i","status":"pending"}\n{"companyId":"c","id":"i","status":"resolved"}')).toThrow("Conflicting snapshots");
  });
  it("keeps truncated and unbound examples blocked, never invents missing context", () => {
    const manifest = decisionTextInventory('{"issue":"BLU-425"}\n{"payload": ... [truncated]');
    expect(manifest.entries.map(e => e.disposition).sort()).toEqual(["blocked_incomplete_export", "blocked_missing_context"]);
    expect(manifest.entries.every(e => e.proposedText === null)).toBe(true);
  });
});
