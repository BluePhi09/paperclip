// @vitest-environment jsdom
import { act, type AnchorHTMLAttributes } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AttentionItem } from "@paperclipai/shared";
import { ThemeProvider } from "../context/ThemeContext";
import { TooltipProvider } from "../components/ui/tooltip";
import { pendingRequestConfirmationInteraction } from "../fixtures/issueThreadInteractionFixtures";
const mocks = vi.hoisted(() => ({ list: vi.fn(), interactions: vi.fn(), accept: vi.fn(), breadcrumbs: vi.fn(), toast: vi.fn() }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "c1" }), useOptionalCompany: () => null }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: mocks.breadcrumbs }) }));
vi.mock("../context/ToastContext", () => ({ useToastActions: () => ({ pushToast: mocks.toast }) }));
vi.mock("../hooks/useInboxBadge", () => ({ useInboxDismissals: () => ({ dismiss: vi.fn(), snooze: vi.fn(), restore: vi.fn() }) }));
vi.mock("@/lib/router", () => ({ useParams: () => ({ key: "plans" }), useSearchParams: () => [new URLSearchParams(), vi.fn()], useNavigate: () => vi.fn(), Link: ({ children, to, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => <a href={to} {...props}>{children}</a> }));
vi.mock("../api/attention", () => ({ attentionApi: { list: mocks.list } }));
vi.mock("../api/issues", () => ({ issuesApi: { listInteractions: mocks.interactions, acceptInteraction: mocks.accept } }));
vi.mock("../api/agents", () => ({ agentsApi: { list: async () => [] } }));
vi.mock("../api/auth", () => ({ authApi: { getSession: async () => null } }));
vi.mock("../api/decisionQueues", () => ({ decisionQueuesApi: { list: async () => [{ id: "q1", key: "plans", title: "Plans", seedRules: [] }] } }));
vi.mock("../components/DecisionQueueRail", () => ({ DecisionQueueRail: () => null }));
import { WhatNeedsMe } from "./WhatNeedsMe";
import { DecisionQueuePage } from "./DecisionQueuePage";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); root = null; host = null; vi.clearAllMocks(); localStorage.clear(); });
describe("Decisions brief disclosure on real pages", () => {
  for (const [name, Page] of [["desk", WhatNeedsMe], ["queue", DecisionQueuePage]] as const) {
    it.each(["personal_fact", "expert_review", "human_risk_decision", "future"] as const)(`${name} opens %s before compact/keyboard-generated Accept`, async (kind) => {
      const brief = { version: kind === "future" ? 2 : 1, decisionClass: kind === "future" ? "expert_review" : kind, subject: "Exact bounded subject", resolverTarget: { type: "human", reason: "Board knowledge" }, evidenceRefs: [{ source: "Plan", revision: "1" }], selectionConsequences: [{ optionId: "accept", consequence: "Record bounded choice" }, { optionId: "reject", consequence: "Leave unchanged" }], safeDefault: "Remain pending", ...(kind === "human_risk_decision" ? { purpose: "execution_authorization", reason: "Needed", scope: "One change", excludedScope: "Other changes", risks: "Rollback", preconditions: [], recommendationOptionId: "accept", recommendationReason: "Bounded" } : {}) };
      const interaction = { ...pendingRequestConfirmationInteraction, id: "interaction-1", issueId: "issue-1", payload: { ...pendingRequestConfirmationInteraction.payload, prompt: "Original explanation", acceptLabel: "Confirm", brief } } as typeof pendingRequestConfirmationInteraction;
      const now = new Date().toISOString();
      const item = { id: "a1", companyId: "c1", sourceKind: "issue_thread_interaction", audience: "human", subject: { kind: "interaction", id: interaction.id, companyId: "c1", title: "Review", identifier: null, status: "pending", href: "/PAP/issues/issue-1", metadata: { kind: "request_confirmation", issueId: interaction.issueId, requiresDetailReview: true } }, decisionVerbs: [{ id: "accept", label: "Confirm", description: null }], inlineResolvable: true, severity: "medium", rank: 0, activityAt: now, createdAt: now, updatedAt: now, dedupKey: "interaction:interaction-1", dismissalKey: "attention:interaction:interaction-1", whyNow: "Pending", entryRule: "Pending", exitRule: "Resolved", relatedIssue: null, project: null, workspace: null, detail: null, dismissal: null, queues: [], shelf: false, retentionDays: 30, keep: false, retentionVersion: 1 } as AttentionItem;
      mocks.list.mockResolvedValue({ items: [item], generatedAt: now, totalCount: 1 });
      mocks.interactions.mockResolvedValue([interaction]);
      mocks.accept.mockResolvedValue({ ...interaction, status: "accepted" });
      host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
      const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
      await act(async () => root?.render(<QueryClientProvider client={client}><ThemeProvider><TooltipProvider><Page /></TooltipProvider></ThemeProvider></QueryClientProvider>));
      await vi.waitFor(() => expect(host?.textContent).toContain("Review"));
      // The desk auto-opens its first decision. Collapse it to exercise the bypass.
      if (name === "desk") {
        await vi.waitFor(() => expect(host?.textContent).toContain(kind === "future" ? "invalid or unsupported version" : brief.subject));
        const less = Array.from(host!.querySelectorAll("button")).find((button) => button.textContent?.includes("See less"));
        expect(less).toBeDefined(); await act(async () => less?.click());
        await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
        expect(mocks.accept).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(host?.textContent).toContain(kind === "future" ? "invalid or unsupported version" : brief.subject));
        await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
      }
      const compact = Array.from(host!.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Confirm");
      expect(compact).toBeDefined();
      await act(async () => compact?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 })));
      expect(mocks.accept).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(host?.textContent).toContain(kind === "future" ? "invalid or unsupported version" : brief.subject));
      const explanation = kind === "future" ? host!.querySelector('[role="status"]') : host!.querySelector('[aria-label="Decision brief"]');
      const native = Array.from(host!.querySelectorAll('[data-decision-disclosure] button')).find((button) => button.textContent?.trim() === "Confirm");
      expect(native).toBeDefined(); expect(explanation!.compareDocumentPosition(native!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      await act(async () => native?.click());
      await vi.waitFor(() => expect(mocks.accept).toHaveBeenCalledWith("issue-1", "interaction-1", expect.any(Object)));
    });
  }
});
