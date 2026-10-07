import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ queries: [] as any[], list: vi.fn() }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: any) => { mocks.queries.push(options); return { data: undefined, isLoading: false }; },
  useMutation: () => ({}), useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "c1" }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("../context/ToastContext", () => ({ useToastActions: () => ({ pushToast: vi.fn() }) }));
vi.mock("../hooks/useInboxBadge", () => ({ useInboxDismissals: () => ({ dismiss: vi.fn(), snooze: vi.fn(), restore: vi.fn() }) }));
vi.mock("@/lib/router", () => ({ useParams: () => ({ key: "plans" }), useSearchParams: () => [new URLSearchParams(), vi.fn()], useNavigate: () => vi.fn(), Link: ({ children }: any) => children }));
vi.mock("../api/attention", () => ({ attentionApi: { list: mocks.list } }));
vi.mock("../components/DecisionQueueRail", () => ({ DecisionQueueRail: () => null }));
import { WhatNeedsMe } from "./WhatNeedsMe";
import { DecisionQueuePage } from "./DecisionQueuePage";
describe("native Decisions audience", () => {
  beforeEach(() => { mocks.queries = []; mocks.list.mockClear(); });
  for (const [name, Page] of [["desk", WhatNeedsMe], ["queue", DecisionQueuePage]] as const) {
    it(`defaults ${name} to a server-filtered human audience with native tabs`, async () => {
      const html = renderToStaticMarkup(<Page />);
      expect(html).toContain('aria-label="Decision audience"');
      expect(html).toContain("Expert votes");
      const query = mocks.queries.find((q) => q.queryKey[0] === "attention");
      expect(query.queryKey).toContain("human");
      await query.queryFn();
      expect(mocks.list).toHaveBeenCalledWith("c1", expect.objectContaining({ audience: "human" }));
    });
  }
});
