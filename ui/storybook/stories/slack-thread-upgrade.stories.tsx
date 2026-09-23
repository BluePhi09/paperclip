import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { SlackThreadUpgradeNotice } from "@/components/chat/ExternallyConnectedTaskBanner";

const meta = {
  title: "Connections/Slack threaded DM upgrade",
  component: SlackThreadUpgradeNotice,
  parameters: { layout: "padded" },
  args: { onUpgrade: fn() },
} satisfies Meta<typeof SlackThreadUpgradeNotice>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Ready: Story = {
  play: async ({ canvasElement, args }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Enable threaded DMs" }));
    await expect(args.onUpgrade).toHaveBeenCalledOnce();
  },
};
export const Opening: Story = { args: { pending: true } };
export const Failed: Story = { args: { error: "Slack upgrade expired or changed. Start the upgrade again." } };
