import { describe, expect, it } from "vitest";
import { createAcpxChatProgress } from "./chat-progress.js";

describe("ACPX coarse chat progress", () => {
  it("emits only a closed tool signal and coalesces token-by-token updates", () => {
    let time = 0;
    const project = createAcpxChatProgress(() => time);
    for (const type of ["text_delta", "status", "error", "done", "private command"]) expect(project(type)).toBeNull();
    expect(project("tool_call")).toEqual({ eventType: "chat.progress.using_tools", stream: "system", level: "info" });
    for (let i = 0; i < 100; i++) expect(project("tool_call")).toBeNull();
    time = 20_000;
    expect(project("tool_call")).not.toBeNull();
    expect(createAcpxChatProgress(() => time)("tool_call")).not.toBeNull();
  });
});
