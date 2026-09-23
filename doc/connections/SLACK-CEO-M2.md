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
link hands off through the authenticated task to personal OAuth. After the user
approves, the existing durable intent delivery resumes the original request.
The answer keeps its original audience. A normal private Paperclip turn stays
private; Reply via Slack opts in to that turn's Slack reply. Not now in Slack
opens the board card for decline.

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

See [the implementation plan](../plans/2026-09-22-slack-ceo-read-discovery.md)
for the current automated/live split and provider references. Run
`slack-read-profile.test.ts`, `slack-read-discovery.test.ts`, connection-intent
service/routes/UI tests, and the M1 OAuth/reply/lifecycle/publication regressions.
The database tests use a simulated provider, not the normal Slack workspace.
Real user OAuth, exact upstream tool schemas, bounded reads, second-request reuse
and live restart recovery remain required before declaring live M2 acceptance.

Implementation, coding-worker approval, artifacts, GitHub and merge are later
milestones. Discovery guidance is not a security boundary for every CEO tool.
