// Structural snapshot of Slack's live tools/list, reviewed 2026-09-22.
// Descriptions omitted. The thread root is message_ts, not Web API's ts.
export const readChannelSchema = {
  type: "object",
  required: ["channel_id"],
  properties: {
    channel_id: { type: "string" }, limit: { type: "integer" },
    cursor: { type: "string" }, oldest: { type: "string" },
    latest: { type: "string" }, response_format: { type: "string" },
  },
};

export const readThreadSchema = {
  type: "object",
  required: ["channel_id", "message_ts"],
  properties: { ...readChannelSchema.properties, message_ts: { type: "string" } },
};
