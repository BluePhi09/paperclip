// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import type { Agent, AttentionItem } from "@paperclipai/shared";
import { decisionChatTarget, nativeChatDraftNavigation } from "./decision-chat";
import { loadDraft, saveDraft } from "./composer-draft";

const agent = { id: "agent-1", companyId: "company-1", name: "Planner", status: "idle" } as Agent;
const item: AttentionItem = { id: "interaction:card-1", companyId: "company-1", audience: "human", sourceKind: "issue_thread_interaction",
  subject: { kind: "interaction", identifier: null, status: "pending", href: null, id: "card-1", companyId: "company-1", title: "Expose the media server?", metadata: { createdByAgentId: agent.id, targetRevisionId: "revision-5" } },
  relatedIssue: { kind: "issue", status: "in_progress", title: "Plan media server access", href: null, id: "task-1", companyId: "company-1", identifier: "ACME-12" },
  whyNow: "Human choice required", decisionVerbs: [], inlineResolvable: false, entryRule: "pending", exitRule: "answered",
  dedupKey: "card-1", dismissalKey: "card-1", dismissal: null, severity: "medium", rank: 1,
  activityAt: "2026-10-07T00:00:00Z", createdAt: "2026-10-07T00:00:00Z", updatedAt: "2026-10-07T00:00:00Z",
  project: null, workspace: null, expiresAt: null, ruleKey: null, originAgentName: "Planner", queues: [], shelf: false,
  retentionDays: 30, keep: false, archivedAt: null, retentionVersion: 1, decideBy: null, decideByAttribution: null,
  snoozedUntil: null, detail: null, trainingExampleId: null,
};
const key = "paperclip:agent-chat-draft:company-1:user-1:agent-1";
beforeEach(() => sessionStorage.clear());
describe("decision chat navigation", () => {
  it("uses the human source author, not an assignee or inferred reviewer", () => {
    expect(decisionChatTarget(item, "company-1", [agent]).agent).toBe(agent);
    expect(decisionChatTarget({ ...item, subject: { ...item.subject, metadata: {} } }, "company-1", [agent]).agent).toBeNull();
  });
  it("uses the named expert resolver instead of the source author", () => {
    const expert = { ...agent, id: "expert" };
    expect(decisionChatTarget({ ...item, audience: "agent", resolverAgentId: expert.id }, "company-1", [agent, expert]).agent).toBe(expert);
  });
  it.each(["paused", "terminated", "pending_approval"])("does not offer unavailable %s agents", (status) => {
    expect(decisionChatTarget(item, "company-1", [{ ...agent, status } as Agent]).agent).toBeNull();
  });
  it("rejects foreign cards, subjects, linked tasks and agents", () => {
    expect(decisionChatTarget(item, "other", [agent]).agent).toBeNull();
    expect(decisionChatTarget({ ...item, subject: { ...item.subject, companyId: "other" } }, "company-1", [agent]).agent).toBeNull();
    expect(decisionChatTarget({ ...item, relatedIssue: { ...item.relatedIssue!, companyId: "other" } }, "company-1", [agent]).agent).toBeNull();
    expect(decisionChatTarget(item, "company-1", [{ ...agent, companyId: "other" }]).agent).toBeNull();
  });
  it("prepares only a native tab draft with stable source and revision; repeat navigation is idempotent", () => {
    const first = nativeChatDraftNavigation(item, agent, "company-1", "user-1");
    expect(first.to).toBe("/chats/agent-1");
    expect(loadDraft(key)).toContain("issue_thread_interaction:card-1");
    expect(loadDraft(key)).toContain("task-1");
    expect(loadDraft(key)).toContain("revision-5");
    const saved = loadDraft(key);
    nativeChatDraftNavigation(item, agent, "company-1", "user-1");
    expect(loadDraft(key)).toBe(saved);
  });
  it("preserves another unsent draft and exposes the context separately", () => {
    saveDraft(key, "My unsent question");
    const result = nativeChatDraftNavigation(item, agent, "company-1", "user-1");
    expect(loadDraft(key)).toBe("My unsent question");
    expect(result.state.decisionDiscussion.context).toContain("card-1");
    expect(result.state.decisionDiscussion.draftPrepared).toBe(false);
  });
  it("never writes an anonymous or foreign draft", () => {
    nativeChatDraftNavigation(item, agent, "company-1", null);
    expect(sessionStorage.length).toBe(0);
    expect(() => nativeChatDraftNavigation(item, { ...agent, companyId: "other" }, "company-1", "user-1")).toThrow();
  });
});
