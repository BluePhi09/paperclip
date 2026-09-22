# Legacy continuation authority — 2026-09-22

Legacy successful-run continuation now derives its decision from persisted
run/task state and recorded API/tool effects. Narrative classification remains
available for diagnostics; this path does not use it to schedule, identify,
instruct, or replenish continuation work.

## Behavior

- A successful provider exit is not task completion. A recorded terminal status,
  blocker, question, approval, dependency, monitor, or existing execution owner
  determines the next action.
- An eligible unfinished task without a disposition receives an agent repair
  instruction through the normal wake payload. The agent must record the outcome
  using existing Paperclip APIs/tools. Changing prose cannot select the path.
- The durable repair episode permits at most two attempts before visible board
  escalation. Already-consumed older budgets retain their tighter limits.
  Existing comment-retry ownership is respected rather than opening another
  repair allowance after its exhaustion.
- Stop, pause, budget, ownership, company binding, pending approval and existing
  work are checked again at dispatch. Goal, routine, plugin and conversation
  owners remain authoritative. Native semantic finalization is unchanged.
- Replay and concurrent checks share a stable receipt and episode counter.
  A late scheduling write cannot rewind a newer attempt. Infrastructure retries
  retain the original disposition source and delayed repairs retain the initiating
  user's identity.

The [implementation plan and retained backlog](../../doc/plans/2026-09-22-legacy-continuation-authority.md)
keep the remaining findings separate from this change.

## Deterministic evidence

The [new baseline inventory](baselines/2026-09-22-legacy-continuation.json)
records a clean measurement at App `d2a6acddb`: **902 passed, 2 failed, 904 total**.
Unit 317/317; Runner 182/182; integration 351/353; grading 52/52.
The original September 21 snapshots remain unchanged.

All 178 wording/authority assertions pass. The real heartbeat pair now follows
the same wake reason, repair instruction, attempt limit and final state.
The persisted-authority suite has 27 passing tests, including concurrent replay,
restart, stale diagnostic labels, fast-successor ledger writes, dispatch-time
Stop/approval/ownership changes, infrastructure retry and bounded exhaustion.

The two remaining native probes inject `same_agent`, which is not in the current
public continuation contract. They remain visible in the baseline and are not
classified as proven current model-facing defects or silently skipped.
A preceding clean measurement on `f044e17ed` had an additional dependency-test
teardown timeout; its retained local inventory is
`.lifecycle-baseline/2026-09-22T14-58-55.292Z/`. A fresh measurement and the focused
15-test dependency suite passed that case without changing its assertions.

The broader checks also exposed old mocks that represented completed work using
only summaries. Those fixtures now record done or a pending confirmation while
preserving their identity, comment attribution, workspace and native-boundary
assertions. A real delayed-row identity omission was fixed separately.

## Real-provider campaigns

The [live inventory](baselines/2026-09-22-legacy-continuation-live.json) retains
source commits, fixture hashes, normalized artifact SHA-256, cell outcomes,
cleanup, evidence validation and billing coverage. Every cell uses a real Codex
provider, browser, isolated server and database; these are not canned responses.

- [35738968308](https://github.com/paperclipai/paperclip/actions/runs/35738968308),
  App `f3e09abd4`: 1/2 passed. Neutral passed; challenge skipped the requested
  initial phase and immediately recorded done. The causal two-run oracle correctly
  rejected it. The fixture now selects its phase from `PAPERCLIP_WAKE_REASON`.
- [35744074887](https://github.com/paperclipai/paperclip/actions/runs/35744074887),
  App `f044e17ed`: 1/2 passed. Both cases recorded the exact initial comment,
  one causally bound repair and done. Neutral failed the final browser assertion:
  the reload stayed blank even though API state and the exact final message were
  correct. The failure remains recorded. Browser exception capture was added;
  assertions were not relaxed.
- [35747200170](https://github.com/paperclipai/paperclip/actions/runs/35747200170),
  App `d2a6acddb`: **41/42 passed; legacy 22/22, native 19/20**. Both new repair
  probes passed, including their browser assertions. The native plan-revision
  challenge completed all three turns, both approval boundaries, the correct
  revised output, done and cleanup; its task route then reloaded blank. All 17
  persisted-state matchers passed, but the strict browser check failed. This is
  retained as a separate unresolved UI finding, not regraded as a pass.

All 42 selected cells executed once; no retries or incomplete cells. All evidence
validated and all cleanup passed. The [published report](https://d1p6rlowie26tp.cloudfront.net/runner-e2e/campaigns/gha-35747200170-1/index.html)
contains the failure alongside successes. Publisher catalog-completeness flags
are not a claim that every Paperclip suite was selected.

Reported zero cost is not proof of free execution: product model-cost coverage
is partial, and GitHub compute is separate. A passing campaign is one measurement,
not a reliability estimate.

## Broader qualification

The 441 Product E2E support tests pass, as do server and E2E typechecks. Repository
recursive typecheck and build both passed again on final implementation `d2a6acddb`.
The fresh general-server shards recorded 12,812 passing assertions. One suite
could not start PostgreSQL because macOS exhausted shared-memory IDs; its 14
identity tests passed when run alone. All 6,502 UI tests passed. The database
package passed all 160 tests with sequential workers after four startup failures
in the parallel run. CLI import (17), auth readiness (14) and agent-skills routes
(54) passed on focused reruns after timeouts in their broader groups.

The full repository command was attempted, but its early-exit groups did not all
complete cleanly. No repo-wide green claim is made: broad runs encountered local
PostgreSQL resource limits and route timeouts, and the historical baseline retains
its two native probes. Downloaded provider recordings were moved outside the
checkout after the authored-guidance scanner included them; its unchanged 39 tests
then passed. A sequential run of the database, adapter utility, provider adapter,
plugin and plugin-creator packages passed another 2,620 assertions (19 explicitly
skipped). Focused regressions and the clean lifecycle inventory are the acceptance
evidence for this change.
