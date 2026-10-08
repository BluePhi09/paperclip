import type { Agent, AttentionItem } from "@paperclipai/shared";
import { loadDraftIfAvailable, loadDraftSubmission, saveDraft } from "./composer-draft";

/** Source provenance is not assignment or authority. Never infer a contact from a task assignee. */
export function decisionChatTarget(item: AttentionItem, companyId: string, agents: readonly Agent[]) {
  const unavailable = (reason: string) => ({ agent: null, reason });
  if (item.companyId !== companyId || item.subject.companyId !== companyId ||
    (item.relatedIssue && item.relatedIssue.companyId !== companyId)) return unavailable("This decision belongs to another company.");
  const metadata = item.subject.metadata;
  const id = item.audience === "agent" ? item.resolverAgentId
    : item.sourceKind === "decision" ? metadata?.originAgentId
    : item.sourceKind === "issue_thread_interaction" ? metadata?.createdByAgentId : null;
  if (typeof id !== "string") return unavailable("No responsible agent is recorded for this decision. Open the linked task instead.");
  const agent = agents.find((entry) => entry.id === id && entry.companyId === companyId);
  if (!agent) return unavailable("The responsible agent is no longer available. Open the linked task instead.");
  if (!["active", "idle", "running", "error"].includes(agent.status)) return unavailable("The responsible agent is paused or inactive; this link would not start it.");
  return { agent, reason: null };
}

export interface DecisionDiscussion {
  companyId: string;
  agentId: string;
  context: string;
  draftPrepared: boolean;
}

/** User-click only: no API, ensureIssue, send, wake or decision mutation. */
export function nativeChatDraftNavigation(item: AttentionItem, agent: Agent, companyId: string, userId: string | null) {
  const target = decisionChatTarget(item, companyId, [agent]);
  if (!target.agent) throw new Error(target.reason ?? "Agent unavailable");
  const revision = item.subject.metadata?.targetRevisionId;
  const context = [
    `Let's discuss this decision before I answer it (this message approves nothing): ${item.subject.title ?? "Decision"}`,
    `Decision: ${item.sourceKind}:${item.subject.id}`,
    item.relatedIssue ? `Task: ${item.relatedIssue.identifier ?? item.relatedIssue.id} (${item.relatedIssue.id})` : null,
    typeof revision === "string" ? `Bound revision: ${revision}` : null,
  ].filter(Boolean).join("\n");
  let draftPrepared = false;
  if (userId) {
    const key = `paperclip:agent-chat-draft:${companyId}:${userId}:${agent.id}`;
    const existing = loadDraftIfAvailable(key);
    if (existing === "" && !loadDraftSubmission(key)) saveDraft(key, context);
    draftPrepared = loadDraftIfAvailable(key) === context;
  }
  return {
    to: `/chats/${encodeURIComponent(agent.id)}`,
    state: { decisionDiscussion: { companyId, agentId: agent.id, context, draftPrepared } satisfies DecisionDiscussion },
  };
}

/** Router state is untrusted and must never cross a company/agent boundary. No query-string draft import. */
export function readDecisionDiscussion(state: unknown, companyId: string, agentId: string): DecisionDiscussion | null {
  if (!state || typeof state !== "object") return null;
  const value = (state as Record<string, unknown>).decisionDiscussion;
  if (!value || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  if (entry.companyId !== companyId || entry.agentId !== agentId || typeof entry.context !== "string" ||
    entry.context.length > 6000 || typeof entry.draftPrepared !== "boolean") return null;
  return entry as unknown as DecisionDiscussion;
}
