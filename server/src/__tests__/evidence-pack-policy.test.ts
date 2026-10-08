import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { authorizeEvidencePolicyChange } from "../services/evidence-pack.js";
import { normalizeIssueExecutionPolicy, stripMonitorFromExecutionPolicy } from "../services/issue-execution-policy.js";

export const binding = {
  schemaVersion: 1,
  documentId: "00000000-0000-4000-8000-000000000001",
  revisionId: "00000000-0000-4000-8000-000000000002",
  scope: { action: "implement", target: "example.test/demo", exclusions: ["deploy"] },
  receipts: ["00000000-0000-4000-8000-000000000003"],
};
describe("opt-in evidence pack policy", () => {
  const issue = { id: "issue", companyId: "company", executionPolicy: { evidencePack: binding } };
  it.each([{}, { agentId: "assignee" }, { agentId: "assignee", userId: "responsible-user" }])("does not infer governance from an agent or missing actor: %j", async (actor) => {
    const insert = vi.fn();
    await expect(authorizeEvidencePolicyChange({ insert } as unknown as Db, issue, null, actor)).rejects.toMatchObject({ status: 403, details: { code: "evidence_pack_governance_required" } });
    expect(insert).not.toHaveBeenCalled();
  });
  it("permits unrelated policy changes without granting evidence governance", async () => {
    const insert = vi.fn();
    await authorizeEvidencePolicyChange({ insert } as unknown as Db, issue, { evidencePack: binding, stages: [] }, { agentId: "assignee" });
    expect(insert).not.toHaveBeenCalled();
  });
  it("fails the governance write if its transactional audit cannot be saved", async () => {
    const values = vi.fn().mockRejectedValue(new Error("audit unavailable"));
    await expect(authorizeEvidencePolicyChange({ insert: () => ({ values }) } as unknown as Db, issue, null, { userId: "board" })).rejects.toThrow("audit unavailable");
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ companyId: "company", actorType: "user", actorId: "board", action: "issue.evidence_policy_changed" }));
  });
  it("preserves a pack-only policy through normalization and monitor removal", () => {
    const policy = normalizeIssueExecutionPolicy({ evidencePack: binding });
    expect(policy).not.toBeNull();
    expect(policy).toHaveProperty("evidencePack", binding);
    expect(stripMonitorFromExecutionPolicy({ ...policy!, monitor: { nextCheckAt: "2026-10-07T12:00:00Z", scheduledBy: "board", notes: null } })).toHaveProperty("evidencePack", binding);
  });
});
