import { useMemo } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SlackReplyComposer } from "@/components/chat/SlackReplyComposer";
import { queryKeys } from "@/lib/queryKeys";

function ReadOnlyFixture() {
  const client = useMemo(() => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false, enabled: false } } });
    client.setQueryData(queryKeys.auth.session, null);
    return client;
  }, []);
  return <QueryClientProvider client={client}><div className="mx-auto max-w-xl p-6">
    <p className="mb-3 text-sm text-muted-foreground">Display-only fixture. Open Reply via Slack to inspect consent copy; sending is disabled without a signed-in user.</p>
    <SlackReplyComposer companyId="story" issueId="story" endpointId="story" conversationId="story" />
  </div></QueryClientProvider>;
}
export default { title: "Connections/Slack/Explicit reply", component: ReadOnlyFixture } satisfies Meta<typeof ReadOnlyFixture>;
export const PrivateByDefault: StoryObj<typeof ReadOnlyFixture> = {};
