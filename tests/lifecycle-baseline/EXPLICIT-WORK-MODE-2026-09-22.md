# Explicit work-mode authority — 2026-09-22

Product source: `d17c92eae10e949643a3b9d1be829061c30e77d6`.
Fixture correction: `2e9ee319379ef263a511ef31717ee1185b53abdf`.
Isolated worktree: `/private/tmp/paperclip-lifecycle-baseline-20260921`.

## Behavior

The task creation/update and native/legacy runner mode paths already use explicit
fields. The remaining title/description regexes were a legacy liveness diagnostic
exemption, not a write to `issues.work_mode`. They are now removed. Heartbeat and
activity-ledger backfill pass the persisted work mode to the classifier.

A standard task can deliver a requested plan in its thread or canonical plan
document and complete. It does not become a planning-mode task. Explicit planning
mode and revision-bound approval transitions retain their existing contract.
No schema migration or inferred rewrite of existing tasks is needed.

This is a bounded work-mode change. Other prose diagnostics, productive-progress
accounting, the native compatibility probes and the browser reload finding remain
tracked in [the backlog](../../doc/plans/2026-09-22-legacy-continuation-authority.md).

## Deterministic verification

The [retained baseline](baselines/2026-09-22-explicit-work-mode.json) records
**990 passed / 992 total**: unit 393/393, runner 182/182, database integration
361/363, grading 54/54. The same two unsupported native `same_agent` probes
remain failed and visible; no new failure was accepted or skipped. The original
baseline reports remain unchanged. Measurement finished September 22 in
America/Los_Angeles (September 23 UTC).

Five direct comparison probes also reject the previous classifier: the four
historical title/body triggers incorrectly received the planning exemption,
while a neutral-title task explicitly in planning mode did not. The corrected
classifier passes all five. These comparisons are supplemental to the counted
Vitest baseline.

Coverage includes all former title/description trigger words, missing/default
mode, explicit standard/planning/ask/skill-test modes, full/resumed prompt
directives, native execution input, database create/edit/explicit-mode updates,
canonical plan creation in standard mode, activity backfill, and real heartbeat
repair pairs. The heartbeat comparison uses durable effects because successor
completion can precede a predecessor's diagnostic projection.

All 443 Product E2E support tests and all four inventory/report checks pass.
Repository recursive typecheck, Product E2E typecheck, lifecycle-baseline typecheck,
and repository build pass. The full general repository test command was not
rerun for this small classifier change; the relevant suites are included above.

## Real-provider verification

Campaign [35805477715](https://github.com/paperclipai/paperclip/actions/runs/35805477715)
finished **2/6 passed** on the product source SHA above. It selected six local Codex cells, using
the existing `gpt-5.6-sol` profiles:

- `lifecycle-work-mode-neutral` and `lifecycle-work-mode-challenge` on both
  legacy and native: one provider turn per cell, a requested two-step plan,
  exact visible output, standard mode before/after execution, Done, no extra
  recovery or pending interaction.
- `core-compatibility` / `plan-revise-accept` on both runtimes: explicit planning
  mode, initial and revised plan, exact revision-bound approval, then completion.

Both explicit planning controls passed. All four wording cases preserved
standard mode and completed, but failed the browser's literal full-text match:
Markdown renders ordered-list numbers separately from the DOM text. The retained
legacy challenge screenshot shows the correct plan and Done. Three cases passed
all persisted-state/output matchers. Legacy-neutral additionally posted the
response twice: the provider log records two successful PATCH calls, the second
escaping an underscore. That is a model behavior failure, not a duplicate server
projection. The original machine grades remain unchanged.

The fixture correction uses an equivalent plain-text two-step plan so the raw
exact-output and browser exact-text contracts agree. All 443 support tests and
the E2E typecheck pass again. Campaign
[35806360797](https://github.com/paperclipai/paperclip/actions/runs/35806360797)
is a fresh four-cell measurement of both wording pairs on that corrected source;
**all four live cells passed**. Each runtime delivered the exact two-step plan
once, preserved standard mode, completed in one run and left no extra work or
pending interaction. All evidence validated and cleanup passed, with no retries
or incomplete cells. The two explicit planning/revision/acceptance controls
passed in the first campaign on identical product code. The corrected campaign
does not regrade the first campaign or establish a statistical reliability rate.

These are real browser/server/database/provider journeys. The full 46-cell
lifecycle catalog is not selected by this follow-up. Both campaigns and their
catalog hashes, source revisions, cleanup and billing coverage are retained in
the [live inventory](baselines/2026-09-22-explicit-work-mode-live.json).
Missing cost evidence must not be interpreted as free.

Published reports: [original six-cell attempt](https://d1p6rlowie26tp.cloudfront.net/runner-e2e/campaigns/gha-35805477715-1/index.html),
[corrected four-cell campaign](https://d1p6rlowie26tp.cloudfront.net/runner-e2e/campaigns/gha-35806360797-1/index.html).
