import { describe, expect, it, vi } from "vitest";
import { chatEndpointsApi, type ExternalChannelBindingSummary } from "@/api/chatEndpoints";
import { ApiError } from "@/api/client";
import { CommentSubmissionUnknownError } from "@/lib/comment-submit-result";
import { submitSharedThreadMessage } from "./shared-thread-submit";
vi.mock("@/api/chatEndpoints", () => ({ chatEndpointsApi: { requestSlackReply: vi.fn() } }));
const binding = { provider: "slack", bindingMode: "slack_dm_thread_v2", slackReplyAvailable: true, endpointId: "endpoint", conversationId: "thread" } as ExternalChannelBindingSummary;
describe("normal composer shared-thread submission", () => {
  it("uses the existing durable reply path and preserves the caller's retry identity", async () => {
    const receipt = { requestId: "action", commentId: "comment", status: "queued" } as const;
    vi.mocked(chatEndpointsApi.requestSlackReply).mockResolvedValue(receipt);
    expect(await submitSharedThreadMessage(binding, "hello", "same-id")).toEqual(receipt);
    expect(chatEndpointsApi.requestSlackReply).toHaveBeenLastCalledWith("endpoint", "thread", "hello", "same-id");
  });
  it.each([{}, { bindingMode: "legacy" }, { slackReplyAvailable: false }])("does not fall back to a private comment for an invalid binding", async changes => {
    const invalid = Object.keys(changes).length ? { ...binding, ...changes } : { ...binding, provider: "discord" };
    await expect(submitSharedThreadMessage(invalid as ExternalChannelBindingSummary, "hello", "id")).rejects.toThrow("unavailable");
  });
  it("refuses untransported attachments and absent retry identities", async () => {
    await expect(submitSharedThreadMessage(binding, "hello", "id", ["file"])).rejects.toThrow("text-only");
    await expect(submitSharedThreadMessage(binding, "hello")).rejects.toThrow("send identity");
  });
  it.each([new Error("Lost response"), { requestId: "incomplete" }])("keeps ambiguous receipts distinguishable for the composer retry state", async outcome => {
    if (outcome instanceof Error) vi.mocked(chatEndpointsApi.requestSlackReply).mockRejectedValueOnce(outcome);
    else vi.mocked(chatEndpointsApi.requestSlackReply).mockResolvedValueOnce(outcome as any);
    await expect(submitSharedThreadMessage(binding, "hello", "same-id")).rejects.toBeInstanceOf(CommentSubmissionUnknownError);
  });
  it("keeps definite authorization rejection distinct from lost delivery", async () => {
    const error = new ApiError("No access", 403, {});
    vi.mocked(chatEndpointsApi.requestSlackReply).mockRejectedValueOnce(error);
    await expect(submitSharedThreadMessage(binding, "hello", "id")).rejects.toBe(error);
  });
});
