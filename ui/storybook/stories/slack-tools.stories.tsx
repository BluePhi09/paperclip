import type { Meta, StoryObj } from "@storybook/react-vite";
import type { SlackSearchStatus } from "@paperclipai/shared";
import { SlackSearchView } from "../../src/pages/apps/chat/SlackToolSettings";
const base: SlackSearchStatus = {
  canConfigure: true,
  configured: false,
  connected: false,
  clientId: null,
  redirectUri: "https://paperclip.example/api/slack/search/callback",
  nativeSearchAvailable: false,
  limitation:
    "This runtime uses bounded channel history search. Native search requires transient result delivery.",
};
function Preview({ connected = false, configured = false }) {
  return (
    <main className="max-w-3xl p-6 space-y-7">
      <h2 className="text-lg font-semibold">Access</h2>
      <SlackSearchView
        status={{ ...base, configured, connected }}
        onConnect={async () => {}}
        onDisconnect={async () => {}}
        onConfigure={async () => {}}
      />
    </main>
  );
}
export default {
  title: "Connections/Slack/Task tools",
  component: Preview,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof Preview>;
type Story = StoryObj<typeof Preview>;
export const ConfigureSearch: Story = {};
export const ConnectSearch: Story = {
  args: { configured: true },
};
export const SearchConnected: Story = {
  args: { configured: true, connected: true },
};
