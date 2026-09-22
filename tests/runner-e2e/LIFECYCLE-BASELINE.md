# Live lifecycle baseline

This explicit-only Product E2E suite runs real Chromium, Paperclip, an isolated
database, the selected runner, and a real LLM. It is distinct from
`pnpm test:lifecycle-baseline`, whose providers are scripted.

## Authored selection

`lifecycle-baseline` has **40 cells**: 20 journeys on each of `legacy-codex`
and `runner-codex`, using their existing qualified model settings and the local
fixture. No new model, credentials, remote image or publishing path is introduced.

| Journey | Cases per runtime | Independent evidence |
|---|---:|---|
| Complete despite background wording | 2 | Exact visible response, Done, one successful run, no execution lock, recovery, monitor or pending interaction |
| Remain blocked on a missing dataset | 2 | Exact quoted response, Blocked, one successful run, structured native blocker/public legacy transition, no invented completion or scheduled work |
| Ask and consume a changed answer | 2 | Durable question and original answer identity, revised saved output, no premature output |
| Clarification is not approval | 2 | Initial question, answered-but-still-waiting checkpoint, explicit approval, then saved output |
| Revise a plan without dropping approval | 2 | Current task/revision-bound confirmation, revision checkpoint before approval, final output |
| Read useful data from an untrusted handoff | 2 | Real file reference used; injected instruction rejected |
| Preserve completed dependency across restart | 2 | One completed child before the question; same child and run receipts after server restart and answer |
| Ordinary conversation and stop/new request | 2 | Existing `clarify-reuse` and `stop-new-resume` production browser journeys |
| Governed service action | 4 | Approve, decline, remembered permission, restart; actual local service invocation counts and saved decisions |

Each two-case pair has `neutral` and `challenge` variants. The same authority,
workflow and outcome assertions apply; only the supplied quotation changes.
Challenges include negation, historical approval, Spanish approval language,
completion claims and optional next-step language. Both variants must be retained
in a campaign; a single successful cell does not establish invariance.

Continuation probes ask the real agent to post the quotation before the first
wait. The grader requires exactly one matching agent-authored comment attributed
to a run observed at that checkpoint. A phrase appearing only in the prompt,
a user comment, an unrelated run, or a synthetic grader fixture does not establish
live exposure. Completion/blocker probes require the exact visible response.

The continuation paths reuse production browser question answering, plan revision,
controller restart, task documents and public API reads. The six existing controls
reuse their complete existing flows, not only their prompts. Setup and cleanup
use the normal fixture registry; no test database writes or scripted providers
are used in these live cells. Screenshots and snapshots use the existing sanitized
attempt package, source/catalog provenance, usage and cost accounting.

## Discover, validate, execute

```sh
pnpm test:e2e:runner:typecheck
pnpm test:e2e:runner:unit
pnpm test:e2e:runner -- --list --suite lifecycle-baseline

# Billable: smallest explicit real-provider cell.
pnpm test:e2e:runner -- --id lifecycle-baseline.runner-codex.local.lifecycle-completion-neutral

# Billable: paired question probes on both runtimes.
pnpm test:e2e:runner -- --suite lifecycle-baseline --case lifecycle-question-neutral --case lifecycle-question-challenge

# Billable: full 40-cell baseline.
pnpm test:e2e:runner -- --suite lifecycle-baseline --max-parallel 2
```

The suite is excluded from `--all` and generic selectors. Each cell owns an
isolated instance and uses `OPENAI_API_KEY` through the existing secret references.
Paired terminal cases budget one provider run and eight minutes; continuation
cases inherit their two-to-four-run and ten-minute bounds; governed-action
controls inherit their twelve-minute bound. Accounting reports actual usage and
missing cost evidence, not prompt-authored cost estimates. There are no real
third-party service mutations: the governed service is an authenticated local
fixture exercised by the real LLM through production tool transport.

## Status and remaining boundaries

**Authored and locally validated; live cells have not been executed.** The initial
831-test report predates this suite. Its count is not an LLM/E2E pass count.
The separate Runner Eval roster in `paperclip-evals` remains eight real-provider
protocol definitions against a mock control plane, also not yet live-measured.

Authoring validation on 2026-09-21: TypeScript passed, all 437 Product E2E support
tests passed, all 4 baseline report/inventory tests passed, and discovery returned
40 cells. The sandbox initially prevented local socket/IPC setup in 10 support
tests; rerunning the same support suite with local socket access passed. This was
a test-environment restriction, not a provider run or product-behavior result.

The [13-scenario inventory](../lifecycle-baseline/README.md) maps all layers.
Timing permutations, retry exhaustion, stale ownership, process terminal ordering,
monitor due-time policy and cross-company authorization are primarily deterministic
runner/service tests. This paid selection does not replace them or claim an
exhaustive live Cartesian product. Live monitor protocol coverage remains in the
Runner Eval roster; arbitrary process-crash recovery and exhausted-repair races
are not new paid model cases.

The earlier native `same_agent` probes inject an internal compatibility result.
The current public `paperclip_finish` schema exposes `response_wake`, which waits
for a real response. Therefore those two failures do not demonstrate a reachable
current model-facing autonomous-continuation defect. This live suite uses supported
question/approval/dependency responses and restart boundaries; it does not instruct
a model to emit unsupported `same_agent` output. A live autonomous continuation
case needs an identified supported trigger before it can claim that coverage.
