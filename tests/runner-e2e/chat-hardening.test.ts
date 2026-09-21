import { describe, expect, it } from "vitest";
import { assertChatHire, assertChatSourceReview, assertCommittedSendRetry, assertGroundedChatStatus, isChatStopReady } from "./chat-hardening.js";
import { runnerMatrix } from "./catalog.js";
import { buildRunnerE2EProcessEnvironment } from "./harness-env.js";

const binding = { provider: "anthropic", method: "api_key", mode: "responsible_user" };
const hire = { id: "hire", name: "Morgan", reportsTo: "lead", adapterType: "paperclip_runner", adapterConfig: { model: "model" }, runtimeConfig: { aiConnection: binding } };
const task = { id: "task", companyId: "company", title: "Checklist", status: "done", assigneeAgentId: "hire", parentId: null, projectId: "project" };
const run = { id: "run", companyId: "company", agentId: "hire", status: "succeeded", runtimeMode: "native", contextSnapshot: { issueId: "task", aiConnection: { connectionId: "account" } } };
const hiring = { agents: [{ id: "lead", name: "Lead", adapterConfig: { model: "model" } }, hire], leadId: "lead", hireName: "Morgan", hiredId: "hire", connectionId: "account", binding, taskIds: ["task"], tasks: [task], runs: [run] };

describe("agent chat hardening oracles", () => {
  it("grades actual execution by the original hired identity and managed account", () => {
    expect(() => assertChatHire(hiring)).not.toThrow();
    for (const wrong of [
      { ...hiring, agents: [...hiring.agents, { ...hire, id: "duplicate" }] },
      { ...hiring, hiredId: "replaced" },
      { ...hiring, tasks: [{ ...task, parentId: "chat" }] },
      { ...hiring, tasks: [{ ...task, assigneeAgentId: "lead" }] },
      { ...hiring, runs: [] },
      { ...hiring, runs: [run, { ...run, id: "duplicate-run" }] },
      { ...hiring, runs: [{ ...run, agentId: "lead" }] },
      { ...hiring, connectionId: "wrong-account" },
    ]) expect(() => assertChatHire(wrong)).toThrow();
  });

  it("requires the current recorded blocker without silently starting or changing work", () => {
    const before = { ...task, status: "blocked" };
    const valid = { reply: "RUN-2 is blocked on VENUE123.", expectedIssueIdentifier: "RUN-2", blocker: "VENUE123", staleBlocker: "BUDGET123",
      before, after: before, taskIdsBefore: ["task"], taskIdsAfter: ["task"], taskRuns: [] };
    expect(() => assertGroundedChatStatus(valid)).not.toThrow();
    expect(() => assertGroundedChatStatus({ ...valid, reply: "RUN-2 is blocked on VENUE123. BUDGET123 was resolved." })).not.toThrow();
    expect(() => assertGroundedChatStatus({ ...valid, reply: "RUN-2 is blocked on BUDGET123." })).toThrow();
    expect(() => assertGroundedChatStatus({ ...valid, after: task })).toThrow();
    expect(() => assertGroundedChatStatus({ ...valid, taskRuns: [run] })).toThrow();
    expect(() => assertGroundedChatStatus({ ...valid, taskIdsAfter: ["task", "replacement"] })).toThrow();
  });

  it("independently compares review values and verdict, rejecting copied sources and missing evidence", () => {
    const expected = { planLaunchDay: "Tuesday", briefLaunchDay: "Wednesday" };
    expect(() => assertChatSourceReview(JSON.stringify({ ...expected, consistent: false }), expected)).not.toThrow();
    expect(() => assertChatSourceReview(JSON.stringify({ ...expected, consistent: true }), expected)).toThrow();
    expect(() => assertChatSourceReview("The plan says Tuesday and the brief says Wednesday.", expected)).toThrow();
    expect(() => assertChatSourceReview("{}", expected)).toThrow();
    expect(() => assertChatSourceReview(JSON.stringify({ ...expected, planLaunchDay: "Friday", consistent: false }), expected)).toThrow();
    expect(() => assertChatSourceReview('{"planLaunchDay":"Tuesday","briefLaunchDay":"Tuesday","consistent":true}', { planLaunchDay: "Tuesday", briefLaunchDay: "Tuesday" })).not.toThrow();
  });

  it("does not confuse lifecycle logs, provider startup, and an active turn", () => {
    expect(isChatStopReady([{ eventType: "lifecycle" }, { eventType: "run.performance.span" }], "active")).toBe(false);
    const startup = [{ eventType: "native.process_start_requested" }];
    expect(isChatStopReady(startup, "startup")).toBe(true);
    expect(isChatStopReady(startup, "active")).toBe(false);
    const active = [...startup, { eventType: "turn.started" }];
    expect(isChatStopReady(active, "startup")).toBe(false);
    expect(isChatStopReady(active, "active")).toBe(true);
  });

  it("requires one committed comment, one task, and one consuming run after request replay", () => {
    const valid = { commentId: "comment", clientRequestId: "request", comments: [{ id: "comment", body: "create", clientRequestId: "request" }], taskId: "task",
      tasks: [{ ...task, status: "backlog" }], chatId: "chat", runs: [{ ...run, contextSnapshot: { issueId: "chat", wakeCommentId: "comment" } }] };
    expect(() => assertCommittedSendRetry(valid)).not.toThrow();
    expect(() => assertCommittedSendRetry({ ...valid, comments: [...valid.comments, { ...valid.comments[0]!, id: "duplicate" }] })).toThrow();
    expect(() => assertCommittedSendRetry({ ...valid, tasks: [...valid.tasks, { ...task, id: "duplicate" }] })).toThrow();
    expect(() => assertCommittedSendRetry({ ...valid, runs: [...valid.runs, run] })).toThrow();
    expect(() => assertCommittedSendRetry({ ...valid, runs: [...valid.runs, { ...valid.runs[0]!, id: "duplicate" }] })).toThrow();
    expect(() => assertCommittedSendRetry({ ...valid, runs: [] })).toThrow();
  });

  it("keeps the paid hardening matrix explicit and limits API-tool opt-in to coordination", () => {
    const cells = runnerMatrix.filter(cell => cell.suite.id === "agent-chat-hardening");
    expect(cells).toHaveLength(18);
    expect(cells.every(cell => cell.suite.manualOnly && cell.profile.generation === "native")).toBe(true);
    expect(cells.filter(cell => cell.environment.id === "daytona")).toHaveLength(6);
    for (const cell of cells) {
      expect(buildRunnerE2EProcessEnvironment({}, [cell]).PAPERCLIP_RUNNER_API_TOOLS_ENABLED).toBe(
        ["hire-delegate-reuse", "blocked-status-review"].includes(cell.task.id) ? "true" : undefined);
      const config = cell.profile.buildAgent({ executionId: "fixture", workspacePath: "/workspace", environmentId: "local",
        environmentFixtureId: "local", secretRefs: { [cell.profile.credential]: { type: "secret_ref", secretId: "secret", version: "latest" } } });
      expect(config.role).toBe("ceo");
      expect(JSON.stringify(config.instructionsBundle)).not.toMatch(/mark the task done|paperclip_finish|POST \/api|PUT \/api/);
      expect(config.adapterConfig).not.toHaveProperty("codexPermissionMode");
      expect(config.adapterConfig).not.toHaveProperty("acpxPermissionMode");
    }
  });
});
