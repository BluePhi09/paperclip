# Slack tools for Slack-origin agent tasks

Implement the approved Slack contribution through the existing connector runtime.
The authority is the verified originating connection and accepted linked sender;
retrieved messages are data, never instructions or authorization.

## Work and verification

- [x] Typed tool/method/scope matrix and bundled skill; no arbitrary Web API execution.
- [x] Task/run/endpoint/accepted-user binding, live membership, revocation and session compatibility.
- [x] Paginated reads, files, bounded history search, source links and honest coverage.
- [ ] Durable governed writes, approval, retries, delivery reconciliation and duplicate prevention.
- [ ] Private-source publication restrictions, including automatic replies and attachments.
- [x] Optional endpoint-bound personal search OAuth, credentials, refresh and disconnect.
- [ ] Native search only with qualified transient runtime delivery; no stored search responses.
- [x] Native and authenticated CLI operations, preserving AgentMail restrictions.
- [x] Settings capabilities, Access search authorization, scope upgrades and Storybook states.
- [ ] Focused security/provider tests, full checks and live Leaf staging proof.

Allowed Channels governs replies and writes. Reads require current bot membership
and requester access. Other users' bot DMs remain inaccessible. Ordinary writes
use existing action policy; destructive actions, channel creation and invitations
require approval. The agent cannot join existing channels or enable destinations.

Provider references: Slack Web API method documentation and
https://docs.slack.dev/apis/web-api/real-time-search-api/ . Native search requires
an event action token for bot calls, optional personal OAuth for private search,
and explicit runtime retention qualification. Unsupported runtime/provider states
must be reported accurately and retain bounded history search.

## Current verification

- Full workspace typecheck and build passed on the initial implementation.
- 39 focused access, provider, native authority and guidance tests passed.
- PostgreSQL integration passes admitted-event binding, cross-company/task/agent
  rejection, CLI route validation, ordinary writes, rate-limit retries, uncertain
  send reconciliation, approval after run completion, recovery, OAuth refresh,
  disconnect race and removed-profile/identity revocation.
- Storybook capability and upgrade screens inspected visually. OAuth fields,
  disabled save, secret clearing and connected/disconnect state inspected.
- Full repository tests and live staging acceptance are still pending.

## Explicit runtime/provider limitations

Native RTS provider transport and OAuth are implemented but not connected to the
ordinary tool gateway: no current native/CLI runtime qualifies for Slack's
transient search-result retention requirement. Current tasks use bounded history
and filename/title search. Do not claim native public/private search passed live.

Inline file reading is limited to supported text/canvas downloads up to 256 KiB;
other files return metadata and an explicit limitation. Canvas/list writes depend
on Slack plan/scopes and cannot carry private research into an unverifiable shared
document audience. Uncertain effects other than posts/uploads need operator
inspection rather than an automatic resend. New approvals are needed to retry
failed approval-required operations. Ordinary rate-limit retries are limited to
the same still-authorized run.
