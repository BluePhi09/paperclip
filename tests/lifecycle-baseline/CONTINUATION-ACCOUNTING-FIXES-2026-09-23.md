# Continuation accounting fixes — September 23, 2026

Follow-up to the [September 22 baseline](CONTINUATION-ACCOUNTING-2026-09-22.md).
Original failed measurements remain unchanged. The production and test changes
are committed as `cfbf03adee36ff8c3235858d046147c2d3c078d4`.

## Changes

- Infrastructure retries and max-turn continuations have separate persisted
  counters. Resource waits and disposition repairs carry both counts forward;
  neither spend nor replenish them. Repair slots remain in their durable episode.
- Delayed legacy repairs use the episode fingerprint that created them, with a
  successful source run bound to the same company, task and agent. Invalid source,
  changed episode and exhausted slot are rejected. Existing late gates still apply.
- The two unsupported native `same_agent` compatibility probes now exercise the
  public question/response tool contract, including misleading prose, no execution
  before a response, duplicate delivery and five successive productive turns.
- The unstamped development service worker no longer intercepts Vite module
  revalidation. The retained blank-page trace showed a bodyless module `304` through
  the worker before React mounted. The browser regression proves repeated conditional
  module reloads bypass that worker; it does not reproduce the entire original hang.
  Stamped production offline caching retains its existing privacy checks.

## Deterministic verification

[Saved measurement](baselines/2026-09-23-continuation-accounting-fixed.json):
**1,073 / 1,073 passing**, no skipped tests or missing inventory evidence.

| Layer | Passed / total |
|---|---:|
| Unit | 423 / 423 |
| Runner | 184 / 184 |
| Database/heartbeat integration | 381 / 381 |
| Grading | 85 / 85 |

The original baseline was 1,053 / 1,059. All four newly failing intended-behavior
assertions pass unchanged. Two obsolete native probes were replaced as described
above. The new total additionally includes nine accounting helper assertions and
five database regressions for alternation/restart, repair debit preservation and
invalid delayed repair sources.

Measurement provenance: the saved runner metadata records parent `c0b5ee8b3` plus
working-tree fingerprint `1ef24dd199eff085dd4f7897398e08473c9ff618c23182246648589ab5239cd0`.
Those exact source/test changes were then committed as `cfbf03ade`; the raw local
measurement is `.lifecycle-baseline/2026-09-23T14-21-33.472Z/`, including `source.diff`.
The saved JSON is copied unchanged rather than relabeled as a clean-commit run.

Other completed checks:

- Product E2E support: 475 / 475 after the comment-format calibration follow-up
  (474 / 474 before it). An initial sandboxed run could not bind fixture
  sockets; the normal-permission rerun passes.
- Cheap real-browser support: 5 / 5, including three conditional reloads using the
  actual development worker. The new regression fails on the previous worker
  because it intercepts all three module fetches.
- Accounting helper, worker cache/privacy and build stamping checks: 33 / 33.
- Baseline inventory/report support: 4 / 4.
- E2E and baseline typechecks, recursive repository typecheck, token gates and
  repository build pass.
- The [grading-only follow-up](baselines/2026-09-23-continuation-accounting-grading-followup.json)
  passes 86 / 86, adding a test that rejects the exact serialized-array mistake
  observed live. Combined with the unchanged unit/runner/integration layers,
  the current inventory has 1,074 passing assertions. The full 1,073-test
  measurement above remains an unmodified record of its earlier execution.

The full repository test first passed its general server phase (12,902 passed,
83 pre-existing skips), then stopped on three offline fallback tests that loaded
the development worker while expecting production behavior. Their fixture now
uses a production build stamp, preserving all assertions. The full UI rerun
passes 6,503 / 6,503; CLI passes 502 / 502.

The remaining supported repository groups ran separately, avoiding repetition
of the passing general server phase. Two route shards initially exceeded their
15-second cold-import test deadline while the UI group was running; unchanged
reruns at lower load are retained separately. Broad package verification also
exposed a pre-existing callback-drain fixture assumption that a handler starts
within a 250ms polling window. That test now awaits an explicit start signal;
its original drain assertions and all 61 tests in the file pass. These follow-up
changes affect test setup only, not the product source measured by the live run.

Final repository verification: **25,944 passed, 0 failed, 102 existing skips**
across all groups of `scripts/run-vitest-stable.mjs`. All 148 serialized test
files are accounted for exactly once in the final three shard results. The
[verification record](baselines/2026-09-23-continuation-accounting-repository-verification.json)
retains the original failures, successful group counts and log hashes. Recursive
typecheck and build pass; the two test-only follow-ups also pass their package
typechecks and token gates. This is a complete resumed verification, not a claim
that the first monolithic `pnpm test:run` invocation exited successfully.

## Live verification

[Campaign 35873996790](https://github.com/paperclipai/paperclip/actions/runs/35873996790)
ran the same eight explicit `continuation-accounting` cells against `cfbf03ade`.
The qualified Codex `gpt-5.6-sol` profiles, local isolated fixtures, real provider calls and
Chromium browser remain the same. No expected outcome or live grader was weakened.

Result: **7 / 8**, no retries, all evidence packages valid and cleanup successful.
All three previously failing live journeys pass: both bounded exhaustion cases
and the legacy quiet productive workflow, including repeated task reloads. Its
final screenshot shows Done and five document cards at revision 1. Stop, approval,
legacy noisy productivity and native noisy productivity also pass.

Native quiet productivity completed all five correct documents and four answered
questions with no repair/failure debt. Its sole failed assertion is `perturbation`:
the model posted `["ACCOUNTINGQUIET..."]` instead of `ACCOUNTINGQUIET...` on each
turn. This is a completed model instruction-following failure, with an ambiguous
JSON-array presentation in the fixture prompt; it is not a lifecycle accounting
failure or missing evidence. The original machine grade remains failed.

- [Published 7/8 report](https://d1p6rlowie26tp.cloudfront.net/runner-e2e/campaigns/gha-35873996790-1/index.html)
- [Immutable first post-fix measurement](baselines/2026-09-23-continuation-accounting-fixed-initial-live.json)

Commit `841b836be232e6624776ee4e3f7641271d954914` presents each exact comment body
as a separate fenced literal and explicitly excludes brackets/quotation marks.
The exact-match grader is unchanged, and the added calibration rejects serialized
array bodies. [Final campaign 35876252684](https://github.com/paperclipai/paperclip/actions/runs/35876252684)
reran all eight cells against that source. The previous campaign's tests, merged
report and S3 publication finished before dispatch; only its queued secondary
GitHub Pages copy could be superseded by the workflow's same-branch concurrency.

Billing for the first post-fix run is partial: 31/32 run records have token usage,
10 have reported cost, and one is cancelled before dispatch. Reported zero cost
does not mean zero actual spending. The saved measurement retains all coverage
fields and definition fingerprints.

Final result: **8 / 8 passed**, no retries, no incomplete cells, all eight evidence
packages valid and cleanup successful. Both native and legacy productive wording
pairs complete five exactly-once revision-one records through four real responses.
Both legacy exhaustion variants reach the expected bounded stop; the late Stop
and approval workflows retain their authoritative behavior.

- [Final live report](https://d1p6rlowie26tp.cloudfront.net/runner-e2e/campaigns/gha-35876252684-1/index.html)
- [Immutable final measurement](baselines/2026-09-23-continuation-accounting-fixed-live.json)

The final measurement also has partial billing: 31/32 run records report usage,
10 report cost, and one is cancelled before provider execution. No zero-spend
claim is made. Both post-fix campaigns and the September 22 failures are retained.

## PR integration verification

[PR #13888](https://github.com/paperclipai/paperclip/pull/13888) replays the branch
onto master `b41ccf097`. The original baseline branch and measurements remain
unchanged. The combined native startup check needed one ordering correction:
publish the session handle before reading the durable Stop record, so the waiting
Stop caller can acknowledge the exact cancellation. The new paired regression
failed for both native backends before the fix; the full native-session suite then
passed **447/447**. The lifecycle baseline passed **1,074/1,074**, Product E2E
support **515/515**, and browser support **11/11**. Recursive typecheck, E2E harness
typecheck, full build, and token gates passed.

[Campaign 35881382080](https://github.com/paperclipai/paperclip/actions/runs/35881382080)
measured PR source `e88d210417280140b44a36449027290adcb1aeaa`: **8/8 passed**,
zero retries, zero incomplete cells, all evidence valid, and cleanup passed.
It selects only the complete accounting suite, not the complete Product E2E
catalog. Profiles remain legacy Codex and native Codex on local isolated instances,
using `gpt-5.6-sol`. The [saved measurement](baselines/2026-09-23-pr-accounting-live.json)
retains the source, definition hash, timing, run counts, and billing coverage.
The published normalized report matches the downloaded artifact. Billing remains
partial: 31/32 run records report usage and 10 report cost; reported zero is not a
zero-spend claim.

- [Published PR accounting report](https://d1p6rlowie26tp.cloudfront.net/runner-e2e/campaigns/gha-35881382080-1/index.html)

The first PR CI run exposed an old connection-intent browser fixture that used a
tool and exited without recording completion. Its `scheduled_retry` failure was
reproduced locally. The fixture now records an agent-authored progress comment
while waiting and a Done disposition after successful tool use. This respects the
existing missing-comment compliance policy, which remains a separately recorded
backlog item. Its assertions also require one resumed tool call and exactly two
successful runs; no scheduler rule or grading threshold was relaxed.
The corrected connection-intent journey passed in a fresh local browser/server
instance. The two CI runtime-service readiness failures also passed unchanged in
their local suites (34 passed, 3 platform skips); current-head CI remains the
required cross-platform handoff gate.
