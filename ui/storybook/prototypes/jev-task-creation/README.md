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
  TypeSafe's decision model on OpenRouter) answers typed `choice` questions for
  the task's **mode**, which is its type (Auto, Plan, or Ask), and its
  **assignee**. It returns a choice, a
  confidence, and a probability for every option. It is fast and cheap: you pay
  for input tokens only, and output tokens are free. It does not generate text or
  explain its answers.
- **A small text model** drafts the title. Jev can't, because it doesn't write
  text.

## What the prototype shows

- **Live routing while you type.** Mode and assignee re-route about
  250 ms after each pause in typing, and at least every 800 ms during continuous
  typing. Jev is fast and cheap enough for this: a call costs about $0.00004.
- **Steady suggestions.** A chip only switches when Jev's new pick leads the
  current one by 15 points of probability (`JEV_SWITCH_MARGIN`,
  `stabilizeRouting`), so a word or two doesn't make the owner flicker.
- **Calm change cues.** Chips stay on screen from the first keystroke. A changed
  value fades in and its chip highlights briefly. A small pulsing mark shows Jev
  re-reading. Explanatory notes, like the fallback owner, wait for a one-second
  pause in typing.
- **Title on start.** The title is drafted once, when you press **Start task** or
  **Enter**, like Claude Code naming a session after the first message. It types
  into the header breadcrumb and you can click it to edit. Shift+Enter adds a new
  line.
- **Project is not predicted.** It stays a plain manual picker (default "No
  project"). Project leads still appear in each agent's description, because
  they help Jev pick the owner.
- **Mode is the task's type** and uses the shipped `IssueWorkMode` values and
  labels:
  - **Auto** (`standard`): the agent does the work.
  - **Plan** (`planning`): the agent writes a plan for review first.
  - **Ask** (`ask`): the agent answers without changing anything.
- Suggested values carry a sparkle. When you change a value, the sparkle goes
  away and the value is never overwritten. The undo icon restores the suggestion.
- Every chip menu shows Jev's probability for each option.
- **Low-confidence fallback.** When Jev's assignee confidence is below
  `JEV_CONFIDENCE_THRESHOLD` (0.6), the task goes to the org's first active agent
  that reports to the board (`reportsTo: null`, earliest `createdAt`). If no
  active agent reports to the board, it goes to the org's first active agent.
  Paused agents are skipped, and Jev never sees them as options. The composer says
  so in one line and offers Jev's best guesses as one-click buttons
  (`fallbackAssigneeId` in `jev-classifier.ts`; stories 09 and 09b).
- **How sure Jev is** lists the confidence for each decision, the agent context
  sent, the token cost, how many times routing ran while typing, and the exact
  request body sent to Jev.
- If Jev fails, the title still arrives, the chips work as manual pickers, and
  **Try again** retries.
- Starting never waits. Whatever Jev has suggested is used, and anything still
  pending finishes after.

## Modal design

The composer is the shipped `NewIssueDialog` chrome, rebuilt for prompt-first
creation with product tokens only (no bracket values, hex, or raw durations):

- **Header:** the `PAP ›` breadcrumb. After starting, it becomes `PAP-412 ›` and
  the title types in; click it to rename.
- **Body:** the prompt is the hero: borderless, auto-growing, with Enter to start
  and Shift+Enter for a new line. Under it, one routing sentence in the shipped
  dialog's shape: `[Mode] For [Owner] in [Project]`, using the shipped compact
  control style and work-mode chip colors.
- **Jev's presence:** a quiet sparkle and confidence number at the end of the
  routing row. It pulses while Jev re-reads and opens the confidence details on
  click, instead of an always-visible disclosure.
- **Motion:** changed values fade in with the app's `tc-enter-marker` class and
  take a brief accent fill timed by `--motion-duration-slow` and
  `--motion-ease-standard`. Both collapse under reduced motion.
- **Footer:** Cancel left, the ↵ / ⇧↵ hint, and Start task right. After starting:
  Create another left and Open task right, with the result shown in place rather
  than as a toast (DESIGN.md contextual feedback).
- **Errors:** the shipped `InlineBanner` with a Try again action.
- `presentation="inline"` renders the same surface in the page flow for review
  pages; the default is the real `Dialog`.

## Estimated cost per task

Every task shows an **Estimated cost** table:

- **Jev · live routing:** every call made while typing, plus a final call if
  typing got ahead of routing. Input tokens only, at $0.042 per million; output
  tokens are free.
- **Haiku 4.5 · title:** the single title call made on start. `buildTitleRequest`
  is the real Messages API body for `claude-haiku-4-5`: a short system
  instruction, the prompt, and `max_tokens: 64`. $1 per million input tokens and
  $5 per million output tokens.
- **Total**, with an estimate for 1 million tasks like this one.

Token counts are estimated at about four characters per token. In production,
read `usage` from each response instead.

## Two flows to compare

- **Suggest-first** (stories 01–11c): review the live suggestions, then create.
- **Instant** (stories 12–13): closest to Claude Code. **Start task** or **Enter**
  creates `PAP-412` right away. Routing is usually already there; the title
  arrives a moment later.

## What's real and what's simulated

`jev-classifier.ts` builds the real Decisions API request body
(`buildJevDecisionRequest`): the prompt and the company's agents in `state`,
and two `choice` questions. The request and response types follow the
OpenRouter docs.

Each agent's option in the assignee question is described by
`describeAgentForJev`. It uses the context Paperclip already stores, highest
fidelity first, and skips any source that is empty:

1. Name, title, and role. These are always present, but rarely decide anything.
2. `agents.capabilities`, when set. Built-in agents and imports fill it; the
   new-agent flow can't, so hand-made agents usually lack it.
3. Projects it leads (`projects.leadAgentId`).
4. Assigned skills (`adapterConfig.paperclipSkillSync`).
5. Its last 10 finished tasks (`issues.assigneeAgentId`, status done). This is
   the strongest signal, because it shows what the agent really does.
6. An excerpt of its `AGENTS.md` instructions, only when customized. The default
   template says nothing about the agent, so it is left out.

The fixtures have realistic gaps: CodexCoder is hand-made with no capabilities
and default instructions, the CTO comes from the teams catalog, and Darnold is a
built-in agent. **How sure Jev is** says which sources were available, and
**Request sent to Jev** shows the full body. Five agents come to roughly 900
input tokens, far under Jev's 32K limit.

The response is simulated (`simulateJevDecisions`): keyword signals go through a
softmax to produce probabilities in Jev's response shape. The title is simulated
too (`draftTitle`). No API is called and no task is persisted.

## Going live

1. Add a company-scoped server route, for example
   `POST /api/companies/:companyId/issues/suggest`. It builds the request from
   the company's active agents and their context, leaving out paused agents and agents
   over budget. It calls `POST https://openrouter.ai/api/alpha/decisions` with the
   instance's OpenRouter key, and a small chat model for the title, in parallel.
   Keep the key on the server.
2. Return a `JevRouting`-shaped payload, so this UI doesn't change.
3. Record the chosen values, Jev's confidences, and whether the fallback owner
   was used on the created task's activity entry, so the board can audit routing
   decisions.
4. Label 100–200 real tasks and tune the confidence threshold against them, as the
   OpenRouter classification cookbook recommends.

## Open questions

- Should the new-agent flow and the configuration page let people set
  `capabilities`? It is the one field built for describing an agent, and today
  hand-made agents can't set it.
