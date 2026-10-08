# Evidence-pack execution gates

Status: local, partial implementation; not a release qualification.

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

## Qualification boundary and remaining work

The local tests exercise an actual heartbeat with a registered in-process test
adapter, native review assignment records and document-bound vote resolution.
They also exercise authenticated agent PATCH followed by checkout against a
throwaway PostgreSQL database. They do not run an external provider.

## A1 fresh-local operation slice

`revalidateEvidenceOperation` binds company, issue, agent and run from the server
execution input, then rechecks current ownership and running state under issue
then run locks. It reuses the current evidence policy/revision/context/DB-clock
and trusted-review-purpose validation, including no-pack late opt-in. Its
transaction ends before any provider call.

Fresh session startup now carries an in-process callback to the Codex driver.
The driver invokes it after initialization and before effectful `thread/start`;
the local Process transport writes that request synchronously. The normalized
runtime also revalidates after session setup, checkpointing and fresh-handoff
preparation, immediately before its fresh `startTurn`. An evidence denial is
classified as permanent (no automatic native provider retry), and the existing
runtime failure cleanup closes/quarantines the prepared session.

Local tests use real `executeNativeSession` with a Promise-delayed backend and
real isolated database admissions. They prove null fresh-turn dispatch after
policy removal/rebinding/late opt-in, document/context revision changes, expiry,
cancellation or execution-owner loss, and exactly one turn for valid/no-pack
controls. A separate real Codex-driver test delays initialization and observes
its fake transport's `thread/start` requests and cleanup. This is not a live
provider or a full native executor/lease integration test.

This remains PARTIAL A1, not a universal pre-RPC guarantee. Retained attach,
provider recovery/replacement, restart-continuation turns, goal resume, and
asynchronous operations inside other backends/transports remain unqualified.
In particular, forwarding a callback does not prove that every backend invokes
it at its final effect boundary. Those are open local implementation/verification
items, not merely missing live authorization. A4 is unchanged and remains open.

The heartbeat handoff alone is not a final provider-RPC boundary. Cross-issue
reviewer/writer lock-order qualification, broader source/test typegraphs and
full release/live qualification remain separate work. Passing this limited
fresh-local slice does not approve those paths.
