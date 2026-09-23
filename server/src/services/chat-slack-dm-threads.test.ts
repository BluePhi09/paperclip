import { describe, expect, it } from "vitest";
import { createSlackAdapter } from "@chat-adapter/slack";
import { scopeSlackDmThreads, slackDmThreadActivation, slackDmBindingMode, slackDmBindingOwnedBy } from "./chat-slack-dm-threads.js";

function adapter(threaded = true, since?: string) {
  const instance = createSlackAdapter({ botToken: "xoxb-fixture", signingSecret: "fixture", mode: "webhook" });
  if (threaded) scopeSlackDmThreads(instance, since);
  return instance as unknown as {
    threadIdForMessageEvent(event: Record<string, unknown>): string;
    decodeThreadId(id: string): { channel: string; threadTs: string };
  };
}

describe("Slack per-message DM thread identity against the pinned adapter", () => {
  it("keeps the existing flat-DM default unchanged", () => {
    expect(adapter(false).threadIdForMessageEvent({ channel: "D123", channel_type: "im", ts: "1790000000.000001" })).toBe("slack:D123:");
  });
  it("separates two roots, preserves precision, and routes follow-ups to the original root", () => {
    const slack = adapter();
    const first = slack.threadIdForMessageEvent({ channel: "D123", channel_type: "im", ts: "1790000000.000001" });
    const second = slack.threadIdForMessageEvent({ channel: "D123", channel_type: "im", ts: "1790000000.000002" });
    expect(first).not.toBe(second);
    expect(first).toBe("slack:D123:1790000000.000001");
    expect(slack.threadIdForMessageEvent({ channel: "D123", channel_type: "im", ts: "1790000001.000003", thread_ts: "1790000000.000001" })).toBe(first);
    expect(slack.decodeThreadId(first)).toEqual({ channel: "D123", threadTs: "1790000000.000001" });
  });
  it("does not cross DM channels or change channel-message routing", () => {
    const slack = adapter();
    const event = { channel_type: "im", ts: "1790000000.000001" };
    expect(slack.threadIdForMessageEvent({ ...event, channel: "D123" })).not.toBe(slack.threadIdForMessageEvent({ ...event, channel: "D456" }));
    const channelEvent = { ...event, channel: "C123", channel_type: "channel" };
    expect(slack.threadIdForMessageEvent(channelEvent)).toBe(adapter(false).threadIdForMessageEvent(channelEvent));
  });
  it.each([undefined, "", "not-a-timestamp", "1790000000", 1790000000.1, "1.2345678", "1.2:other"])("rejects invalid roots rather than falling back to a flat DM: %j", root => {
    expect(() => adapter().threadIdForMessageEvent({ channel: "D123", channel_type: "im", ts: root })).toThrow("valid channel and thread root");
  });
  it.each([undefined, "", "C123", "D123:other"])("rejects invalid DM channels: %j", channel => {
    expect(() => adapter().threadIdForMessageEvent({ channel, channel_type: "im", ts: "1.000001" })).toThrow("valid channel and thread root");
  });
  it("does not silently accept an adapter upgrade that removes the shared lifecycle seam", () => {
    expect(() => scopeSlackDmThreads({} as never)).toThrowError(expect.objectContaining({ code: "CHAT_ADAPTER_COMPATIBILITY_ERROR" }));
  });
  it("keeps old roots/replies and replay identity unchanged across a saved cutoff", () => {
    const slack = adapter(true, "1790000000.000002");
    const legacy = adapter(false);
    for (const event of [
      { channel: "D123", channel_type: "im", ts: "1790000000.000001" },
      { channel: "D123", channel_type: "im", ts: "1790000009.000009", thread_ts: "1790000000.000001" },
    ]) expect(slack.threadIdForMessageEvent(event)).toBe(legacy.threadIdForMessageEvent(event));
    expect(slack.threadIdForMessageEvent({ channel: "D123", channel_type: "im", ts: "1790000000.000002" })).toBe("slack:D123:1790000000.000002");
  });
  it("requires an exact persisted activation and never derives one from the current time", () => {
    expect(slackDmThreadActivation({})).toBeNull();
    expect(slackDmThreadActivation({ slackDmThreading: { version: 2, since: "1790000000.000002" } })).toEqual({ version: 2, since: "1790000000.000002" });
    for (const value of [null, {}, { version: 1, since: "1.1" }, { version: 2, since: "today" }]) {
      expect(() => slackDmThreadActivation({ slackDmThreading: value })).toThrow("Invalid Slack DM threading activation");
    }
  });
  it("rejects a flattened new message, cross-channel root or reply preceding its root", () => {
    const activation = { version: 2 as const, since: "1790000000.000002" };
    const input = { channelId: "D123", threadId: "slack:D123:1790000000.000002", messageId: "1790000000.000002" };
    expect(slackDmBindingMode(activation, input)).toBe("slack_dm_thread_v2");
    expect(slackDmBindingMode(activation, { ...input, threadId: "slack:D123:", messageId: "1790000000.000001" })).toBe("legacy");
    expect(() => slackDmBindingMode(activation, { ...input, threadId: "slack:D123:" })).toThrow();
    expect(() => slackDmBindingMode(activation, { ...input, channelId: "D456" })).toThrow();
    expect(() => slackDmBindingMode(activation, { ...input, messageId: "1790000000.000001" })).toThrow();
  });
  it("binds new threads to the exact company, endpoint and originating person", () => {
    const binding = { bindingMode: "slack_dm_thread_v2", companyId: "company", endpointId: "endpoint", isDirectMessage: true,
      externalConversationId: "D123", externalThreadId: "slack:D123:1790000000.000002", sessionGeneration: 1,
      originPrincipalId: "principal", originUserId: "user" };
    const actor = { companyId: "company", endpointId: "endpoint", principalId: "principal", userId: "user" };
    expect(slackDmBindingOwnedBy(binding, actor)).toBe(true);
    for (const key of ["companyId", "endpointId", "principalId", "userId"] as const) expect(slackDmBindingOwnedBy(binding, { ...actor, [key]: "different" })).toBe(false);
    expect(slackDmBindingOwnedBy({ ...binding, externalConversationId: "D456" }, actor)).toBe(false);
    expect(slackDmBindingOwnedBy({ ...binding, sessionGeneration: 2 }, actor)).toBe(false);
    expect(slackDmBindingOwnedBy({ ...binding, bindingMode: "unknown" }, actor)).toBe(false);
  });
});
