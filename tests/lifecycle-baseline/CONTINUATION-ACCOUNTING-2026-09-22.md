# Continuation accounting baseline — September 22, 2026

This is a test-first slice. Production scheduling/authority code is unchanged.
The [scenario matrix](../../doc/plans/2026-09-22-continuation-accounting-baseline.md)
and executable inventory cover separate allowances, false progress, late gates,
restart and duplicate handling. There are 67 additional deterministic tests
and eight new explicit-only real-provider Product E2E cells.

## Deterministic measurement

Source: `379a70315e47de1ac2c8e4eb452eb3121401c5c7`, no tracked source changes at measurement.
Raw evidence: `.lifecycle-baseline/2026-09-23T03-04-36.107Z/`.
[Saved inventory and results](baselines/2026-09-22-continuation-accounting.json).

| Layer | Passed / total | Failed |
|---|---:|---:|
| Unit | 413 / 414 | 1 |
| Runner | 184 / 184 | 0 |
| Database/heartbeat integration | 371 / 376 | 5 |
| Grading | 85 / 85 | 0 |
| Total | 1,053 / 1,059 | 6 |

No skipped tests or missing inventory evidence. Four newly failing tests
identify three production problems:

1. **Delayed repair spends infrastructure allowance.** Immediate first repair
   has no scheduled retry debit and passes. Delayed repair 2 has
   `scheduledRetryAttempt: 2`, `scheduledRetryReason: issue_disposition_repair`.
   `executionFailureRetryCount` interprets it as two prior failures, so a first
   safe infrastructure failure is already exhausted. One pure assertion and one
   actual scheduler assertion expose this.
2. **Infrastructure retries spend productive allowance.** A run resumed after
   two infrastructure retries reaches its first typed max-turn continuation.
   The scheduler reads the same counter as two consumed productive attempts and
   returns exhausted. The test expects productive attempt 1.
3. **The delayed second repair is cancelled during promotion.** The legacy
   repair dispatch gate accepts the persisted episode, but the shared dispatch
   path compares its fingerprint against a different disposition fingerprint.
   It cancels the unstarted repair with
   `issue_disposition_repair_superseded`. The new database test reproduces this
   through actual due-retry promotion after recreating the controller service.
   The first live exhaustion run also retained this exact cancellation, with
   only two provider executions and no final exhaustion checkpoint.

The other two failures are the previously retained native `same_agent`
compatibility probes. They inject an unsupported current public continuation
shape and do not establish a current model-facing defect. The new paid native
productive tests use reachable question/response contracts.

The tests also prove that twenty comments or a large raw tool count do not
replenish exhausted legacy repairs, including through the full recovery sweep
while the issue is still active. A new approval, company budget hard-stop,
agent pause or reassignment during the second repair delay blocks dispatch
without another debit. Native replay with twenty commentary/tool events does
not resubmit consumed disposition repair. Existing gates and duplicate/restart
regressions remain linked in the inventory.

## Other verification

- Product E2E support: 474/474 passing, including 31 new accounting support tests.
- Inventory/report support: 4/4 passing.
- E2E and lifecycle baseline typechecks pass.
- Server and runner package typechecks pass; server preparation also completes
  the runner build and generated-contract checks.
- Full general repository tests, recursive typecheck and root build were not
  rerun: this slice changes only tests, harness and documentation. This is not
  a claim of repository-wide green or PR readiness. The new intended-behavior
  failures remain enabled and will fail their normal test lane until fixed.

The [initial deterministic measurement](baselines/2026-09-22-continuation-accounting-initial.json)
at `ed53efb1e0e363b382b5101340259ad3cab34307` is retained separately: 1,051/1,056.
The later total adds the promotion regression and two harness calibration tests.

## Live measurement

All cells use qualified Codex `gpt-5.6-sol`, real Chromium, and isolated local
server/database fixtures in parallel GitHub Actions jobs. Original machine
grades, source/definition fingerprints, cleanup and billing are retained for
each campaign; unavailable cost is not zero spending.

First campaign: [35811412940](https://github.com/paperclipai/paperclip/actions/runs/35811412940),
source `9cd7a585f5c69dc327b7d90534ad51be89ae5bb7`. All eight cells failed.
This measurement is not regraded. Initial fixtures requested three identical
comments, which the product deduplicates per run; rich-text serialization also
escaped underscores in literal test tokens. Screenshot names did not meet the
existing evidence allowlist, so the public report publisher rejected the bundle.
Legacy quiet productive behavior passed every causal check before packaging
failed. Approval and Stop lifecycle checks also passed while their comment
perturbation checks failed. Both exhaustion cells failed to reach the expected
exhaustion checkpoint; retained API state identifies the cancelled delayed repair.

Corrected fixtures use three distinct numbered comments, plain alphanumeric
tokens and existing allowed screenshot names. A packaging test verifies those
screenshots survive. Cancellation fails promptly with its typed reason and the
last observed state, instead of waiting for the overall deadline. These are
test-harness changes, not changes to production behavior.

Corrected campaign: [35813099816](https://github.com/paperclipai/paperclip/actions/runs/35813099816),
source `379a70315e47de1ac2c8e4eb452eb3121401c5c7`:
**5/8 passed, 3 failed**, no missing cells or retries, all eight evidence packages
valid and cleanup successful. The corrected public report published successfully.

| Cell | Result | Observed behavior |
|---|---|---|
| Legacy productive, quiet | Fail | After two successful runs, two exact revision-one records, and a pending next question, a task-route reload renders a blank page. `task-chat-thread` never appears within 30 seconds. Remaining three steps are unverified |
| Legacy productive, noisy | Pass | Five productive runs, five exact revision-one documents, four real answered questions, no repair/failure debits |
| Native productive, quiet | Pass | Same five-step causal assertions |
| Native productive, noisy | Pass | Same five-step causal assertions despite misleading attributed comments |
| Legacy exhaustion, quiet | Fail | Second repair cancelled before dispatch with `issue_disposition_repair_superseded` |
| Legacy exhaustion, noisy | Fail | Identical typed cancellation despite the additional comments |
| Legacy repair then Stop | Pass | Delayed second repair cancelled by the operator before dispatch; remains stopped after controller restart and scheduled due time |
| Legacy repair then approval | Pass | Pending approval owns the wait; real browser acceptance produces exactly one successful completion without repair debt |

The blank-page screenshot is empty. This matches the symptom of the
retained task-route reload finding; it does not establish the underlying UI
cause, and it is not counted as a completed productive case. The successful
native noisy final screenshot shows Done and all five document cards at revision
one. Both exhaustion checkpoints retain the scheduled and restarted run IDs;
their last observations include the cancelled unstarted repair and a board-owned
`active_run_watchdog` action instead of completed disposition-repair exhaustion.

- [Published corrected report](https://d1p6rlowie26tp.cloudfront.net/runner-e2e/campaigns/gha-35813099816-1/index.html)
- [Both immutable campaign measurements, fingerprints, grades and billing](baselines/2026-09-22-continuation-accounting-live.json)

Billing is partial in both campaigns. Provider-reported zero totals do **not**
establish free execution: the first campaign records token usage for 29/32 run
records and reported cost for 10; the corrected campaign records usage for 26/29
and reported cost for 10. Each includes three cancelled, unstarted records.
The saved billing fields preserve the original coverage and cost status.

## Next production slice

Fix allowance separation and the delayed-repair promotion contract against the
enabled deterministic failures, then rerun the same eight-cell suite. Keep the
blank-route finding, unsupported native compatibility probes and earlier backlog
distinct. This baseline establishes assertions and observed behavior; it does
not claim the product is already robust or that every supported provider is
qualified.
