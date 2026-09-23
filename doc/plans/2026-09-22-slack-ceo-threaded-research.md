# Slack CEO M2b: threaded, repository-backed research

Status: narrow threaded-DM preview deployed and activated; live roots, follow-up,
shared normal composer, isolated human-only notes and coarse tool progress verified. Full
M2b remains incomplete. Continue `codex/slack-ceo-poc1`,
not the independent `codex/connection-capability-092226` checkout. Starting
commit: `91339784ce9a740c149b34f013a1e29e7e7febdc`.

## Current checkpoint: threaded-DM preview

The user's immediate request is to test a new Slack DM with a receipt, its own
thread and editable status. The isolated port-3210 pilot now runs this narrower
preview. Its database was backed up privately before applying migration 0284;
the main instance, old task history and personal read grant are unchanged.
The explicit bot upgrade completed successfully. A read-only live check confirms
active `ceo-dm-threaded-v2`, reactions enabled and fixed cutoff
`1790145683.516000`. Only new roots after that cutoff receive the preview behavior.

`Enable threaded DMs` starts a browser-session-bound, ten-minute OAuth upgrade
from the five-scope bot profile to those same scopes plus `reactions:write`.
The callback verifies exact scopes, app/team, installer, bot, current linked
person/membership, configuration, credential fingerprint and runtime generation.
Only then does one transaction save credentials, enable reactions, advance the
generation and freeze the activation cutoff. Declined, stale or changed-identity
upgrades cannot activate v2. No personal `files:read` upgrade is included here.

New roots after activation get separate tasks and threads. Existing roots keep
their original behavior; TES-2 is not migrated. Durable acceptance queues one
deduplicated eyes reaction. The publication worker posts/edits one status lane in
the exact thread. Native progress remains supported; the pilot's legacy ACPX
runner now emits a payload-free tool activity signal, coalesced at 20 seconds.
Short turns can go straight from working to the final answer. Never promise
individual grep/command names or expose raw arguments, reasoning or paths.

For v2, the normal Paperclip composer now uses the existing shared-request outbox:
the labelled request reaches the exact Slack thread before the CEO wakes, and
its answer returns there. The composer discloses sharing and is text-only; task
file attachments are not yet supported. Its new, audience-specific draft key
does not restore earlier internal drafts. The redundant v2 **Reply via Slack**
box is removed; legacy TES-2 retains its original explicit-reply behavior.
Separate **Internal notes** are available to signed-in company members, never
through agent/API-key access or normal task context/search/publication. Existing
ordinary comments are not migrated into this store and remain agent-readable;
they are not retroactively posted to Slack. Explicit child-task binding,
historical scan storage and screenshot inspection remain future M2b work.

Verification: 291 tests across 11 focused suites; 34 selected chat integration
checks; server/UI/adapter-utils TypeScript checks; token gates and UI build pass.
A separate 277-test selection also covered the full ACPX execution suite and
new coarse-event projection (counts overlap; do not sum them). The two broader
integration failures reproduced against committed HEAD remain noted below.
Live UI inspection confirmed the upgrade button and preview disclosure. OAuth
returned to the connection management page and the live endpoint is now v2.
Real reaction/thread/status acceptance is recorded below.
Earlier checkpoint paragraphs below are history,
not the current deployment/activation status.

### Real-adapter admission correction and first live thread

The first post-upgrade user messages failed before durable admission with HTTP
503: the real Chat SDK callback exposes `thread.channelId` as `slack:D…`, while
the v2 boundary/schema expects the bare provider `D…` ID. Initial service fixtures
used bare IDs and missed this seam. Admission now uses the existing canonical
provider-resource helper; v2 delivery persistence, lookup and task binding use the
same canonical ID. Legacy rows remain unchanged. Tests now assert the pinned
SDK's real callback shape and exercise namespaced channel IDs through upgrade,
receipt/progress, separate roots, same-task replies, dedupe and reconstruction.
38 targeted tests and server TypeScript checking passed. Restarted only the pilot.

At 23:49 PDT, a harmless real Slack DM created TES-4, conversation
`1d7fb359-3e75-42ea-8387-d44a1fd68f3a`, root `1790146187.647289`.
Run `5b09a14c-068d-4acd-80b4-86ebb89198f2` succeeded. The eyes receipt was added
successfully at 23:49:49 and removed at completion, per the existing receipt
lifecycle. Publication `ee1a2bb7-6132-4b89-9948-77750a5ad13e` posted “CEO is
working…”; `2f128078-978a-40f1-aae0-d49aaa600783` changed the same Slack message
`1790146190.036889` to “Thread test passed.” Both had one successful attempt.
The real Slack UI showed one reply under the exact root, not a flat-DM answer.
No synthetic replay was used for this acceptance result. Earlier failed messages
were not admitted at the time of failure; one subsequently arrived as a provider
retry and created TES-5 after the admission correction.

### Subsequent live checks and next UX work (September 23)

- Same-thread follow-up stayed on TES-4 and correctly recalled the first request.
  Run `096c8008-ee05-46df-b3b8-0ec60b859196` published once under the original root.
- A distinct root created TES-5, with its own conversation and reply. No manual
  event replay was used to create either task.
- Explicit Reply via Slack on TES-4 shared the labelled human request and CEO
  answer in the same thread. Run `e93225a4-6e5b-4f12-8f01-358c4f0dc6ec` succeeded;
  request and final publications each had one successful attempt.
- User screenshots show the receipt, “CEO is using tools…” and its final answer
  in the same thread during a real read-only channel request. The answer reported
  13 channel posts and 12 replies across three threads; this is reported coverage,
  not an independent audit of those upstream reads. Attachments were not examined.

These checks exposed three immediate UX fixes, completed in the following checkpoint.

### Shared composer, Internal notes and Idle visibility (September 23, 00:28 PDT)

Pushed the prior threaded work as `fbcae3cd88da9decbea089e2c37eccc57f4145b1` to
`origin/codex/slack-ceo-poc1`, without a PR, before starting these fixes. The new
UX changes are local and running on the isolated pilot. A private logical backup
preceded generated migration `0285_abandoned_mentallo.sql` and server restart.

- The general Tasks list opts into Idle Slack conversations. Existing dashboard,
  review-attention and execution counts retain their prior default exclusions.
  Live Tasks inspection shows TES-2, TES-4 and TES-5 as Idle.
- Normal v2 composer submission uses the durable board-reply path, including
  request IDs, confirmed-send-before-wake and authoritative audience checks.
  Ambiguous responses preserve the request identity for retry; they never fall
  back to an ordinary internal comment. File attachments/reassignment are rejected.
- `issue_internal_notes` is a separate company/task-scoped table with idempotent
  human creation and paginated reads. Only an authenticated browser session plus
  current active membership can read it; viewers cannot write. Agents, board API
  keys and local-implicit actors cannot use the endpoint. Notes create no comment,
  task mutation, wake, activity-body copy, SSE payload or chat publication. One
  transactional content-free audit row records creation without a live event. HTTP
  logs/errors use content-free projections. This is an API/context boundary, not
  isolation from a host administrator or process with direct database access;
  database backups contain notes. Do not use this feature as a secrets vault.

Live normal-composer test on TES-4 at 00:26 PDT: run
`4824bbc0-3c38-4bc7-83f0-48bbf2d518fd` succeeded and the task returned to Idle.
Request publication `6a449038-d7a7-4e0c-8041-27845b264b0c` and final publication
`211b11b1-5388-482e-9699-8d3f071082bd` each succeeded in one attempt. The real
Slack UI showed the labelled request and “Shared composer test passed.” under
the original TES-4 root. A harmless Internal-note canary saved beforehand remained
absent from comments, publications, wakes and activity after that shared run.
Saving it alone did not start any run.

Verification: 186 tests across eight focused suites passed, including real
temporary-database note isolation, tenant boundaries, viewer/agent denial,
idempotence, timestamp-precise pagination, ordinary composer retries and lifecycle
regressions. Server/UI TypeScript, migration checks, token gates, UI build and
Storybook build passed. Live UI inspection covered the notes dialog, shared
composer and Tasks list. Full visual-baseline acceptance was not run; the broader
baseline failures below remain. This is not a full-release or full-M2b claim.

Next: durable explicit new-task announcement/binding, then resumable historical
reads and actual screenshot inspection, followed by pinned read-only repository
assessment. TES-3 remains unlinked; do not infer authority from its prose source
link. No implementation, delegation, PR or merge workflow is enabled here.

## Current evidence and immediate repair

M1 works with a real CEO, Slack DM and canonical Paperclip task. M2 has a real
personal grant, channel reads, automatic continuation and durable final-answer
publication. The September 22 live recheck reproduced parent-only thread reads.
The gateway supplied whole-second timestamp strings. Normalizing whole seconds
to Slack's fractional `seconds.000000` format returned all 20 known replies
through the normal governed path after an isolated server restart. Preserve the
original precision of explicit fractional timestamps. No access limits change.

Final verification run: `9dd42610-01f7-46ff-8889-44ac28bf9f88`; one published
reply `fa4a20e5-0be3-4be6-a646-1780890a7d18`, one attempt, existing grant, task Idle.
This proves saved-grant reuse after restart, NOT a crash at the accepted-OAuth
boundary. Fresh consent/restart and live duplicate delivery remain separate
acceptance checks; simulated test coverage is not live evidence.

Subsequent controlled signed replay of a processed DM returned 200 and changed
none of the counts (3 issues, 31 runs, 26 publications, 6 deliveries). This tests
the live application's duplicate path with an existing message identity; it is
not a naturally occurring Slack retry. The durable duplicate counter became 1
at `2026-09-23T05:26:31.310Z`. No additional message was submitted.

Implemented foundation: exact versioned permission contracts in
`slack-ceo-permission-profiles.ts`, used by existing v1 bot/read validation with
unchanged scopes. v2 remains unavailable at current OAuth/runtime entry points.
110 tests across five files and direct server typechecking passed.

### Fresh consent follow-up (22:41–22:50 PDT)

With the user's explicit approval, removed only the personal read connection
through the normal UI; the bot remained active. This revealed a reconnect bug:
removal archives the empty application but preserves its unique name/key, and
`startSlackRead` tried to create the same application again. Fixed by validating
and reusing the same company's/person's exact pilot application, restoring only
its catalog container. Old connections/grants/profiles stay revoked or archived;
the replacement cannot read before new consent. Foreign-owner/type/source/key
collisions fail closed. Regression tests use real removal plus the public
service path, with no live DB repair.

After the isolated server restart, the pending card survived. The user clicked
Allow on a fresh two-scope personal OAuth page. Intent
`1a8228c8-46fa-494d-ac52-95e6fc42b07b` was accepted; continuation run
`4e45ba40-7d64-46e8-8dd9-da927a0dc838` completed the original five-message test.
Publication `8913ab75-0328-4581-a448-d8f9b07dc86c` reached Slack in one attempt
(message `1790142571.581959`), and TES-2 returned to Idle. The restart was BEFORE
consent, not between accepted intent and wake delivery; that crash boundary
remains unverified live.

Threading implementation now includes an opt-in adapter boundary in
`chat-slack-dm-threads.ts`/`chat-sdk-runtime.ts`. Signed-message tests verify two
DM roots remain distinct, replies and outbound answers use the original root,
and edits/deletions use the same identity. Invalid roots fail closed; the legacy
default is unchanged. 95 adapter/thread tests passed. This option is deliberately
not yet selected by endpoint configuration: durable binding/version admission,
task creation, shared/private composer isolation and scope upgrade must precede
activation. No new reactions/files permissions were requested.

Combined verification after these changes: 207 tests across seven focused files
passed, direct server TypeScript checking passed, and `git diff --check` passed.
No full monorepo build or release/browser suite was run; this is an incremental
implementation checkpoint, not a PR-ready or M2b-complete claim.

### Durable thread and shared-request backend checkpoint

Generated migration `0284_amusing_bloodaxe.sql` adds a legacy-default binding
mode plus originating person/principal. Database constraints enforce DM/root
shape, matching channel, generation one and company-scoped principal ownership.
Existing rows are never promoted or republished. The migration was generated and
exercised in temporary test databases; it has not been applied to the live pilot.

The runtime can consume a saved `slackDmThreading: { version: 2, since }` setup
record. No public activation/upgrade endpoint writes it yet. Upgrade must save
the cutoff once and advance `runtimeGeneration` under the credential/endpoint
lock. Root timestamps before the cutoff keep the pinned adapter's old identity,
including retries and replies; compare timestamps as integer microseconds, not
floating point. Admission rechecks mode under the endpoint lock. New threads
keep their task after completion/restart; exact company/endpoint/person/root
receipts fence wakeups and publications. Legacy DM fallback cannot match a v2
conversation. Binding summaries now expose the persisted mode for future UI use.

For v2 bindings, the existing board-reply service atomically stages the human
comment, a shared-request publication and a durable wake request. The request is
labelled “From Paperclip (you)” and sent by the bot under the exact root. The CEO
does not start until all transport parts have confirmed provider receipts.
Retries reuse the same comment/action/publication. Changed text, revoked identity
or retargeted bindings invalidate transport and execution. Legacy board replies
remain answer-only. Tests cover the actual publication worker with a simulated
provider, not only direct database status changes.

Still required before live activation: wire the ordinary composer to this path;
store Internal notes separately from agent-readable task comments/history and
label them human-only; add the v2 upgrade/consent operation, receipts and editable
status, and explicit child-task announcement/binding. Merely skipping publication
of an ordinary comment is NOT internal-note isolation—the next shared run can
read the comment. No UI or live Slack permission change was made at this checkpoint.

Verification: 217 tests across the seven focused OAuth/read/reply/adapter suites
and 10 threaded-pilot integration tests pass (227 total). The integration tests
also exercise multi-part request publication before wake and exact board binding
summaries. Server/UI TypeScript checks and migration safety/numbering checks pass.
`pnpm -r typecheck` stops at missing `cargo`; no full build claim.

A broader chat integration run passed 1,028 tests and failed two existing cases:
“does not duplicate an inbound file when delivery recovery resumes after the task
mutation” and “materializes direct external-chat finals once and accepts the next
turn without agent bookkeeping writes.” Both fail identically in isolation and
with a read-only Vitest loader restoring committed `HEAD` versions of all modified
tracked TypeScript modules, including the original test file. The comparison did
not reset or modify the checkout. This is not a fully green repository baseline.
Run broad tests with `PAPERCLIP_SLACK_CEO_POC_ENABLED=false` and
`PAPERCLIP_SLACK_CEO_POC_READ_ENABLED=false`; dedicated pilot fixtures opt in.
Otherwise the isolated live configuration's environment defaults incorrectly
apply DM-only rules to unrelated Slack test fixtures.

The running port-3210 authenticated pilot still reports healthy. No restart,
live migration, activation, permission expansion, commit, push or PR was performed
for this checkpoint. Current next coding step is the shared composer and isolated
human-only notes, not another OAuth reset.

## User-approved behavior

- One 👀 receipt after durable acceptance. Subsequent responses and one editable
  status message belong under the original top-level DM message.
- Explicit new-task requests inside a thread create one separate announcement/
  thread and canonical task, with links between them.
- New threaded tasks mirror normal composer messages and CEO answers. An
  Internal note option remains private, including from later shared run context.
- Read all history still available to the linked user in **only** the configured
  public #papercuts channel, all replies, and inspect actual screenshot images.
- Compare each report to a pinned latest `origin/master` snapshot. Report
  easy/difficult/unsure with author/date/source/reason; resolved reports separate.
- No implementation, coding delegation, PR, push or merge in this milestone.

## Five steps and integration seams

### 1. Contract, versioning and migration

Update the authoritative user spec and this plan. Keep the isolated test10/TES
company, CEO, app, workspace, Tailscale origin and database. Current v1 tasks stay
private-by-default: never backfill previously internal notes into Slack.
Conversation sharing is versioned independently from OAuth permission profiles.
No authority is inherited just from an issue's parent or a prose source link.

### 2. Threading, receipt, progress and shared composer

Reuse `chat-channels.ts` durable ingress/actions/deliveries, `chat_conversations`
and `chat_message_links`, `chat-slack-receipts.ts`, the SDK adapter and existing
publication workers. Add a persisted conversation mode and immutable root; use
generated DB migrations if the schema needs fields. All lookups retain company,
endpoint, person, exact thread and session-generation constraints.

- Normalize top-level DM `ts` versus reply `thread_ts` before delivery identity
  and task lookup. Preserve root precision; reject cross-channel mismatches.
- Audit the SDK's DM flattening plus `reactionConversationThreadCondition` and
  other DM-wide fallback paths. v2 must not route a missing thread to TES-2.
- Reuse the receipt outbox only after a v2 token verifies `reactions:write`.
- New-task creation is an idempotent server action bound to the linked human's
  accepted request, not model-supplied identity. Separate root announcement is a
  recoverable publication; hold Slack-dependent execution until linked. Do not
  synthesize a fake inbound Slack event to satisfy authorization.
- Extend `slack-board-replies.ts` with explicit per-turn audience and routing;
  retain v1 compatibility and precise wake/run/final-answer receipts. Wire the
  normal composer to this path only for new shared bindings. Internal notes use
  an isolated runtime context or are excluded from all shared runtime inputs.
- Extend `chat-run-publications.ts` and the existing safe progress map into an
  editable status outbox keyed by conversation/generation/turn. Coalesce updates,
  honor Retry-After, reject stale updates, always reconcile terminal states.
  Render only allowlisted phase labels, never tool arguments or reasoning.

### 3. Pinned repository assessment

The pilot remote is `https://github.com/paperclipai/paperclip.git`. TES-3 is
currently projectless and has no Slack binding; don't relabel it as connected.
Use supported project APIs/UI to configure one Paperclip project. Resolve and
record master SHA at scan admission and inspect an isolated clean snapshot.
Audit the actual Codex/acpx adapter's enforceable read-only mode before assigning
the CEO repository execution. A project path or prompt saying read-only does not
remove shell/Git credentials. If unavailable, use a narrowly governed read-only
repository tool path; do not quietly enable a write-capable worker.

Preflight: fetched master at `7944ed3d976d1a7cc26a2d0cee51f227f3542084` without
changing either checkout. The live CEO is `codex_local` with no explicit engine,
permissionMode or filesystemScope override. `codex-local/src/server/acp.ts`
rejects local confinement; the default ACP permission mode is approve-all.
The CLI argument builder also defaults to approval/sandbox bypass unless
explicit restrictions are supplied. Do not infer a read-only boundary from the
task's wording. Project attachment/snapshot execution are deliberately not yet
enabled. Prefer a task-scoped enforced policy, not a global CEO permission change.

### 4. Resumable history and screenshot evidence

Replace the current per-human-request 200-requested-record budget only for the
new historical scan path, not by globally disabling `slack-read-budget.ts`.
Create a durable scan with fixed cutoff, authority generation, cursors for channel
and every discovered root, deduped source records, image provenance, inspection
results, bounded batch leases, cancellation and retry schedule. Checkpoint pages
atomically; reconcile duplicate pages; retain partial coverage on errors.

Gateway checks in `slack-read-profile.ts`, `slack-read-access.ts`, `tool-gateway.ts`
and continuation in `slack-read-intents.ts` still validate current company,
linked human, workspace, grant, CEO, task and original audience. Revocation stops
new batches/publications. A moved destination requires a new binding, not a scan
fingerprint rewrite. Provider tool schema drift fails closed.

Screenshot ingestion requires an observed file ID from a governed channel/thread
read in this scan. Validate that provenance at fetch time, then use the existing
private attachment/vision pipeline with byte/pixel/MIME/decode limits and safe
provider downloads. No arbitrary URLs, token forwarding across redirects, bot
files grant, uploads, PDF/video or unrelated files. A file name/URL is not image
inspection. Missing image evidence means unsure for image-dependent issues.

Report actual counts, inspected/uninspected screenshots, cursors/errors,
retention/access gaps and master SHA. Explicitly detect advertised replies versus
parent-only results. Full-history claims require complete coverage accounting,
not just a provider's single no-more-pages response.

### 5. Versioned scopes and real consent

Prepare exact profile definitions and tests first:

- `ceo-dm-v1`: existing five bot scopes, unchanged.
- `ceo-dm-threaded-v2`: those five plus `reactions:write`.
- `slack-public-read-v1`: `channels:history`, `channels:read`, unchanged.
- `slack-public-research-v2`: those two plus personal `files:read`.

Definitions do not enable features. Keep v1 entry points pinned to v1 until an
explicit upgrade API, manifest/validation/UI and runtime features are all wired.
Bind target profile/scopes in the OAuth transaction. Stage new credentials and
verify identity/scopes before swapping; failed/declined upgrades retain old
authority. Audit leases, stale callbacks and reconnect generation invalidation.
An active v1 bot currently cannot be reinstalled through the setup-only route;
do not relax that guard without implementing this upgrade contract.

Only after fixture tests pass, confirm the app configuration change, preserve
both callbacks, and let the user approve each final OAuth screen. Do not add the
broad adapter scopes or change token rotation, workspace settings or tunnel.

## Test gates

1. v1 compatibility, exact scope sets, unknown profiles, stale OAuth target and
   no automatic upgrades. Re-run existing read/identity/continuation tests.
2. Two roots/two tasks; same-thread continuity; explicit new task inside a thread;
   duplicate event/client retry/restart create one task/root/reaction/final.
3. Shared composer request+answer; private notes never publish or leak through
   subsequent shared context; audience and destination cannot mutate on retry.
4. Progress from real events, rate-limit/backoff, crash recovery, ambiguous send,
   complete/cancel/error terminal dominance and no raw tool data.
5. Old channel pages, threads with pagination, screenshot-only reports, missing
   images, parent/reply mismatch, provider drift, revoke-mid-scan and resumed
   batches. Prevent cross-company/channel/file/identity access.
6. Real screenshot analysis and pinned repository comparison; no implementation.
7. Fresh real consent -> controlled accepted-intent restart -> one continuation,
   then saved-grant reuse. Record fixture vs provider vs live-agent proof.

M3 (approve and fix) starts only after these exit checks, explicit user direction,
coding-worker selection and a verified implementation approval boundary.

## References

- `doc/connections/SLACK-CEO-M2.md` and `SLACK-CEO-POC1.md`
- [Slack MCP](https://docs.slack.dev/ai/slack-mcp-server/)
- [Thread replies](https://docs.slack.dev/reference/methods/chat.postMessage/)
- [Editable messages](https://docs.slack.dev/reference/methods/chat.update/)
- [Reaction permission](https://docs.slack.dev/reference/methods/reactions.add/)
- [Personal file access](https://docs.slack.dev/reference/scopes/files.read/)

These describe provider capabilities, not completed pilot functionality.
