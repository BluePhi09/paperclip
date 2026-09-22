import type { Meta, StoryObj } from "@storybook/react-vite";
import { SlackOAuthConsent } from "../../src/pages/apps/chat/SlackOAuthConnectStep";

const meta = {
  title: "Connections/Slack/CEO pilot OAuth",
  component: SlackOAuthConsent,
  parameters: { docs: { description: { component: "Production consent component, with display-only fixture data. Buttons do not connect to Slack in Storybook. This is not live OAuth acceptance evidence." } } },
  args: {
    endpoint: { assignedAgentName: "CEO", setup: { step: "provider_setup", slackOAuth: {
      enabled: true, configured: true, profile: "ceo-dm-v1", missing: [],
      callbackUrl: "https://pilot.example/api/chat-endpoints/example/slack/oauth/callback",
      scopes: ["chat:write", "commands", "im:history", "im:read", "users:read"],
    } } },
    onConnect: () => undefined, onExit: () => undefined,
  },
  decorators: [(Story) => <div className="mx-auto max-w-xl p-6"><Story /></div>],
} satisfies Meta<typeof SlackOAuthConsent>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Ready: Story = {};
export const Prerequisites: Story = { args: { endpoint: { assignedAgentName: "CEO", setup: { step: "provider_setup", slackOAuth: { ...meta.args.endpoint.setup.slackOAuth, configured: false, callbackUrl: null, missing: ["PAPERCLIP_PUBLIC_URL (HTTPS)", "PAPERCLIP_SLACK_CEO_POC_CLIENT_ID"] } } } } };
export const Opening: Story = { args: { pending: true } };
export const Retry: Story = { args: { failed: true } };
