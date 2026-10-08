import { describe, expect, it, vi } from "vitest";

import type { ControlPlanePort } from "./contracts/control-plane-port.js";
import type { NativeExecutionInputV1 } from "./contracts/native-execution.js";
import type {
  NativeSession,
  NativeSessionBackend,
  PersistedNativeSession,
} from "./contracts/native-session-backend.js";
import type { PrpEvent, PrpStructuredRunResult, PrpTerminalState } from "./protocol/replay-contract.js";
import { executeNativeSession, type ExecuteNativeSessionOptions } from "./native-session-runtime.js";

// Evidence/authorization admission must run immediately before every
// effectful provider operation, not only before the fresh bootstrap/turn.
// Each case invalidates admission during an earlier asynchronous step and
// requires that the next provider operation is never reached.

const identity = { runId: "run-a1", sessionId: "session-a1", companyId: "company-a1", issueId: "issue-a1", agentId: "agent-a1" };
const capabilities = { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true };
const result: PrpStructuredRunResult = {
  schema: "paperclip.run_result.v1", reportedWorkDisposition: "done", summary: "done",
  completionClaim: { contractRevision: "1", objectiveSatisfied: true, criteria: [{ criterionId: "objective", status: "satisfied", evidenceRefs: [] }], remainingWork: [] },
  evidence: [], verification: [], attentionRequests: [], artifacts: [],
};
const terminal: PrpTerminalState = { schema: "paperclip.prp.terminal.v1", turnTerminalState: "completed", runTerminalState: "succeeded", reportedWorkDisposition: "done" };
const input: NativeExecutionInputV1 = {
  schema: "paperclip.native-execution-input.v1",
  binding: { companyId: identity.companyId, runId: identity.runId, issueId: identity.issueId, agentId: identity.agentId, executionWorkspaceId: "workspace-a1" },
  task: { identifier: "A1", title: "A1", description: null, prompt: "Bound execution", workMode: "standard" },
  workspace: { cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
  session: { normalizedSessionId: identity.sessionId, driverKind: "codex_app_server", protocolVersion: 1 },
  provider: { kind: "codex", model: null },
  completionContract: { id: "a1", sha256: "a1", schemaVersion: "paperclip.completion-contract.v1", contract: { revision: "1", objective: "Bound execution", criteria: [{ id: "objective", requirement: "one turn" }] } },
  interactionResponses: [], credentialBindings: [],
};
const restartFailure = { code: "provider_turn_lost_on_restore", recoverable: true };
const baseCheckpoint: PersistedNativeSession = {
  backendKind: "runner", driverKind: "codex_app_server", sessionId: "thread-a1", identity,
  providerSessionId: "provider-a1", cursor: "0", activeTurnId: null, terminalTurns: [],
  semanticResult: null, pendingRuntimeRequests: [], lineage: [],
};
const interrupted: PersistedNativeSession = {
  ...baseCheckpoint,
  terminalTurns: [{ turnId: "turn-old", fingerprint: JSON.stringify({ terminalState: "failed", error: restartFailure, result: null }) }],
};
const activeGoal = { threadId: "thread-a1", objective: "Keep going", status: "active" as const, tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 };

function runnerEvent(sourceSeq: number, eventType: PrpEvent["eventType"], turnId: string, payload: Record<string, unknown> = {}): PrpEvent {
  return {
    schema: "paperclip.prp.event.v1", sourceEventId: `a1:${sourceSeq}`, sourceSeq, sourceInstanceId: "runner-a1",
    sourceKind: "runner", runId: identity.runId, normalizedSessionId: identity.sessionId, turnId, eventType,
    schemaVersion: 1, priority: 0, emittedAt: "2026-10-07T00:00:00.000Z", payload,
  };
}

function scenario(snapshot: PersistedNativeSession, options: { failedTurnFirst?: boolean } = {}) {
  let valid = true;
  const denial = Object.assign(new Error("Evidence pack blocks execution"), { details: { code: "evidence_pack_admission_changed" } });
  const admission = vi.fn(async () => { if (!valid) throw denial; });
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => { settle = resolve; });
  const startTurn = vi.fn<NativeSession["startTurn"]>(async () => { settle(); return { turnId: "turn-new" }; });
  const goal = vi.fn<NonNullable<NativeSession["goal"]>>(async (operation) => {
    if (operation.action !== "get") settle();
    return operation.action === "get" ? structuredClone(activeGoal) : { ...activeGoal, status: "complete" };
  });
  const attachRun = vi.fn(async () => {});
  const close = vi.fn(async () => { settle(); });
  const session: NativeSession = {
    identity: () => identity,
    async capabilities() { return capabilities; },
    async *events() {
      if (options.failedTurnFirst) yield runnerEvent(1, "turn.failed", "turn-old", { status: "failed", error: restartFailure });
      await settled;
      yield runnerEvent(options.failedTurnFirst ? 2 : 1, "turn.completed", "turn-new", { status: "completed" });
    },
    startTurn, goal, attachRun, close,
    cancel() { settle(); return { cleanup: Promise.resolve() }; },
    async result() { return startTurn.mock.calls.length ? { result, terminal, turnId: "turn-new" } : null; },
    async snapshot() { return structuredClone(snapshot); },
  };
  const port: ControlPlanePort = {
    async openRun() {},
    async checkpointSession() {},
    async appendEvent(event) { return { cursor: event.sourceSeq, highestContiguousSourceSeq: event.sourceSeq, disposition: "committed" }; },
    async replayEvents() { return { events: [], highestContiguousSourceSeq: 0 }; },
    async completeRun() {},
  };
  const invalidate = () => { valid = false; };
  const run = (extra: Partial<ExecuteNativeSessionOptions>) => executeNativeSession({
    input, controlPlane: port, runnerInstanceId: "runner-a1", controlPlaneInstanceId: "control-a1",
    onOperationAdmission: admission, backend: extra.backend!, ...extra,
  }).then((value) => ({ value, error: null as unknown }), (error: unknown) => ({ value: null, error }));
  return { session, admission, startTurn, goal, attachRun, close, invalidate, denial, run };
}

function backendWith(overrides: Partial<NativeSessionBackend>): NativeSessionBackend {
  return {
    async descriptor() { return { kind: "runner", name: "a1", version: "1", capabilities }; },
    async openSession() { throw new Error("unexpected fresh session"); },
    ...overrides,
  };
}

describe("evidence operation admission before non-fresh provider operations", () => {
  it.each([false, true])("retained attach revalidates after preparation (denied=%s)", async (denied) => {
    const s = scenario(baseCheckpoint);
    const outcome = await s.run({
      backend: backendWith({}), existingSession: s.session,
      onSessionAdmission: async () => { if (denied) s.invalidate(); },
    });
    if (denied) {
      expect(outcome.error).toBe(s.denial);
      expect(s.attachRun).not.toHaveBeenCalled();
      expect(s.startTurn).not.toHaveBeenCalled();
    } else {
      expect(outcome.error).toBeNull();
      expect(s.attachRun).toHaveBeenCalledOnce();
      expect(s.startTurn).toHaveBeenCalledOnce();
      expect(s.admission.mock.invocationCallOrder[0]).toBeLessThan(s.attachRun.mock.invocationCallOrder[0]!);
    }
  });

  it.each([false, true])("provider recovery revalidates and forwards admission to the driver (denied=%s)", async (denied) => {
    const s = scenario(baseCheckpoint);
    const recoverSession = vi.fn<NonNullable<NativeSessionBackend["recoverSession"]>>(async () => ({ recovered: true, session: s.session }));
    const outcome = await s.run({
      backend: backendWith({ recoverSession }), persistedSession: baseCheckpoint,
      onSessionAdmission: async () => { if (denied) s.invalidate(); },
    });
    if (denied) {
      expect(outcome.error).toBe(s.denial);
      expect(recoverSession).not.toHaveBeenCalled();
      expect(s.startTurn).not.toHaveBeenCalled();
    } else {
      expect(outcome.error).toBeNull();
      expect(recoverSession).toHaveBeenCalledOnce();
      expect(recoverSession.mock.calls[0]![1].onOperationAdmission).toBe(s.admission);
    }
  });

  it.each([false, true])("provider replacement revalidates after failed recovery (denied=%s)", async (denied) => {
    const s = scenario(baseCheckpoint);
    const checkpoint = { ...baseCheckpoint, providerRecoveryPolicy: "allow_replacement_after_resume_failure" as const };
    // Recovery is asynchronous provider work: invalidation may land during it.
    const recoverSession = vi.fn(async () => { if (denied) s.invalidate(); return { recovered: false as const, reason: "provider session missing" }; });
    const openReplacementSession = vi.fn<NonNullable<NativeSessionBackend["openReplacementSession"]>>(async () => s.session);
    const outcome = await s.run({ backend: backendWith({ recoverSession, openReplacementSession }), persistedSession: checkpoint });
    expect(recoverSession).toHaveBeenCalledOnce();
    if (denied) {
      expect(outcome.error).toBe(s.denial);
      expect(openReplacementSession).not.toHaveBeenCalled();
      expect(s.startTurn).not.toHaveBeenCalled();
    } else {
      expect(outcome.error).toBeNull();
      expect(openReplacementSession).toHaveBeenCalledOnce();
      expect(openReplacementSession.mock.calls[0]![0].onOperationAdmission).toBe(s.admission);
    }
  });

  it.each([false, true])("checkpointed restart continuation turn revalidates after recovery (denied=%s)", async (denied) => {
    const s = scenario(interrupted);
    const recoverSession = vi.fn(async () => { if (denied) s.invalidate(); return { recovered: true as const, session: s.session }; });
    const outcome = await s.run({ backend: backendWith({ recoverSession }), persistedSession: interrupted });
    if (denied) {
      expect(outcome.error).toBe(s.denial);
      expect(s.startTurn).not.toHaveBeenCalled();
    } else {
      expect(outcome.error).toBeNull();
      expect(s.startTurn).toHaveBeenCalledOnce();
      expect(s.startTurn.mock.calls[0]![0].continuation).toBe(true);
    }
  });

  it.each([false, true])("live restart continuation turn revalidates (denied=%s)", async (denied) => {
    const checkpoint = { ...baseCheckpoint, activeTurnId: "turn-old" };
    const s = scenario(interrupted, { failedTurnFirst: true });
    const recoverSession = vi.fn(async () => { if (denied) s.invalidate(); return { recovered: true as const, session: s.session }; });
    const outcome = await s.run({ backend: backendWith({ recoverSession }), persistedSession: checkpoint, resumeInterruptedTurn: true });
    if (denied) {
      expect(outcome.error).toBe(s.denial);
      expect(s.startTurn).not.toHaveBeenCalled();
    } else {
      expect(outcome.error).toBeNull();
      expect(s.startTurn).toHaveBeenCalledOnce();
      expect(s.startTurn.mock.calls[0]![0].continuation).toBe(true);
    }
  });

  it("goal resume heartbeat revalidates before resuming provider work", async () => {
    const snapshot = { ...baseCheckpoint, goal: activeGoal };
    const s = scenario(snapshot);
    const recoverSession = vi.fn(async () => { s.invalidate(); return { recovered: true as const, session: s.session }; });
    const outcome = await s.run({ backend: backendWith({ recoverSession }), persistedSession: snapshot, resumeSessionGoalHeartbeat: true });
    expect(outcome.error).toBe(s.denial);
    expect(s.goal.mock.calls.filter(([operation]) => operation.action !== "get")).toEqual([]);
  });

  it.each(["create", "edit", "replace", "resume"] as const)("work-granting goal control %s revalidates", async (action) => {
    const snapshot = { ...baseCheckpoint, goal: activeGoal };
    const s = scenario(snapshot);
    const recoverSession = vi.fn(async () => { s.invalidate(); return { recovered: true as const, session: s.session }; });
    const outcome = await s.run({
      backend: backendWith({ recoverSession }), persistedSession: snapshot,
      sessionGoalControl: { requestId: "goal-a1", action, objective: "Different objective" },
    });
    expect(outcome.error).toBe(s.denial);
    expect(s.goal.mock.calls.filter(([operation]) => operation.action !== "get")).toEqual([]);
  });
});
