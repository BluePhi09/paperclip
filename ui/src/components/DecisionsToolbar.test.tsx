import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DecisionsToolbar } from "./DecisionsToolbar";
import { defaultAttentionFilterState } from "../lib/attention";

describe("Decisions audience controls", () => {
  it("renders native Human, Expert and Unclassified tabs with server-selection state", () => {
    const html = renderToStaticMarkup(<DecisionsToolbar visibleCount={0} filterOptions={{ sourceKinds: [], severities: [], projects: [], workspaces: [] } as any} filters={defaultAttentionFilterState} onFiltersChange={() => {}} groupBy="none" onGroupByChange={() => {}} sortOrder="newest" onSortOrderChange={() => {}} audience="agent" onAudienceChange={() => {}} />);
    expect(html).toContain('role="tablist"');
    expect(html).toContain("My decisions"); expect(html).toContain("Expert votes"); expect(html).toContain("Unclassified");
    expect(html).toMatch(/aria-selected="true"[^>]*>Expert votes/);
  });
});
