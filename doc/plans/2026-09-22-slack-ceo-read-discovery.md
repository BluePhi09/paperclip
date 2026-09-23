# Slack CEO pilot M2 — read-only discovery

Base: `709ce8071` on `codex/slack-ceo-poc1`. M1 is committed and pushed.

## Acceptance boundary

An authenticated, linked pilot person asks their existing CEO DM to inspect the
configured public channel. Without a personal read grant, one addressed consent
card appears in Slack and Paperclip. Connect starts confidential user OAuth;
acceptance resumes the same task through the existing durable connection-intent
delivery. The CEO returns at most three source-linked suggestions, with coverage
and uncertainty. No implementation, candidate-task creation, push, PR, or merge.

The user confirmed that #papercuts is public and may be copied into the test
company's task history and supplied channel `C0BBRGPF3C3` in the Paperclip Slack
workspace. Verify it is still public before live reads. Do not change the existing bot's five scopes or approve OAuth
on the user's behalf.

## Smallest supported read surface

- Separate personal `slack-public-read-v1` grant; never reuse bot credentials.
- Fixed public source channel and workspace from operator configuration.
- Prefer `slack_read_channel` and `slack_read_thread` with explicit channel IDs.
  Workspace-wide and free-text provider search are not necessary for this pilot.
- Last seven days, at most 30 threads / 200 message records; expose partial
  coverage honestly. Exact provider schemas must be checked before live use;
  unsupported schemas fail closed rather than using guessed parameters.
- Request only public history and necessary public-channel metadata permissions.
- Reuse vault, OAuth state, connection/grant, catalog/profile/policy, gateway,
  addressed interactions, durable delivery, and chat publication infrastructure.
- Fail closed on changed identity, channel, session generation, assignment,
  membership, permissions, missing scopes, or disabled pilot/connection.

## Implementation sequence

1. Add tested pilot profile/identity/resource validation and capability contracts.
2. Bind addressed read intents and confidential personal OAuth to the existing
   linked Slack identity; persist verified scope/identity evidence with the grant.
3. Revalidate the same profile at readiness, completion, continuation and gateway
   execution. Preserve generic connection behavior with the pilot disabled.
4. Add direct board/Slack consent handoff and terminal card settlement. Preserve
   private ordinary Paperclip messages and explicit reply behavior from M1.
5. Add bounded discovery guidance and automated adversarial/recovery coverage.
6. Rebuild/restart only the isolated test instance. With user-approved provider
   configuration/consent, verify a real read, OAuth continuation, repeat reuse,
   and denied out-of-channel/write attempts. Report incomplete live proof plainly.

## Required regression cases

Wrong user/company/workspace, revoked link/grant, changing source configuration,
organization/agent identity fallback, excess scopes, absent catalog action,
schema drift, out-of-channel arguments, all write tools, pagination/budget escape,
OAuth replay/wrong session, saved token with unfinished intent, restart after
intent acceptance, duplicate continuation, declined consent loop, stale card,
private composer regression and duplicate final-answer prevention.

## Provider evidence

Verified 2026-09-22 against Slack's official documentation:

- [Slack MCP](https://docs.slack.dev/ai/slack-mcp-server/): internal apps are
  eligible; Streamable HTTP at `https://mcp.slack.com/mcp`; no DCR; confidential
  user authorization uses `/oauth/v2_user/authorize` and `/api/oauth.v2.user.access`.
- [OAuth](https://docs.slack.dev/authentication/installing-with-oauth/): bot and
  user grants are different, grants are additive, and workspace hints are not
  sufficient identity proof.
- [Slack's channel-summary guidance](https://github.com/slackapi/slack-skills-plugin/blob/main/commands/summarize-channel.md):
  channel reads followed by thread reads are sufficient for a bounded summary.

## Implementation and verification checkpoint

The profile, capability tool, personal OAuth binding, direct consent handoff,
durable continuation, audience preservation, gateway enforcement and shared
scan budgets are implemented. No database migration or new secret store was
needed. Search is deliberately unavailable; use only channel and thread reads.

306 focused tests passed across 20 files; final hardening passed a further
84-test focused run. Server/UI TypeScript checks, UI build and design-token
checks passed. Full-repository tests and the Rust-dependent full server build
are not claimed. Provider responses in integration tests are simulated.

A first live request exposed that resumed Codex sessions omit initial runtime
guidance and may use generic connection_request. Current pilot guidance is now
included in both task-context variants, and a generic Slack request from the
configured pilot routes through the same verified read profile. A subsequent
178-test focused run and server typecheck passed. The wrong generic test card
was declined and retained in history; no channel content was read by that run.

The next live request produced the correct read-only intent and reached Slack's
personal OAuth screen. Slack initially rejected its rich card: URL sanitization
stripped query/fragment routing and made both action IDs identical. The fix uses
a credential-free handoff path and keeps the sanitizer unchanged. Projection
and one-shot UI navigation tests cover this failure. The one definitely rejected
test publication was repaired and queued for retry under the same identity;
no ambiguous/successfully posted message was replayed. Final UI tests (25), UI
build and both direct TypeScript checks passed after this fix.
Slack then confirmed the corrected card published on its second attempt; the
first attempt posted nothing. Personal consent remains with the user, and no
real source-channel read or completed OAuth continuation is claimed yet.

The user approved adding exactly `channels:history` and `channels:read` to the
pilot app's User Token Scopes and adding `/api/tools/oauth/callback` on its
existing HTTPS origin. Those settings were saved. Bot scopes and its original
callback are unchanged. The user must still approve the personal OAuth grant;
real MCP schemas and an end-to-end channel summary remain live acceptance gates.

Saved-grant/catalog repair is retried by the existing pending card's Connect
action, without another provider authorization. Accepted-intent continuation
is background/restart durable. Slack's Not now link hands off to the addressed
Paperclip card for decline. M3 implementation approval is not implemented or
claimed by the discovery-only agent guidance.

Live callback follow-up: the first approval arrived after the ten-minute state
expiry and was rejected. A fresh approval reached token exchange, but the
combined token-format/identity guard rejected it before token persistence.
The old guard did not record which field disagreed, so an actual wrong identity
is not claimed. The callback now calls Slack's fixed `auth.test` endpoint with
the issued token and requires the linked person/workspace and non-bot identity.
It accepts both nested user and RFC bearer response envelopes while rejecting
conflicting supplied identity fields and excess scopes. Failure diagnostics
are fixed Paperclip-authored codes/messages, never raw OAuth responses.
See [auth.test](https://docs.slack.dev/reference/methods/auth.test/) and
[the user-centric OAuth flow](https://docs.slack.dev/authentication/installing-with-oauth/).
New fixtures cover both envelopes and prove identity failures cannot save a
grant or reach channel/catalog reads. A fresh live callback is still required.
The callback changes passed 92 focused tests across five files, the server
TypeScript check and `git diff --check`. The isolated server was restarted;
no main-instance configuration or Slack permissions changed in this follow-up.

The next timely authorization verified the linked Slack identity and exactly
the two approved personal scopes, then saved the grant. Catalog discovery
reported `slack_mcp_access_disabled`. With explicit user approval, enabled only
the app's Agents → Slack Model Context Protocol (MCP) Server switch. The saved
grant successfully fetched the catalog without another OAuth flow. The schema
gate then correctly stopped: the real thread argument is `message_ts`, not the
fixture's `ts`. Updated the mapping and structural fixtures, limited the optional
`response_format` to concise/detailed, and bounded both read tools' time windows.
95 focused tests across five files, server typecheck, and diff checks passed.
The isolated server was restarted; no scopes or bot permissions were changed.
Original-request continuation and the final Slack answer remain to be verified.

The accepted connection resumed the original request, but the agent supplied a
latest timestamp after the fixed session cutoff. Both reads were denied before
dispatch. Added server-window guidance to both runtime context and
ensure_capability, safe corrective errors, and bounded tool descriptions.
The same test exposed a second generic interaction wake which fell back to an
old inbound DM. Connection-intent terminal publications no longer enqueue a
generic chat wake; the chat worker also retires any legacy duplicate. The
dedicated connection-intent outbox remains the only continuation owner.
147 focused tests across seven files and direct server `tsc --noEmit` passed.
The package-level typecheck prebuild still requires unavailable Rust `cargo`.
Restarted only the isolated server and submitted a fresh read-only test.

The next live read reached runtime identity verification. `auth.test` proved
the expected user/workspace/non-bot but reported `identify` in addition to the
two requested read scopes. Accept only this documented implicit identity scope
in the runtime header check; no requested OAuth scopes changed. Tests retain
denials for missing permissions and any extra data/write scope. The follow-up
passed 57 focused tests and direct server typechecking. Reopened the failed
conversation task to In Review and submitted another bounded discovery test.

Live run `d6108be8-8a19-4640-b499-2037f9e42f3b` succeeded: the real MCP channel
read returned 18 messages, one thread read returned only its parent, and six
further thread calls were denied by the requested-record budget. The model
reported these limitations and three source-linked candidates. Slack confirmed
the final reply published once. No implementation/delegation/new task occurred.

The manually reopened In Review task then triggered an unnecessary review-path
recovery, which failed closed because it had no Slack reply receipt. A new
explicit Reply via Slack now transitions an eligible In Review task to Todo
under the existing task lock after approval/blocker checks, allowing normal
checkout and idle settlement. Do not relax lifecycle settlement to swallow
arbitrary In Review states: regression tests require preserving explicit review.
124 focused tests and direct server typechecking passed; isolated server
restarted for a no-new-reads continuity check. Budget guidance now recommends
small thread pages because the 200-record limit counts requested page limits.

The final live continuity check recalled all three candidate titles with no new
read call, produced one final answer and returned TES-2 to Idle. Prior failed
attempts remain in history. This proves connected read → source-linked partial
summary → original DM delivery and follow-up continuity; it does not claim
comprehensive thread coverage, a clean first-install UX on this already-linked
account, or M3 implementation/PR/merge approvals.
