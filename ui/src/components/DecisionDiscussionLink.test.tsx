// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, AttentionItem } from "@paperclipai/shared";
import { DecisionDiscussionLink } from "./DecisionDiscussionLink";
import { AgentChat } from "../pages/AgentChat";
import { loadDraft } from "../lib/composer-draft";
const state = vi.hoisted(() => ({ enabled: true, company: "company-1", ensure: vi.fn(), get: vi.fn(async () => null), agents: vi.fn(), session: vi.fn(async () => ({ user: { id: "user-1" } })) }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: state.company, selectedCompany: { issuePrefix: "ACME" } }) }));
vi.mock("../hooks/useAgentChatEnabled", () => ({ useAgentChatEnabled: () => ({ enabled: state.enabled, loaded: true }) }));
vi.mock("../api/agentChats", () => ({ agentChatsApi: { get: state.get, ensure: state.ensure } }));
vi.mock("../api/agents", () => ({ agentsApi: { list: state.agents } }));
vi.mock("../api/auth", () => ({ authApi: { getSession: state.session } }));
vi.mock("../pages/IssueDetail", () => ({ TaskDetailSurface: () => <div>Native conversation</div> }));
vi.mock("./IssueLinkQuicklook", () => ({ IssueLinkQuicklook: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a> }));
const agent = { id: "agent-1", companyId: "company-1", name: "Planner", status: "idle" } as Agent;
const item: AttentionItem = { id: "card", companyId: "company-1", audience: "human", sourceKind: "issue_thread_interaction",
  subject: { kind: "interaction", identifier: null, status: "pending", href: null, id: "card-1", companyId: "company-1", title: "Expose the media server?", metadata: { createdByAgentId: agent.id } },
  relatedIssue: { kind: "issue", identifier: null, status: "in_progress", title: "Plan", href: null, id: "task-1", companyId: "company-1" },
  whyNow: "Human response required", decisionVerbs: [], inlineResolvable: false, entryRule: "pending", exitRule: "answered",
  dedupKey: "card", dismissalKey: "card", dismissal: null, severity: "medium", rank: 1,
  activityAt: "2026-10-07T00:00:00Z", createdAt: "2026-10-07T00:00:00Z", updatedAt: "2026-10-07T00:00:00Z",
  project: null, workspace: null, expiresAt: null, ruleKey: null, originAgentName: "Planner", queues: [], shelf: false,
  retentionDays: 30, keep: false, archivedAt: null, retentionVersion: 1, decideBy: null, decideByAttribution: null,
  snoozedUntil: null, detail: null, trainingExampleId: null,
};
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => { state.company = "company-1"; state.enabled = true; state.agents.mockResolvedValue([agent]); vi.clearAllMocks(); sessionStorage.clear(); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
function Controls() { const nav = useNavigate(); const loc = useLocation(); return <><output>{loc.pathname}</output><button onClick={() => nav(-1)}>Back</button><button onClick={() => nav(1)}>Forward</button></>; }
async function render(agents = [agent]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={["/ACME/decisions"]}><Controls /><Routes>
    <Route path="/ACME/decisions" element={<DecisionDiscussionLink item={item} companyId="company-1" agents={agents} userId="user-1" />} />
    <Route path="/ACME/chats/:agentRef" element={<AgentChat />} />
  </Routes></MemoryRouter></QueryClientProvider>));
}
async function click(label: string) { const button = [...host.querySelectorAll("button")].find(b => b.textContent === label); expect(button).toBeTruthy(); await act(async () => { button!.click(); }); }
async function ready() { await vi.waitFor(() => expect(host.textContent).toContain("Native conversation")); }
describe("native decision discussion entry", () => {
  it("navigates company-scoped, exposes stable context and never creates a conversation or sends a request on open/back/forward", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected write/request"));
    try {
      await render();
      const button = [...host.querySelectorAll("button")].find(b => b.textContent === "Discuss with Planner")!;
      button.focus(); expect(document.activeElement).toBe(button);
      await click("Discuss with Planner"); await ready();
      expect(host.querySelector("output")?.textContent).toBe("/ACME/chats/agent-1");
      expect(host.textContent).toContain("issue_thread_interaction:card-1");
      const draft = loadDraft("paperclip:agent-chat-draft:company-1:user-1:agent-1");
      expect(draft).toContain("task-1");
      await click("Back"); await click("Forward"); await ready();
      expect(loadDraft("paperclip:agent-chat-draft:company-1:user-1:agent-1")).toBe(draft);
      expect(state.ensure).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
    } finally { request.mockRestore(); }
  });
  it.each(["disabled", "deleted", "paused", "foreign"])("shows an honest %s fallback without a chat action", async (kind) => {
    if (kind === "disabled") state.enabled = false;
    if (kind === "foreign") state.company = "other";
    await render(kind === "deleted" ? [] : kind === "paused" ? [{ ...agent, status: "paused" }] : [agent]);
    expect(host.textContent).not.toContain("Discuss with Planner");
    expect(host.querySelector('[role="status"]')).not.toBeNull();
    expect(host.querySelector("a") !== null).toBe(kind !== "foreign");
    expect(state.ensure).not.toHaveBeenCalled(); expect(sessionStorage.length).toBe(0);
  });
});
