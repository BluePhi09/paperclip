# Evidence-pack execution gates

Status: implemented and covered by local tests. Not yet exercised against a live provider.

An issue opts into execution authorization through `executionPolicy.evidencePack`.
The binding names the current `evidence-pack` issue document revision, exact
scope and native interaction receipts. Productive checkout/start and heartbeat
handoff validate the current documents, independent reviewer/run provenance,
conditions, prerequisite reviews, target context and database-clock expiry.
A completed review task is not itself an approval.

## Reviewer versus executor admission

A current native completion-review assignment is a separate admission purpose.
The server resolves its interaction, applied status decision, source run, current
issue status/version, independent addressee and resolver policy. Context IDs or
an `evidenceReviewer` caller flag do not confer authority. This allows the
assigned reviewer to run before the votes needed by the productive executor
exist. Reviewer runs receive `evidenceReviewerAdmission`, not
`evidenceAdmission`; losing or replacing their assignment cannot convert that
run into an executor. Native review permissions and document-bound interaction
resolution remain independently enforced. The assignment is rechecked at
handoff while the issue execution ownership is locked.

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
execution input, then rechecks current ownership and running state under issue
then run locks. It reuses the current evidence policy/revision/context/DB-clock
and trusted-review-purpose validation, including no-pack late opt-in. Its
transaction ends before any provider call.

The native runtime invokes it (`onOperationAdmission`) after all asynchronous
preparation and immediately before every effectful provider operation:

- fresh session bootstrap and the fresh/resumed task `startTurn`;
- retained (warm) session `attachRun`;
- provider `recoverSession`, and again before a governed replacement session;
- both restart-continuation `startTurn` paths (checkpointed interruption and the
  live `turn.failed` continuation during event consumption);
- goal controls that grant provider work (`create`, `edit`, `replace`,
  `resume`) and the goal-resume heartbeat. `pause`, `clear` and read-only `get`
  are not gated: they only reduce or observe provider work.

Fresh, replacement and recovery inputs also carry the callback into the
backend. The Codex driver invokes it after process start/initialize/history
reads and before the effectful `thread/start` or `thread/resume`; the local
Process transport writes that request synchronously. A recovery-time denial is
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

## Lock order

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
