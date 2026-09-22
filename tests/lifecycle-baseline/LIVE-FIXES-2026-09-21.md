# Lifecycle live fixes — 2026-09-21

This follow-up changes production startup cancellation and repairs test fixtures.
The [original baseline](LIVE-BASELINE-2026-09-21.md) and its scores remain intact.
The [fix campaign inventory](baselines/2026-09-21-live-fixes.json) retains each new
cell outcome, source SHA, definition hash, artifact SHA-256 and cost coverage.

## Changes

- **Native Stop during startup:** Stop could commit after the coordinator claim
  but before the provider session handle existed. Cancellation was acknowledged
  without reaching the later session, which submitted work anyway and held up
  `/new`. The executor now publishes the handle, reads the durable run state and
  rejects an already stopped session before provider submission. Later Stop can
  reach the published handle. Execution-owned cleanup and ownership gates remain.
  Two deterministic tests inject cancellation in this precise gap.
- **Legacy blockers:** the original prompt omitted the API's required structured
  blocker and received 422. The model then named itself as unblock owner, which
  legitimately woke it again. The corrected fixture seeds an unassigned backlog
  prerequisite and requires a dependency link. The grader reads `blockedBy` from
  the public GET response and verifies the exact prerequisite remains unfinished.
  Exact single-run and single-response assertions remain.
- **Blocked status UI:** the browser assertion uses the fixture's expected state
  and accepts the Blocked attention suffix. Persisted status is still exact.
- **Approval proposal identity:** a run saved `welcome-note-approach`, bound its
  exact revision for confirmation and waited correctly. The generic grader's
  English key convention misclassified this as a premature final deliverable.
  The lifecycle fixture now explicitly requires the proposal's reserved `plan`
  key and its current-revision approval, with no other output before approval.
  We retain the negative control that an arbitrary final deliverable does not
  become a plan merely because an agent targets it for confirmation. New controls
  reject proposal confirmations for the wrong issue, key or revision.

## Fresh campaigns

[35679927390](https://github.com/paperclipai/paperclip/actions/runs/35679927390),
App `59f01883de1c9447eb8ac68f24ed24cad573fc00`: **37 passed, 3 failed, 40 executed**.
Both native blockers and native Stop/new/resume passed. The remaining failures
were two incorrect GET-field assertions and the proposal-identity mismatch above.
All cleanup passed; no retries. These original campaign scores are not regraded.

[35680906634](https://github.com/paperclipai/paperclip/actions/runs/35680906634),
App `331e89bb3e40064bb8f51010f176db367588bbef`: **40 passed, 0 failed, 40 executed**.
All 20 legacy and all 20 native journeys passed, including both narrative variants
of blockers, approvals and plan revisions, and Stop/new/resume on both runtimes.
All evidence validated and all cleanup passed, with **zero retries or incomplete
cells**. The fixture definition changed from the preceding campaign; this is a
fresh provider measurement, not a regrade or a claim that the original failures
never occurred.

The normalized report's `complete` flags remain false: those fields qualify
coverage against the publisher's known catalog/definition hashes and the entire
multi-suite roster. This branch-only, explicitly selected lifecycle suite does
not qualify that broader catalog. Its 40 selected cells all executed and passed;
this is not a claim that every Paperclip E2E suite was run.

## Local validation

- 418 tests passed: native session executor (385) and agent conversations (33).
- 440 Product E2E support tests passed, including the three new negative controls.
- Product E2E TypeScript and server typecheck passed. The latter also completed
  the runner TypeScript/Rust build and generated contract checks. The first local
  typecheck hit missing `three` dependencies; installation was repaired using
  repository pnpm 9.15.4, and the tracked lockfile was preserved.
- No repo-wide test/build qualification is claimed. The separate scripted
  narrative-authority baseline still contains its recorded failures; this is
  not the broader removal of prose from lifecycle authority.

Each paid cell is one attempt, using Codex `gpt-5.6-sol`, Chromium, a real isolated
server/database and either legacy or native execution. A successful campaign is
not a reliability estimate. Product model-cost coverage is partial/unpriced;
reported zero is not proof of free execution. GitHub compute is separate.
