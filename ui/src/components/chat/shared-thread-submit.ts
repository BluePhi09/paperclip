import { ApiError } from "@/api/client";
import { chatEndpointsApi, type ExternalChannelBindingSummary } from "@/api/chatEndpoints";
import { CommentSubmissionUnknownError } from "@/lib/comment-submit-result";

export async function submitSharedThreadMessage(binding: ExternalChannelBindingSummary, body: string, clientRequestId?: string, attachmentIds?: string[]) {
  if (binding.provider !== "slack" || binding.bindingMode !== "slack_dm_thread_v2" || !binding.slackReplyAvailable) throw new Error("The Slack thread is unavailable. Check its connection before sending.");
  if (!clientRequestId) throw new Error("Reload this task to create a safe send identity.");
  if (attachmentIds?.length || /!?\[[^\]]*\]\([^)]*\/api\/[^)]*\)/.test(body)) throw new Error("Shared Slack requests are text-only for now. Remove task-file attachments before sending.");
  if (!body.trim() || body.length > 8000) throw new Error("Send between 1 and 8,000 characters.");
  try {
    const receipt = await chatEndpointsApi.requestSlackReply(binding.endpointId, binding.conversationId, body, clientRequestId);
    if (!receipt?.requestId || !receipt.commentId || !["queued", "submitted", "failed"].includes(receipt.status)) throw new CommentSubmissionUnknownError();
    return receipt;
  } catch (error) {
    if (error instanceof ApiError && error.status < 500) throw error;
    throw new CommentSubmissionUnknownError();
  }
}
