import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "storybook/test";
import { TaskInternalNotes } from "@/components/chat/TaskInternalNotes";

function NotesPreview() {
  const [client] = useState(() => {
    const result = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false, refetchOnMount: false, refetchOnWindowFocus: false } } });
    result.setQueryData(["human-internal-notes", "company", "person", "task"], {
      pages: [{ notes: [{ id: "note", issueId: "task", authorUserId: "person", body: "Review the proposal with the team before authorizing implementation.", createdAt: "2026-09-23T07:00:00Z" }], nextCursor: null }], pageParams: [null],
    });
    return result;
  });
  return <QueryClientProvider client={client}><div className="flex items-center justify-between gap-3">
    <p className="text-xs text-muted-foreground">Shared with Slack · text only</p>
    <TaskInternalNotes issueId="task" companyId="company" userId="person" />
  </div></QueryClientProvider>;
}
export default { title: "Connections/Slack thread Internal notes", component: NotesPreview, parameters: { layout: "padded" } } satisfies Meta<typeof NotesPreview>;
type Story = StoryObj<typeof NotesPreview>;
export const Closed: Story = {};
export const HumanOnlyNotes: Story = { play: async ({ canvasElement }) => {
  await userEvent.click(within(canvasElement).getByRole("button", { name: "Internal notes" }));
} };
