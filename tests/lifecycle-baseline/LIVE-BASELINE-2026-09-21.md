# Live lifecycle baseline — 2026-09-21

Measured on GitHub Actions with real LLM calls on September 21 (America/Chicago;
September 22 UTC). This supplements the immutable [scripted baseline](BASELINE-2026-09-21.md).
No production lifecycle behavior was changed.

## Initial measurements

- [Full-stack campaign 35672810261](https://github.com/paperclipai/paperclip/actions/runs/35672810261): **35 passed, 5 failed, 40 executed**; 20 journeys on each runtime, Chromium and isolated Paperclip instances, Codex `gpt-5.6-sol`.
- [Protocol campaign 35672841208](https://github.com/paperclipai/paperclip/actions/runs/35672841208): **6 passed, 2 failed, 8 executed**; Codex `gpt-5.4-mini` against the mock protocol authority. All eight pass when the same immutable artifacts are regraded with the corrected evidence-field assertion below. This is not a new provider measurement.
- App revision: `91b62ce1db8d470c6fb452ea286e303309ae54ef`.
- Original Evals revision: `2bedab7a678c988008bef7b416211f0dcb3b4459`.

## Test defects found by live execution

1. Both protocol narrative checks looked for raw `input.summary` / `input.reason`.
   Live evidence intentionally projects these into `input.dispositionSummary`.
   Both original traces contain the requested wording in that field; each uses
   exactly one correct disposition operation, reaches the expected durable state,
   and schedules no unrelated wake. Evals commit
   `8747d0f917e3b02d9ee7170e26733786fe951749` corrects the field and calibrates the
   projected shape. All 29 evaluator support tests pass. Original scores remain
   untouched; regrade records retain the source artifact SHA-256.
2. The generic Product E2E browser assertion always expected the status button
   to say Done. Both native blocker variants reached Blocked in one run, passed
   all eight durable/message matchers, and failed only this incorrect UI assertion.
   App commit `7b68329d2aea136a659584837f35fc83f6f6d014` takes the expected UI status from the fixture's declared
   terminal state. E2E TypeScript and all 437 support tests pass.

## Retained behavior failures

- **Legacy blocker, neutral and challenge:** both finish blocked but produce two
  successful runs rather than one, with duplicate agent responses. The second
  run has wake reason `issue_unblock_requested`; an intervening system comment
  says Paperclip needs a disposition. Execution lock, recovery, retry and monitor
  fields are clear at capture. The pair does not establish a wording-dependent
  difference: both variants fail the same single-run contract. Keep both red.
- **Native stop/new/resume:** the long-response run is cancelled successfully.
  The subsequent `/new` is persisted as a user comment, but the conversation
  generation remains 0 instead of 1 through the 30-second assertion window.
  Failure capture shows blocked status and a queued follow-up cancelled during
  cleanup. Fresh-context and later-resume assertions were not reached. This is
  bounded evidence, not a claim of permanent stalling or a proven root cause.

The three behavior failures are not assertions that narrative caused them.
They are observable product-flow failures to preserve before refactoring authority.
No expected-failure annotations or relaxed run-count limits were added.

## Passing coverage and limits

Both runtimes pass completion, changed question answer, clarification versus
approval, plan revision with approval retained, untrusted handoff, completed child
across restart, ordinary clarification/reuse chat, and approve/decline/always/restart
of a governed tool. Legacy also passes stop/new/resume. The scenario inventory and
paired cases are in [the live suite](../runner-e2e/LIFECYCLE-BASELINE.md).

These are one attempt per selected cell, not a reliability estimate. The protocol
lane proves real model/tool compliance against mocked control-plane state; only
the Product E2E lane exercises the real server/database/browser orchestration.
Deterministic timing, ownership, budget, exhausted-repair, and terminal-ordering
probes remain necessary. This campaign does not establish full live coverage of
all combinations or a prose-free lifecycle.

## Original full-stack cell inventory

| Case | Legacy | Native |
|---|---|---|
| lifecycle-completion-neutral | Pass | Pass |
| lifecycle-completion-challenge | Pass | Pass |
| lifecycle-blocker-neutral | Fail — retained behavior | Fail — UI assertion defect |
| lifecycle-blocker-challenge | Fail — retained behavior | Fail — UI assertion defect |
| lifecycle-question-neutral | Pass | Pass |
| lifecycle-question-challenge | Pass | Pass |
| lifecycle-approval-neutral | Pass | Pass |
| lifecycle-approval-challenge | Pass | Pass |
| lifecycle-plan-revision-neutral | Pass | Pass |
| lifecycle-plan-revision-challenge | Pass | Pass |
| lifecycle-untrusted-evidence-neutral | Pass | Pass |
| lifecycle-untrusted-evidence-challenge | Pass | Pass |
| lifecycle-dependency-restart-neutral | Pass | Pass |
| lifecycle-dependency-restart-challenge | Pass | Pass |
| stop-new-resume | Pass | Fail — retained behavior |
| clarify-reuse | Pass | Pass |
| tool-review-approve | Pass | Pass |
| tool-review-decline | Pass | Pass |
| tool-review-always | Pass | Pass |
| tool-review-restart | Pass | Pass |

## Evidence and accounting

GitHub run artifacts retain source hashes, per-attempt results, API snapshots,
logs and browser traces. Local downloaded evidence and separate protocol regrades
are under `.lifecycle-baseline/actions-20260921/` in this worktree. The compact [cell inventory](baselines/2026-09-21-live.json) retains all 40 original
Product E2E outcomes, eight original protocol scores, and separate regrades. Original
campaign results remain immutable; corrected assertions and follow-up campaigns
must be reported separately.

The initial protocol campaign estimates $0.01000755 for eight attempts; the
corrected fresh campaign estimates $0.00954555 for eight more. Product
E2E cost records are incomplete/unpriced; a reported zero is not proof that the
runs were free. GitHub runner compute is outside these model-cost records.

## Corrected follow-up measurements

[Corrected protocol campaign 35673604555](https://github.com/paperclipai/paperclip/actions/runs/35673604555):
**8/8 live cells passed** with Evals revision `8747d0f917e3b02d9ee7170e26733786fe951749`.
This is a fresh provider run in addition to the artifact regrade.

[Native blocker recheck 35673778202](https://github.com/paperclipai/paperclip/actions/runs/35673778202):
**0/2 passed** at App revision `7b68329d2aea136a659584837f35fc83f6f6d014`.
Both reached Blocked in one run again and passed all eight durable/message
matchers. The first selector correction was incomplete: the actual accessible
label is `Change status (current: Blocked · 0 blockers need attention)`, not
exactly `Change status (current: Blocked)`. The final selector permits the
blocker-attention suffix; persisted issue status remains an exact assertion.
The two captured browser labels and wrong-status controls pass a local headless
Chrome selector calibration. This calibration makes no model calls and is not
a green full-stack rerun. The final selector correction (`3ec4b02f6424a755394854c65a44937a6435f146`) has not been rerun
through Actions.

**Reported baseline remains 35/40 full-stack passing: three retained behavior
failures and two test-assertion defects.** Do not relabel these as 37/40 live passes.
The original and follow-up scores are preserved in the compact inventory.
A dispatch with abbreviated Evals SHA (35673498243) was
rejected before any provider execution; the successful replacement uses the full
40-character SHA. It is a dispatch error, not a behavioral measurement.

## Follow-up attribution correction and fixes

Inspection during the fix found that the legacy blocker fixture omitted the
required structured blocker. Its initial PATCH received HTTP 422. The model then
supplied an unblock descriptor naming itself; the resulting
`issue_unblock_requested` was the configured owner notification. The two legacy
failures therefore do not establish that a valid external blocker generated an
unrequested duplicate run. The original observations and scores above remain
unchanged; their earlier product attribution is superseded by this finding.

The fixture now creates an unassigned backlog prerequisite through the public
API. Legacy PATCH includes its ID in `blockedByIssueIds`; the grader verifies
that exact relation and that the prerequisite remains unfinished. Single-run
and single-response assertions remain unchanged. The definition fingerprint
advances because this is a corrected fixture, not an identical before/after pair.

The native Stop trace shows cancellation acknowledged before the session handle
was published, followed by provider output from the stopped run. The new executor
fence reads durable cancellation after publishing the handle and before submitting
a turn. Earlier cancellation rejects the late session; later cancellation can
reach the published handle. Deterministic tests inject Stop in that exact gap.
The existing execution-owned cleanup closes rejected sessions.

Fresh live verification is recorded separately when complete.
