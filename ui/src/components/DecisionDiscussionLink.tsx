import type { Agent, AttentionItem } from "@paperclipai/shared";
import { useState } from "react";
import { useCompany } from "../context/CompanyContext";
import { useAgentChatEnabled } from "../hooks/useAgentChatEnabled";
import { decisionChatTarget, nativeChatDraftNavigation } from "../lib/decision-chat";
import { Link, useNavigate } from "../lib/router";
import { Button } from "./ui/button";

export function DecisionDiscussionLink({ item, companyId, agents, userId }: {
  item: AttentionItem; companyId: string; agents: readonly Agent[]; userId: string | null;
}) {
  const { selectedCompanyId } = useCompany();
  const { enabled, loaded } = useAgentChatEnabled();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const sameCompany = selectedCompanyId === companyId && item.companyId === companyId &&
    item.subject.companyId === companyId && (!item.relatedIssue || item.relatedIssue.companyId === companyId);
  const target = decisionChatTarget(item, companyId, agents);
  const reason = !sameCompany ? "Switch to this decision's company to discuss it."
    : !loaded ? "Checking chat availability…"
    : !enabled ? "Agent Chat is turned off. The linked task is still available."
    : target.reason;
  return <div className="space-y-2 text-xs">
    {reason ? <p role="status" className="text-muted-foreground">{reason}</p> : <>
      <Button type="button" variant="outline" size="sm" onClick={() => {
        try {
          if (!sameCompany || !target.agent) return;
          const destination = nativeChatDraftNavigation(item, target.agent, companyId, userId);
          navigate(destination.to, { state: destination.state });
        } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not open the chat."); }
      }}>Discuss with {target.agent?.name}</Button>
      <p className="text-muted-foreground">{item.audience === "agent" ? "Opens a chat with the assigned expert reviewer." : "Opens a chat with the agent who asked."} Nothing is sent or decided.</p>
    </>}
    {sameCompany && item.relatedIssue && <Link disableIssueQuicklook to={`/issues/${encodeURIComponent(item.relatedIssue.id)}`} className="underline">Open linked task</Link>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
  </div>;
}
