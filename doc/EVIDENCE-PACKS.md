# Evidence-pack execution gates

Status: implemented; covered by targeted local tests (throwaway PostgreSQL,
in-process test adapters, fake Codex transport). Not exercised against a live
provider. Rely on it only once the full CI (typecheck, build, test shards) is
green for the branch.

An issue opts into execution authorization through `executionPolicy.evidencePack`.
The binding names the current `evidence-pack` issue document revision, exact
scope and native interaction receipts. Productive checkout/start and heartbeat
handoff validate the current documents, independent reviewer/run provenance,
conditions, prerequisite reviews, target context and database-clock expiry.
A completed review task is not itself an approval.

## Opt-in invariant

Issues without `executionPolicy.evidencePack` behave as before. The heartbeat
admission points (claim, run start, dispatch/handoff, native operation
admission) first run a lock-free probe (issue policy and the run's own
recorded admission). Without a pack and without a recorded
`evidenceAdmission`/`evidenceReviewerAdmission` the probe returns
immediately: no extra row locks or transactions, no execution-ownership
requirement and no denial. Run start keeps the claimed run record (no reload).

Checkout and its adoption branches do not use the heartbeat probe. Without a
pack they run the legacy single `UPDATE`; it carries a guard that makes it a
no-op when a pack is present, and only then is the write repeated in a
transaction that takes the issue row lock (`SELECT ... FOR UPDATE`) and
checks the pack. A row that disappears before a write still returns no row
to the legacy fallback. The pre-existing cleanup of terminal lock holders
and the stale-checkout adoption already lock the issue row; they are unchanged
apart from a pack check that is a no-op without a pack. Productive
`status: in_progress` updates check the pack inside the existing locked
update transaction.

Without a pack, runs that never hold the issue execution lock (mention/comment
runs of a non-assignee, `source_scoped_recovery_action` runs, runs while
another run holds the lock) dispatch through the unchanged legacy handoff.
Only resolved-interaction continuations and native retry replacements use the
staleness/ownership dispatch gate, as before.

On opted-in issues the claim admission applies to every run of the issue:
a run of an agent that is not the current assignee (for example a mention
run) is refused with `evidence_pack_executor_changed` unless it holds a
current native review assignment (see below); that refusal is a terminal
denial with an activity entry like any other claim-time denial. Runs that
pass are admitted under issue -> run locks at dispatch and handed off
synchronously while those locks are held.

A pack committed after the lock-free probe is observed at the next admission
point. Only native runtime runs have one after dispatch (the native operation
admission before provider operations). Legacy adapters and adapters that do
not run through the native runtime have no further evidence check after the
dispatch admission.

The pack does not name or bind an executor. Whoever is the assignee at an
admission point may execute, provided the required reviews are independent
of that agent: the executor (like the pack and artifact authors) cannot count
as one of the required reviewers. Authoring the pack or its artifacts does not
by itself prevent an agent from executing.

## Denials are terminal

An `evidence_pack_*` denial at claim, at dispatch or in the run's start
admission cancels the run with that code as `errorCode`, suppresses immediate
recovery (no repair/continuation run) and records a
`heartbeat.evidence_denied` activity entry (`entityType: heartbeat_run`,
`details.code`, `details.issueId`). The entry is written only when the denial
itself cancelled the run. A claim-time denial is not retried on the next
queue pass; this includes conditions that may clear later
(`evidence_pack_prerequisite_open`, `evidence_pack_review_missing`,
`evidence_pack_condition_open`). A corrected pack is picked up by a new wake.

A denial at the native operation admission (after dispatch, before a provider
operation) is handled differently: the native runtime classifies it as the
permanent failure code `evidence_pack_denied`. The run ends `failed`, the
issue is set to `blocked` with a board-owned recovery action, and no
`heartbeat.evidence_denied` activity is written.

## Native source-scoped recovery-action runs

A native run of the owner woken with `source_scoped_recovery_action` is
claimed without becoming the issue's execution run (`executionRunId` is not
set). On an opted-in issue it passes the claim and dispatch admissions and
records an `evidenceAdmission`. The evidence operation admission would refuse
it (`evidence_pack_run_mismatch`, because it requires the run to be the
issue's execution run), but it is not reached today: the native wake-attachment
staging applies the same execution-run requirement first and fails the run
(`adapter_failed`, `paperclip_runner_attachment_staging_not_authorized`), with
or without a pack. Mention runs of other agents on opted-in issues are refused
at claim (see above). Both are recorded by tests as current behavior.

## Reviewer versus executor admission

A current native completion-review assignment is a separate admission purpose.
The server resolves its interaction, applied status decision, source run, current
issue status/version, independent addressee and resolver policy. Context IDs or
an `evidenceReviewer` caller flag do not confer authority. This allows the
assigned reviewer to run before the votes needed by the productive executor
exist. Reviewer runs receive `evidenceReviewerAdmission`, not
`evidenceAdmission`; losing or replacing their assignment cannot convert that
run into an executor. Native review permissions and document-bound interaction
resolution remain independently enforced. For opted-in issues the
assignment is rechecked at handoff while the issue execution ownership is
locked. The reviewer admission recorded at claim survives the legacy
runner-profile reset, so a revoked reviewer is refused as such
(`evidence_pack_reviewer_assignment_changed`) and never re-evaluated as an
executor.

## Policy governance

Changing the evidence binding (including removing it, reducing exclusions or
rebinding its revision/receipts) requires server-authenticated board-user
attribution. An agent's responsible user is not board authorization. The issue
service checks the current binding under the issue row lock and records
`issue.evidence_policy_changed` in the same transaction as the policy update.
Denied agent mutations return `403` with
`details.code = evidence_pack_governance_required`. Unrelated execution-policy
changes that preserve the binding do not require this extra authority.
Removing a gate together with `status: in_progress` still cannot bypass the old
execution authorization: both stored and replacement policies are checked.

## Test coverage

The local tests exercise an actual heartbeat with a registered in-process test
adapter, native review assignment records and document-bound vote resolution.
They also exercise authenticated agent PATCH followed by checkout against a
throwaway PostgreSQL database. They do not run an external provider.

## Revalidation before provider operations

`revalidateEvidenceOperation` binds company, issue, agent and run from the server
execution input. For opted-in issues (or runs with a recorded admission) it
rechecks current ownership and running state under issue then run locks; a
no-pack run is not locked, ownership-checked or denied (opt-in invariant). It
reuses the current evidence policy/revision/context/DB-clock and
trusted-review-purpose validation, including no-pack late opt-in. Its
transaction ends before any provider call.

The native runtime invokes it (`onOperationAdmission`) after all asynchronous
preparation and immediately before every effectful provider operation:

- fresh session bootstrap and the fresh/resumed task `startTurn`;
- retained (warm) session `attachRun`;
- provider `recoverSession`, and again before a governed replacement session;
- both restart-continuation `startTurn` paths (checkpointed interruption and the
  live `turn.failed` continuation during event consumption);
- goal controls that grant provider work (`create`, `edit`, `replace`,
  `resume`) and the goal-resume heartbeat of an active goal. `pause`, `clear`
  and the read-only `get` of a non-active goal are not re-gated: they only
  reduce or observe provider work, so evidence invalidated after the run's
  recovery admission does not block them. The run that carries such a control
  still passes the ordinary claim, dispatch and recovery admission; if the
  pack is already invalid at that point, the control run is denied like any
  other run (fail closed).

Fresh, replacement and recovery inputs also carry the callback into the
backend. The Codex driver invokes it after process start/initialize/history
reads and before the effectful `thread/start` or `thread/resume`; the local
Process transport writes that request synchronously. The admission is awaited
under the bootstrap cancellation, so a pending admission never delays Stop.
A recovery-time denial is
propagated as the denial, not as `recovered: false`, so it can neither open a
replacement session nor be classified as a retryable recovery failure.
An evidence denial is classified as permanent (`evidence_pack_denied`, no
automatic provider retry). A denied retained session is never attached to the
new run.

Local tests use real `executeNativeSession` with a Promise-delayed backend and
real isolated database admissions for the fresh, retained-attach and recovery
paths. They prove null provider dispatch after policy removal/rebinding/late
opt-in, document/context revision changes, expiry, cancellation or
execution-owner loss, and exactly one turn for valid/no-pack controls. Runner
tests cover replacement, both restart continuations and the goal paths; Codex
driver tests delay initialize/history reads and observe the fake transport.

Limits: this is a service boundary, not an RPC lease: a change committed after
the check but before the provider receives the request is not observed. Other
backends (OpenCode, ACPX, remote runnerd) are protected by the runtime-level
checks before each call, but do not invoke the callback at their own internal
effect boundary. Mid-turn runtime-request responses and per-tool scope are not
evidence-gated. No live provider was exercised.

Same-turn steering (`steerNativeSession`, queued comment delivery into the
active turn) is deliberately not evidence-gated. It neither opens a session
nor starts a turn: it adds a message to a turn that was already admitted,
equivalent to the agent reading the same comment through the API during that
turn. Gating it would require holding subject document share locks while
awaiting the provider acknowledgement inside the queue transaction (the run
row cannot be locked there without blocking the ACK). Evidence invalidated
mid-turn is, as stated above, not enforced inside a running turn.

## Lock order

Admission resolves the subject issue the same way as its callers' lock helpers
(the run's context issue, falling back to its native issue), so it never takes
a second issue lock out of order; a run whose native issue differs from its
context issue is denied (`evidence_pack_run_mismatch`) when evidence applies.
Admission takes the subject issue row lock first, then its own heartbeat run.
After that it may share-lock only rows scoped to the subject issue (its
documents/revisions and its interaction receipts); every subject-scoped writer
either locks the issue first or never waits on the issue. Rows owned by other
issues (prerequisite issues, condition proofs and receipts on them), other
heartbeat runs (reviewer runs) and agent rows are read without row locks. A
writer holding such a foreign row and then locking the subject (for example
`syncBlockedByIssueIds` sorting `[prerequisite, subject]`, or run finalization)
therefore cannot form a cycle with an admission. Each read is still a current
committed snapshot; the admission is linearizable as happening before any
concurrent foreign change that commits later.
