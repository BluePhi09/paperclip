import { userEvent, within } from "storybook/test";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { JevTaskComposer } from "../prototypes/jev-task-creation/JevTaskComposer";

const PROMPTS = {
  bug: "The login page redirects back to itself after the session expires. Users get stuck in a loop and can't sign in until they clear cookies.",
  feature: "Add a CSV export to the issues list so the board can pull tasks into a spreadsheet for the weekly review.",
  research: "Should we move heartbeat scheduling onto a queue? How would that change wake latency for agents?",
  design: "The new task dialog feels cramped on mobile. The spacing and typography around the property chips need a design pass.",
  qa: "Before Friday's release, run the smoke tests and verify that invite links still work on authenticated private mode.",
  ambiguous: "The invite emails look wrong, can you sort it out",
  planning: "Plan the migration of agent runtime sessions to the new adapter, in phases, so nothing breaks mid-run.",
  // A real, messy prompt: a pasted link first, reading steps before the deliverable, and two phases.
  messy:
    "https://example.slack.com/archives/C0000000000/p0000000000000000\nRead this Slack thread and review the Meta Muse AI URL. Review the page contents and create a plan to create a page like that, but catered towards the Paperclips connector audience. And then build a plan to use Dota's Paperclip instance to build the new skill based on the new runbook, connector runbook that Dota shared the link to the PR to. And then phase two is to build the website as well.",
};

const meta = {
  title: "UX Labs/Task creation with Jev",
  component: JevTaskComposer,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Prototype: prompt-first task creation. You write what you need. Jev (`typesafe/jev-1.13`, TypeSafe's decision model on OpenRouter) answers " +
          "`choice` questions for the task's mode, which is its type (Auto, Plan, or Ask), plus its assignee, each with a confidence and per-option probabilities. Mode and owner update live as you type; project is a manual choice. Jev doesn't generate text, so a separate small text model drafts the title once, when the task is started with Start task or Enter, like Claude Code naming a session. " +
          "Suggested values carry a sparkle. Anything you change is yours and is never overwritten; the undo icon restores the suggestion. " +
          "Below the confidence threshold the task goes to the org's first active agent that reports to the board (else its first active agent), and Jev's best guesses appear as one-click buttons. **Instant** stories create first; the title and routing arrive a moment later. " +
          "Jev's answers are simulated locally in the documented response shape (`prototypes/jev-task-creation/jev-classifier.ts`); **How sure Jev is → Request sent to Jev** shows the real request body. No API is called and no task is persisted.",
      },
    },
  },
  args: { flow: "suggest-first", latencyMs: 350, titleLatencyMs: 1200 },
  argTypes: {
    flow: { control: "inline-radio", options: ["suggest-first", "instant"] },
    latencyMs: { name: "Jev latency (ms)", control: { type: "range", min: 100, max: 4000, step: 50 } },
    titleLatencyMs: { name: "Title model latency (ms)", control: { type: "range", min: 100, max: 6000, step: 100 } },
    liveDebounceMs: { name: "Re-route after typing pause (ms)", control: { type: "range", min: 0, max: 1500, step: 50 } },
  },
  render: (args) => <JevTaskComposer key={JSON.stringify(args)} {...args} />,
} satisfies Meta<typeof JevTaskComposer>;
export default meta;
type Story = StoryObj<typeof meta>;

export const StartHere: Story = { name: "01 · Start here · Empty composer" };
export const WatchItSuggest: Story = {
  name: "02 · Watch Jev suggest while you type",
  args: { initialPrompt: PROMPTS.bug, typeOnMount: true },
};
export const Bug: Story = { name: "03 · Login bug → Auto mode, CodexCoder", args: { initialPrompt: PROMPTS.bug } };
export const Feature: Story = { name: "04 · CSV export → Auto mode, CodexCoder", args: { initialPrompt: PROMPTS.feature } };
export const Research: Story = { name: "05 · Question → Ask mode, CTO", args: { initialPrompt: PROMPTS.research } };
export const Design: Story = { name: "06 · Spacing pass → Auto mode, DesignSystemCoder", args: { initialPrompt: PROMPTS.design } };
export const QA: Story = { name: "07 · Release checks → Auto mode, QAChecker", args: { initialPrompt: PROMPTS.qa } };
export const LargeScope: Story = { name: "08 · Phased migration → Plan mode, CodexCoder", args: { initialPrompt: PROMPTS.planning } };
export const LowConfidence: Story = {
  name: "09 · Unsure · Goes to the agent reporting to the board",
  args: { initialPrompt: PROMPTS.ambiguous },
};
export const LowConfidenceBoardAgentPaused: Story = {
  name: "09b · Unsure, CTO paused · Next board-reporting agent",
  args: { initialPrompt: PROMPTS.ambiguous, pausedAgentIds: ["agent-cto"] },
};
export const UserOverride: Story = {
  name: "10 · You chose the assignee · Jev keeps it",
  args: { initialPrompt: PROMPTS.bug, presetAssigneeId: "agent-qa" },
};
export const Confidence: Story = {
  name: "11 · How sure Jev is",
  args: { initialPrompt: PROMPTS.research },
  play: async ({ canvasElement }) => {
    const toggle = await within(canvasElement.ownerDocument.body).findByRole("button", { name: /how sure Jev is/i }, { timeout: 4000 });
    await userEvent.click(toggle);
  },
};
export const AssigneeProbabilities: Story = {
  name: "11b · Assignee menu shows Jev's probabilities",
  args: { initialPrompt: PROMPTS.ambiguous },
  play: async ({ canvasElement }) => {
    const chip = await within(canvasElement.ownerDocument.body).findByRole("button", { name: /^Owner/ }, { timeout: 4000 });
    await userEvent.click(chip);
  },
};
export const ModeProbabilities: Story = {
  name: "11c · Mode menu shows Jev's probabilities",
  args: { initialPrompt: PROMPTS.planning },
  play: async ({ canvasElement }) => {
    const chip = await within(canvasElement.ownerDocument.body).findByRole("button", { name: /^Mode/ }, { timeout: 4000 });
    await userEvent.click(chip);
  },
};
export const InstantLiveTyping: Story = {
  name: "12a · Instant · Suggestions update live as you type",
  args: { flow: "instant", initialPrompt: PROMPTS.bug, typeOnMount: true },
};
export const InstantEnterToStart: Story = {
  name: "12b · Instant · Enter starts the task, then the title is written",
  args: { flow: "instant", initialPrompt: PROMPTS.feature, titleLatencyMs: 1600 },
  play: async ({ canvasElement }) => {
    const box = await within(canvasElement.ownerDocument.body).findByRole("textbox", { name: "Describe the task" });
    await new Promise((resolve) => setTimeout(resolve, 900));
    await userEvent.type(box, "{Enter}");
  },
};
export const MessyRealPrompt: Story = {
  name: "12c · Messy real prompt · Link first, reading steps, two phases",
  args: { flow: "instant", initialPrompt: PROMPTS.messy },
  play: async ({ canvasElement }) => {
    const box = await within(canvasElement.ownerDocument.body).findByRole("textbox", { name: "Describe the task" });
    await new Promise((resolve) => setTimeout(resolve, 900));
    await userEvent.type(box, "{Enter}");
  },
};
export const InstantEmpty: Story = {
  name: "12 · Instant · Start first, name and route after",
  args: { flow: "instant" },
};
export const InstantCreated: Story = {
  name: "13 · Instant · Title and owner arrive",
  args: { flow: "instant", initialPrompt: PROMPTS.feature, latencyMs: 700, titleLatencyMs: 2200 },
  play: async ({ canvasElement }) => {
    await userEvent.click(await within(canvasElement.ownerDocument.body).findByRole("button", { name: /Start task/ }));
  },
};
export const JevUnavailable: Story = {
  name: "14 · Jev unavailable · Title still arrives, routing is manual",
  args: { initialPrompt: PROMPTS.bug, jevUnavailable: true },
};
export const SlowJev: Story = {
  name: "15 · Slow Jev · Loading state",
  args: { initialPrompt: PROMPTS.design, latencyMs: 60000, titleLatencyMs: 60000 },
};
export const Light: Story = { name: "16 · Light theme", args: { initialPrompt: PROMPTS.bug }, globals: { theme: "light" } };
export const Mobile: Story = {
  name: "17 · Mobile",
  args: { initialPrompt: PROMPTS.design },
  globals: { viewport: { value: "mobile1", isRotated: false } },
};
