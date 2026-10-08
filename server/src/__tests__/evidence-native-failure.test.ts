import { describe, expect, it } from "vitest";
import { unprocessable } from "../errors.js";
import { nativeSessionFailureDisposition, nativeSessionFailureSourceCode, nativeSessionRecoveryProjection } from "../services/native-runtime/native-session-executor.js";

describe("native evidence denial cannot schedule provider recovery", () => {
  it.each(["evidence_pack_expired", "evidence_pack_admission_changed", "evidence_pack_reviewer_assignment_changed"])("no replay for %s", code => {
    const source = nativeSessionFailureSourceCode(unprocessable("Evidence pack blocks execution", { code }));
    expect(source).toBe("evidence_pack_denied");
    const disposition = nativeSessionFailureDisposition(1, new Date(), source);
    expect(disposition).toEqual({ phase: "terminal_failure", failureCode: "evidence_pack_denied", nextAttemptAt: null });
    expect(nativeSessionRecoveryProjection({ ...disposition, agentId: "executor" })).toMatchObject({ recoveryActionOwnerType: "board", recoveryActionOwnerAgentId: null });
  });
});
