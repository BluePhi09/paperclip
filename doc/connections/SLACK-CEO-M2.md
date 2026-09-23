# Slack CEO M2: bounded personal channel reads

This feature follows [the M1 DM pilot](SLACK-CEO-POC1.md). It is a single-company,
single-person, single-CEO, single-public-channel experiment, not a general Slack
connector rollout or an implementation approval system.

## Enable

Preserve the existing M1 configuration and bot scopes. Configure
`PAPERCLIP_SLACK_CEO_POC_READ_ENABLED=true` and
`PAPERCLIP_SLACK_CEO_POC_READ_CHANNEL_ID=<approved-public-channel-id>` on the
isolated server. Missing M1 identity/client configuration disables read access.

On the same internal Slack app, add User Token Scopes `channels:history` and
`channels:read` and register `<public-origin>/api/tools/oauth/callback`. Preserve
the bot callback. Do not enable public-client PKCE or change token rotation as
part of this pilot. The user approves a separate confidential personal OAuth
grant from an addressed Paperclip request; the settings-page reinstall flow is
not this connection flow.

In the app's **Agents** settings, enable **Slack Model Context Protocol (MCP)
Server** with the operator's permission. Do not enable the separate Agent
experience or add an external server under MCP Servers (the opposite direction,
which adds `mcp:connect`). This feature switch does not add OAuth scopes. A saved
grant can be retried on the same pending card after enabling it, without OAuth.

Slack grants these scopes across public channels; the narrower source-channel
restriction is enforced by Paperclip. Do not describe provider consent as a
single-channel grant. No personal token is passed to a model.

The callback verifies the newly issued token with Slack's fixed `auth.test`
endpoint before saving it or reading channel metadata. That endpoint needs no
additional scope. Both the documented nested user response and an RFC bearer
response are supported, but neither token type alone proves identity. The
authenticated user/workspace must match the existing DM link, bots are rejected,
and any identity fields in the OAuth response must agree. Actual granted scopes
must still be exactly the two approved read scopes; requested scopes are not
treated as proof. Failure codes distinguish format, person, workspace, app and
scope errors without logging tokens or provider-authored text.

The per-call `auth.test` scope header may additionally contain Slack's implicit
`identify` scope. That identity-only header scope is accepted; any other extra
scope or either missing read scope is rejected. No extra OAuth permission is
requested. See [Slack's scope documentation](https://docs.slack.dev/authentication/installing-with-oauth/#appending-scopes).
Omit `oldest`/`latest` in agent calls so the server applies its fixed seven-day
session window. Connection-intent continuation has one owner: the dedicated
delivery outbox, never a second generic chat interaction wake.

## Test

Ask the existing CEO DM to review the last seven days of the configured channel
and suggest up to three small fixes, with source links and uncertainty. Specify
discovery only: no editing, delegation, new tasks, PR or merge.

Expect one Connect Slack card in Slack and the canonical Paperclip task. The
link hands off automatically through the authenticated task to personal OAuth;
it must not require a second Connect Slack click in Paperclip. Sign-in is still
required if the browser has no session. The credential-free interaction suffix
must survive UUID-to-identifier and company-prefix redirects. Consume it once
before starting OAuth; settled requests, different addressees and ordinary task
visits must not start authorization. After the user
approves, the existing durable intent delivery resumes the original request.
The answer keeps its original audience. On legacy v1 tasks, the normal Paperclip
composer stays internal and Reply via Slack opts in to that turn's Slack reply.
On threaded v2 tasks, the normal composer shares request and answer by default;
use the separate human-only Internal notes editor for non-agent notes. Not now
in Slack opens the board card for decline.

`ensure_capability` supports `slack.read_channel` and `slack.read_thread` only.
Its public states are CONNECTED, AUTH_REQUIRED and UNAVAILABLE. Search is
intentionally unavailable. Only `slack_read_channel` and `slack_read_thread`
with reviewed explicit channel/window/limit schemas may execute. Unknown live
schemas fail closed and require review before broadening the adapter.
The live schema reviewed on 2026-09-22 uses `channel_id`, `oldest`, `latest`,
`limit`, `cursor`, and `response_format` (`detailed` or `concise`). Thread reads
add required `message_ts`, not `ts`. Both calls receive bounded time windows;
thread roots must also be inside that window. Structural fixtures match these
live schemas. The pilot caps thread page size at 100 even if Slack permits more.
The gateway sends fractional Slack timestamps even for whole-second boundaries
(`seconds.000000`). A live test showed integer-string bounds could return only a
parent with misleading no-more-messages metadata. Preserve caller fractional
precision without converting timestamps through floating-point formatting.

The gateway enforces the configured channel, seven-day window, at most 200
requested message records and 30 thread calls per human turn. Failed calls
remain budget reservations. Threads rooted before the window are excluded.
Report partial coverage; do not claim an exhaustive scrape.

## Recovery and shutdown

Accepted intents use the existing persistent delivery worker and unique wake
key. Execution and publication recheck identity, membership, delegation and
conversation generation. A saved grant with failed catalog discovery can be
reconciled by retrying Connect on the same pending card without another OAuth
approval; this pending-intent repair is not a new background sweep.
An authorization page left open for more than the state's ten-minute lifetime
must be restarted from the same pending card. It does not create another task.

Disable `READ_ENABLED` to stop M2 without disabling M1. This does not revoke a
Slack grant. Do not rotate/revoke the existing bot token to reset a read test.

## Verification

September 23 handoff correction: the task's canonical-URL redirect was dropping
`/connect-slack-read/:interactionId` from the actual UUID-based Slack link. The
redirect now preserves an unconsumed suffix and does not restore one already
consumed by the card. Regression tests reproduce the old failure and exercise
UUID/wrong-company resolution followed by the real card's automatic start,
remount/StrictMode deduplication, ineligible audiences/states and explicit retry
after failure. All 154 tests in IssueDetail and ConnectionIntentInteractionBody,
UI TypeScript, token gates and the UI production build pass. Provider scopes,
OAuth state/session binding and continuation handling are unchanged. A new live
OAuth run is not claimed by these tests; do not reset a working grant just to
exercise this fix without the user's approval.

Deployed only to the isolated port-3210 pilot after rebuilding its UI. Live
browser smoke: TES-10's actual unprefixed UUID/interaction URL resolved to
`/TES/issues/TES-10/connect-slack-read/:interactionId` with the suffix intact.
Its already-accepted card stayed connected and did not start another OAuth flow.
The browser was returned to the ordinary TES-10 URL; no grant was reset.
Subsequently, at the user's explicit request, only the personal channel-read
connection was removed through Paperclip to prepare a fresh-consent retest.
The CEO chat connection remained active; the user-led fresh OAuth test is pending.

See [the implementation plan](../plans/2026-09-22-slack-ceo-read-discovery.md)
for the current automated/live split and provider references. Run
`slack-read-profile.test.ts`, `slack-read-discovery.test.ts`, connection-intent
service/routes/UI tests, and the M1 OAuth/reply/lifecycle/publication regressions.
The database tests use a simulated provider, not the normal Slack workspace.
Real user OAuth, exact upstream tool schemas, bounded reads, second-request reuse
and live restart recovery remain required before declaring live M2 acceptance.

### September 22 live follow-up

After the timestamp correction and an isolated server restart, the normal
governed path returned 20 actual replies plus their parent using a saved grant.
Run `9dd42610-01f7-46ff-8889-44ac28bf9f88` settled TES-2 to Idle. Publication
`fa4a20e5-0be3-4be6-a646-1780890a7d18` reached Slack in one attempt.
A controlled signed replay of an already-processed DM message returned 200 with
no increase in tasks, runs, deliveries or publications. This is not a naturally
observed Slack retry.

At 22:41–22:50 PDT, the user approved resetting only personal reads. The real
removal/reconnect path exposed and fixed retained-application uniqueness handling;
old credentials remain revoked, and foreign-owner applications cannot be adopted.
The pending request survived the pilot restart. The user approved fresh OAuth;
run `4e45ba40-7d64-46e8-8dd9-da927a0dc838` resumed the original request and read
five messages. Publication `8913ab75-0328-4581-a448-d8f9b07dc86c` reached Slack
in one attempt and TES-2 returned to Idle. A crash immediately AFTER OAuth
acceptance, before wake delivery, remains a separate live test.

At that earlier checkpoint, 110 focused tests and direct server typechecking passed. M2b was planned in
[threaded research](../plans/2026-09-22-slack-ceo-threaded-research.md). Its v2
permission definitions are tested but not admitted by existing v1 OAuth/runtime
entry points. Do not add scopes to the app until its upgrade path is ready.

A subsequent backend checkpoint added a generated legacy-default thread-binding
migration and saved activation cutoff, exact originating-person/root checks,
and the shared-request outbox: v2 board requests must reach Slack before waking
the CEO. 227 focused tests and server/UI TypeScript checks pass. The new mode is
not activated; no live migration, new scopes or UI changes have been applied.
See the threaded-research plan for the remaining UI/privacy/research work and the
two broader integration failures also reproduced against committed code.

### Current threaded-DM preview

The narrow preview is now deployed on the isolated authenticated pilot after a
private database backup and migration 0284. The new **Enable threaded DMs**
button starts an explicit same-identity bot OAuth upgrade, adding only
`reactions:write`; user consent and exact validation must succeed before activation.
Personal reads and old conversation bindings are unchanged. New top-level DMs
after activation get one task/thread, a deduplicated eyes receipt and editable
working status. Both native and legacy ACPX runs can supply safe coarse progress;
tool updates are coalesced, and short runs may only show working then the answer.

For new v2 bindings, the normal Paperclip composer now shares request and answer,
with an explicit destination disclosure. Shared requests are text-only and use
the existing durable outbox; the CEO starts only after Slack confirms delivery.
Separate **Internal notes** are human-only, stored outside task comments and
agent context. Earlier comments/drafts are not retroactively sent. The general
Tasks list now includes Idle conversations without changing dashboard attention
or execution behavior. Explicit child-task linkage and historical screenshot
research remain unfinished. This is not full M2b acceptance. Earlier focused verification includes
291 tests in 11 suites and 34 selected integration checks, plus server/UI/adapter
typechecks and the UI build. The bot upgrade has now completed: live status shows
active v2, reactions enabled and cutoff `1790145683.516000`. Real threaded Slack
acceptance began with a real post-upgrade DM. A callback channel-ID mismatch was
found and corrected (namespaced SDK ID versus bare provider ID); 38 targeted
checks and server typechecking pass. TES-4 now provides live proof of one eyes
receipt, one threaded working message, and an in-place final answer. Eyes are
removed on completion. Subsequent live checks verified same-thread continuity on
TES-4, a separate TES-5 root, labelled Paperclip request plus answer through Reply
via Slack, and “CEO is using tools…” followed by a final answer in the same thread.
At the subsequent September 23 checkpoint, migration 0285 was applied after a
private backup. A live normal-composer request and its answer both reached the
TES-4 thread, each in one publication attempt; the task returned to Idle.
TES-4/TES-5 are visible in Tasks. A saved Internal-note canary did not enter
comments, Slack publications, wakes or activity, including after that shared run.
186 focused tests, server/UI typechecks, token gates, UI and Storybook builds
passed. Full visual-baseline acceptance remains unrun. Notes are in database
backups; their API/context isolation is not a sandbox against host/database
administrators. No extra OAuth consent was needed for these UX fixes.

Implementation, coding-worker approval, artifacts, GitHub and merge are later
milestones. Discovery guidance is not a security boundary for every CEO tool.
