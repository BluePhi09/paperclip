import { describe, expect, it } from "vitest";

import {
  collectUntilTerminal,
  makeDriver,
  FakeCodexTransport,
  WORKSPACE,
} from "./codex-app-server-driver.test-support.js";

describe("prepared native context transport", () => {
  it("sends prepared initial and completion-only input without a task envelope", async () => {
    const transport = new FakeCodexTransport();
    const driver = makeDriver([transport], {
      conversationMode: "prepared",
    } as Record<string, unknown>);
    const session = await driver.openSession({
      runId: "run-prepared",
      normalizedSessionId: "prepared",
      workingDirectory: WORKSPACE,
    });

    const first = await session.startTurn({
      message: { role: "user", text: "prepared initial wake" },
    });
    transport.push("turn/started", {
      threadId: "thread-1",
      turn: { id: first.turnId, status: "inProgress" },
    });
    transport.push("turn/completed", {
      threadId: "thread-1",
      turn: { id: first.turnId, status: "completed", items: [] },
    });
    await collectUntilTerminal(session.events());

    const starts = transport.calls
      .filter((call) => call.method === "turn/start")
      .map((call) => call.params.input);
    expect(starts).toEqual([
      [{ type: "text", text: "prepared initial wake", text_elements: [] }],
    ]);
    expect(JSON.stringify(starts)).not.toContain('"task"');
  });

  it("keeps standalone task turns wrapped", async () => {
    const transport = new FakeCodexTransport();
    const driver = makeDriver([transport]);
    const session = await driver.openSession({
      runId: "run-task",
      normalizedSessionId: "task",
      workingDirectory: WORKSPACE,
    });
    await session.startTurn({
      message: { role: "user", text: "ordinary standalone task" },
    });

    const input = transport.calls.find((call) => call.method === "turn/start")
      ?.params.input;
    expect(input).toEqual([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining('"task"'),
      }),
    ]);
    expect((input?.[0] as { text: string }).text).toContain(
      '"message":"ordinary standalone task"',
    );
  });
});
