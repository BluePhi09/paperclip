# Task creation with Jev

Open **UX Labs → Task creation with Jev** in Storybook:

```sh
pnpm --filter @paperclipai/ui exec storybook dev --port 6010 --host 127.0.0.1 --no-open -c storybook/.storybook
```

## The idea

Today's `NewIssueDialog` asks for a title first, then a description, then
assignee, project, and mode. This prototype starts from the prompt instead. You
describe the work and Jev fills in the rest, the way Claude Code names a session
after you start it.

- **Title** appears in the header breadcrumb (`PAP › Fix login redirect loop…`)
  and types in when Jev suggests it. Click it to edit.
- **Type** (Bug, Feature, Research, Design, QA, Ops), **assignee**, **project**,
  and **work mode** appear as chips under the prompt.
- Jev's values carry a sparkle. When you change a value, the sparkle goes away
  and Jev stops changing it. The undo icon next to a chip restores Jev's value.
- **Why Jev chose these** explains each decision in one line.
- When Jev isn't sure who should own the task, it names alternates as one-click
  buttons.
- Large scope (plan, migrate, redesign) suggests Plan mode. Questions route to
  Ask mode.
- If Jev fails, the chips work as plain manual pickers and **Try again** retries.
- Creating never waits for Jev. If you create while Jev is thinking, the task is
  created and Jev finishes after.

## Two flows to compare

- **Suggest-first** (stories 01–11): Jev re-reads the prompt after each typing
  pause and updates the suggestions before you create the task.
- **Instant** (stories 12–13): closest to Claude Code. **Start task** creates
  `PAP-412` as "Untitled task" right away. The title and routing arrive a moment
  later.

## What's fake

`jev-classifier.ts` is a keyword heuristic with simulated latency. It uses
fixture agents that match the Storybook company (CodexCoder, DesignSystemCoder,
QAChecker, CTO, Darnold) and three projects. No model or API is called and no task
is persisted. To make it real, replace `classifyTaskPrompt` with a server call
that returns the same `JevSuggestion` shape. That call would need company-scoped
agent and project context, and would have to respect paused agents and budgets.

## Open questions

- Should Jev assign to an agent immediately (the instant flow), or only suggest
  while the task stays in draft?
- Does task **type** need to be a real field? Today `IssueWorkMode` and labels
  cover part of it.
- Should Jev's reasoning appear on the created task, as an activity entry, so the
  board can audit routing decisions?
