import type { AdapterRuntimeEvent } from "../types.js";

/** Only a closed activity label enters the local run-event table. Never accept
 * a tool title, command, argument, output, or thought delta as display text. */
export function createAcpxChatProgress(now: () => number = Date.now) {
  let lastToolEventAt = -Infinity;
  return (eventType: string): AdapterRuntimeEvent | null => {
    if (eventType !== "tool_call" || now() - lastToolEventAt < 20_000) return null;
    lastToolEventAt = now();
    return { eventType: "chat.progress.using_tools", stream: "system", level: "info" };
  };
}
