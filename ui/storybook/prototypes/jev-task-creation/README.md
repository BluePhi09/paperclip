# Task creation with Jev

Open **UX Labs → Task creation with Jev** in Storybook:

```sh
pnpm --filter @paperclipai/ui exec storybook dev --port 6010 --host 127.0.0.1 --no-open -c storybook/.storybook
```

## The idea

Today's `NewIssueDialog` asks for a title first, then a description, then
assignee, project, and mode. This prototype starts from the prompt instead. You
describe the work and the rest is suggested, the way Claude Code names a session
after you start it.

Two models do the work, because they are good at different things:

- **[Jev](https://openrouter.ai/docs/guides/community/jev)** (`typesafe/jev-1.13`,
  TypeSafe's decision model on OpenRouter) answers typed `choice` questions:
  task type, assignee, project, and work mode. It returns a choice, a
  confidence, and a probability for every option. It is fast and cheap: you pay
  for input tokens only, and output tokens are free. It does not generate text or
  explain its answers.
- **A small text model** drafts the title. Jev can't, because it doesn't write
  text.

## What the prototype shows

- The **title** types into the header breadcrumb (`PAP › Fix login redirect
  loop…`) when it arrives. Click it to edit.
- **Type**, **assignee**, **project**, and **mode** appear as chips under the
  prompt, usually before the title, because Jev answers faster.
- Suggested values carry a sparkle. When you change a value, the sparkle goes
  away and the value is never overwritten. The undo icon restores the suggestion.
- Every chip menu shows Jev's probability for each option.
- Below the confidence threshold (`JEV_CONFIDENCE_THRESHOLD`, 0.6), the composer
  says how sure Jev is and offers the next likely owners as one-click buttons.
- **How sure Jev is** lists the confidence for each decision, the token cost, and
  the exact request body sent to Jev.
- If Jev fails, the title still arrives, the chips work as manual pickers, and
  **Try again** retries.
- Creating never waits. If you create while suggestions are pending, the task is
  created and they finish after.

## Two flows to compare

- **Suggest-first** (stories 01–11b): suggestions update after each typing pause,
  before you create the task.
- **Instant** (stories 12–13): closest to Claude Code. **Start task** creates
  `PAP-412` as "Untitled task" right away. Routing and then the title arrive a
  moment later.

## What's real and what's simulated

`jev-classifier.ts` builds the real Decisions API request body
(`buildJevDecisionRequest`): the prompt, the company's agents, and its projects go
in `state`, with four `choice` questions. The request and response types follow
the OpenRouter docs.

The response is simulated (`simulateJevDecisions`): keyword signals go through a
softmax to produce probabilities in Jev's response shape. The title is simulated
too (`draftTitle`). No API is called and no task is persisted.

## Going live

1. Add a company-scoped server route, for example
   `POST /api/companies/:companyId/issues/suggest`. It builds the request from
   the company's active agents and projects, leaving out paused agents and agents
   over budget. It calls `POST https://openrouter.ai/api/alpha/decisions` with the
   instance's OpenRouter key, and a small chat model for the title, in parallel.
   Keep the key on the server.
2. Return a `JevRouting`-shaped payload, so this UI doesn't change.
3. Record the chosen values and Jev's confidences on the created task's activity
   entry, so the board can audit routing decisions.
4. Label 100–200 real tasks and tune the confidence threshold against them, as the
   OpenRouter classification cookbook recommends.

## Open questions

- Should a task auto-assign in the instant flow even when Jev's confidence is
  low, or wait for the user to pick?
- Does task **type** need to be a real field? Today `IssueWorkMode` and labels
  cover part of it.
- Should Jev's criteria for each agent come from agent instructions or role
  metadata, rather than a hand-written "owns" line?
