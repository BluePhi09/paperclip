import type { Adapter } from "chat";

export type SlackDmThreadActivation = { version: 2; since: string };

function timestampMicros(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^\d{1,12}\.\d{1,6}$/.test(value)) return null;
  const [seconds, fraction] = value.split(".");
  return BigInt(seconds!) * 1_000_000n + BigInt(fraction!.padEnd(6, "0"));
}

/** Persisted once at explicit upgrade, not recomputed at process startup. */
export function slackDmThreadActivation(setup: { slackDmThreading?: unknown }): SlackDmThreadActivation | null {
  if (setup.slackDmThreading === undefined) return null;
  const value = setup.slackDmThreading as Partial<SlackDmThreadActivation> | null;
  if (!value || value.version !== 2 || timestampMicros(value.since) === null) {
    throw new Error("Invalid Slack DM threading activation");
  }
  return { version: 2, since: value.since! };
}

export function slackDmThreadRoot(threadId: string, channelId: string): string | null {
  const match = /^slack:(D[A-Z0-9]+):(\d{1,12}\.\d{1,6})$/.exec(threadId);
  return match?.[1] === channelId ? match[2]! : null;
}

export function slackDmBindingReceipt(binding: {
  bindingMode: string; externalConversationId: string; externalThreadId: string;
  originPrincipalId: string | null; originUserId: string | null;
}): string | undefined {
  return binding.bindingMode === "legacy" ? undefined : JSON.stringify([
    binding.bindingMode, binding.externalConversationId, binding.externalThreadId, binding.originPrincipalId, binding.originUserId,
  ]);
}

/** Admission must agree with the adapter before an issue can be created. */
export function slackDmBindingMode(activation: SlackDmThreadActivation | null, input: {
  threadId: string; channelId: string; messageId: string;
}): "legacy" | "slack_dm_thread_v2" {
  if (!activation) return "legacy";
  const root = slackDmThreadRoot(input.threadId, input.channelId);
  const messageMicros = timestampMicros(input.messageId);
  const sinceMicros = timestampMicros(activation.since)!;
  if (root) {
    const rootMicros = timestampMicros(root)!;
    if (messageMicros === null || messageMicros < rootMicros) throw new Error("Invalid Slack DM thread chronology");
    return rootMicros >= sinceMicros ? "slack_dm_thread_v2" : "legacy";
  }
  if (input.threadId === `slack:${input.channelId}:` && messageMicros !== null && messageMicros < sinceMicros) return "legacy";
  throw new Error("Slack DM message does not match the activated thread boundary");
}

/** A source link or matching issue ID never grants another person this thread. */
export function slackDmBindingOwnedBy(binding: {
  bindingMode: string; companyId: string; endpointId: string; isDirectMessage: boolean;
  externalConversationId: string; externalThreadId: string; sessionGeneration: number;
  originPrincipalId: string | null; originUserId: string | null;
}, actor: { companyId: string; endpointId: string; principalId: string; userId: string | null }): boolean {
  if (binding.companyId !== actor.companyId || binding.endpointId !== actor.endpointId) return false;
  if (binding.bindingMode === "legacy") return true;
  return binding.bindingMode === "slack_dm_thread_v2" && binding.isDirectMessage && binding.sessionGeneration === 1 &&
    binding.originPrincipalId === actor.principalId && actor.userId !== null && binding.originUserId === actor.userId &&
    slackDmThreadRoot(binding.externalThreadId, binding.externalConversationId) !== null;
}

export class SlackDmThreadCompatibilityError extends Error {
  readonly code = "CHAT_ADAPTER_COMPATIBILITY_ERROR";

  constructor() {
    super("The pinned Slack adapter's DM thread identity contract is unavailable");
    this.name = "SlackDmThreadCompatibilityError";
  }
}

type SlackMessageIdentity = {
  channel?: unknown;
  channel_type?: unknown;
  ts?: unknown;
  thread_ts?: unknown;
};

/**
 * Opt-in adapter seam only. Do not select this for legacy flat-DM bindings.
 * The pinned adapter calls this same method for ingress, edits and deletions.
 * Keeping it at that boundary prevents delivery deduplication from flattening
 * independent requests together. This does not grant access or select a task.
 */
export function scopeSlackDmThreads(adapter: Adapter, since = "0.000000"): Adapter {
  const sinceMicros = timestampMicros(since);
  if (sinceMicros === null) throw new Error("Invalid Slack DM threading activation");
  const slack = adapter as unknown as {
    threadIdForMessageEvent?: (event: SlackMessageIdentity) => string;
    encodeThreadId?: (identity: { channel: string; threadTs: string }) => string;
  };
  if (typeof slack.threadIdForMessageEvent !== "function" || typeof slack.encodeThreadId !== "function") {
    throw new SlackDmThreadCompatibilityError();
  }
  const original = slack.threadIdForMessageEvent.bind(adapter);
  const encode = slack.encodeThreadId.bind(adapter);
  slack.threadIdForMessageEvent = (event) => {
    if (event.channel_type !== "im") return original(event);
    const root = event.thread_ts ?? event.ts;
    if (typeof event.channel !== "string" || !/^D[A-Z0-9]+$/.test(event.channel) ||
        typeof root !== "string" || !/^\d{1,12}\.\d{1,6}$/.test(root)) {
      // No fallback to the flat DM: a malformed root must never reach another
      // conversation's task. Preserve provider timestamp precision as text.
      throw new Error("Slack DM message has no valid channel and thread root");
    }
    // A replay of an old top-level DM must retain its old delivery identity.
    // Replies to pre-upgrade roots keep the pinned adapter's legacy behavior.
    if (timestampMicros(root)! < sinceMicros) return original(event);
    return encode({ channel: event.channel, threadTs: root });
  };
  return adapter;
}
