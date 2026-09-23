import { CONNECTION_REQUEST_TOOL_DESCRIPTION, CONNECTIONS_SEARCH_TOOL_DESCRIPTION } from "@paperclipai/shared";

export const RUNTIME_CONNECTION_TOOL_DEFINITIONS = [
  {
    name: "ensure_capability",
    description: "Resolve a supported external read capability for this task. For the Slack public-channel pilot use slack.read_channel or slack.read_thread. CONNECTED means use the returned governed tools. AUTH_REQUIRED means the real connection card exists: yield, keep the task active, and wait for automatic continuation without requesting again. UNAVAILABLE means explain the prerequisite; never ask for tokens or broaden permissions. Discovery is read-only; suggest at most three source-linked fixes with uncertainty, never implement them.",
    inputSchema: {
      type: "object",
      properties: {
        capability: { type: "string", enum: ["slack.read_channel", "slack.read_thread", "slack.search_messages"] },
        reason: { type: "string", maxLength: 500 },
      },
      required: ["capability"], additionalProperties: false,
    },
  },
  {
    name: "connections_search",
    description: CONNECTIONS_SEARCH_TOOL_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "connection_request",
    description: CONNECTION_REQUEST_TOOL_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: { service: { type: "string" } },
      required: ["service"],
      additionalProperties: false,
    },
  },
] as const;
