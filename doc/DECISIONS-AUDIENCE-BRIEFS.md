# Decisions audiences and briefs

Decisions remains an experimental Board surface. This change separates personal
and risk decisions from named agent reviews inside the existing Desk and queues.
It does not create a second inbox or a new permission system. No database
migration, flag default change, historical card rewrite, or automatic vote is
included.

## Audience projection

The Desk and queue pages start with `human`. The toolbar also offers `agent`,
`unclassified`, and `all`. Changing audience clears expanded detail; the Desk
also clears its keyboard selection. Query keys include the audience.

The Board feed is `GET /api/companies/{companyId}/attention`. It retains Board
and company checks. Its new optional query parameters are:

| Parameter | Values and behavior |
| --- | --- |
| `audience` | `human`, `agent`, `unclassified`, or `all`; other values return 400. Omission preserves legacy source selection. |
| `resolverAgentId` | Nonempty string that filters projected items by named resolver. It never changes the caller identity or grants authority. |

The existing queue, activity, paging, archive, and dismissed filters still apply.
An explicit audience includes named-agent native interactions and agent review
stages in the Board projection. `all` does not grant a vote. The Board feed can
materialize seeded queues; do not use it for a strict read-only audit.

Items expose `audience`, `resolverAgentId`, `resolverLabel`, and `routingBlocker`.
Effective `human_only` or a user addressee takes the human audience. A native
agent addressee takes the agent audience; unnamed native resolvers need triage.
Other Board sources remain human. A named pending agent execution-review stage
is an agent item. An unavailable reviewer has a routing blocker, not a substitute
human approval. Agent items disable compact resolution and show no decision verbs.
Projection is not an authorization decision. The original resolver checks remain
required even when a card appears in a feed.

## Actor-bound expert API

`GET /api/companies/{companyId}/attention/expert` requires a verified agent actor
in that company. It accepts **no query parameters** (400 if any are present).
Board actors and foreign-company agents receive 403. Unauthenticated or invalid
credentials receive 401 in authenticated mode. A conflicting signed run/header
identity is rejected by the existing authentication boundary.

The response is an `AttentionFeed` with pending native interactions addressed to
the caller and pending execution-review stages assigned to that agent. It excludes
human-only interactions, user-addressed interactions, and native `not_creator`
self-review. It has no cursor and returns the actor's full projected snapshot.
It does not materialize queues, create reviews, wake agents, or write votes.

The callback bridge permits only the exact GET expert path. A different method,
Board attention path, suffix, trailing slash, empty company, or generic `/decide`
is not permitted by this added rule. Real execution transport still requires
existing credentials and company/run validation. The API does not mint them.

Resolve through the original issue interaction or execution-stage API with real
agent/run identity. Standalone Decisions and their effects remain Board-only.
Existing creator exclusions, human-only gates, company checks, bound target
revision checks, governed-action controls, and persisted attribution still apply.

## Optional version 1 brief

Use `metadata.brief` on standalone Decisions. Use `payload.brief` on native
confirmation and checkbox confirmation, `questions[].brief` on native questions,
and `items[].brief` on item verdicts. Existing brief-less cards retain native
behavior. New opted-in briefs must validate against `decisionBriefSchema`.

Required fields:

- `version: 1`.
- `decisionClass`: `personal_fact`, `human_risk_decision`, `expert_review`, or
  `internal_detail`.
- `subject`: the exact matter to decide.
- `resolverTarget`: `{ type: "human", userId?, reason }` or
  `{ type: "agent", agentId, reason }`.
- `evidenceRefs`: one to twenty `{ source, revision }` entries.
- `selectionConsequences`: one to forty `{ optionId, consequence }` entries.
- `safeDefault`: what to do without an answer.

Text fields are nonempty and bounded to 2000 characters. Agent IDs use UUIDs.
Consequences must cover every available option exactly once. Ordinary confirmation
uses `accept` and `reject`. Checkbox confirmation also includes all checkbox option
IDs. Question briefs use the question's option IDs; item briefs use the available
verdict values. A recommendation must name an existing option.

| Class | Permitted explicit purpose |
| --- | --- |
| `personal_fact` | `fact` |
| `human_risk_decision` | `execution_authorization` |
| `expert_review` | `plan_review`, `result_verification`, `execution_authorization` |
| `internal_detail` | `internal_detail`, `execution_authorization` |

Purpose can be omitted on effectless briefs, but never to authorize effects.
Human-risk and explicit execution-authorization briefs also require `reason`,
`scope`, `excludedScope`, `risks`, `preconditions` (array, empty if none),
`recommendationOptionId`, and `recommendationReason`. A personal fact must not
recommend an answer. Do not invent a personal fact or reuse it as an approval.

Standalone briefs must target humans. Native human targets require an effective
`human_only` policy, not merely a requested label. An optional user ID must match
the native user addressee. Agent targets must match the native agent addressee,
with no user addressee and no effective human-only restriction. Personal facts
and human-risk decisions must target humans. A valid expert brief adds creator
exclusion, including for human authors and per-question/per-item briefs.

The shared `decisionBriefAuthorizesEffects` helper validates the complete supported
brief and requires explicit `execution_authorization`; it is a quality preflight,
not a permission grant. Board option effects and native governed tool/secret
confirmations with a brief reject missing or incomplete authorization. Native
checks still enforce the actual effect and resolver. Neither a fact nor a review
label silently grants execution authority.

## Explanation before action

Cards render a supported brief before decisive controls. Scope, evidence, and
prerequisites are available in expandable details. Stored confirmation briefs with
null, invalid, or future-version content retain their original native payload and
show a fallback warning. This tolerance is display-only; creation remains strict.
Unsupported brief content never grants authority.

The feed marks stored brief presence as `requiresDetailReview`. Compact Accept
and Reject open the original detail instead of voting. Button activation by keyboard
uses the same path. Desk Enter toggles detail without a vote. The normal native
control may act only after disclosure and still uses the original resolver.
Brief-less legacy compact behavior remains unchanged.

## Supporting release prerequisite: application reuse

This PR also contains an isolated correction to `createConnection` in tool access,
not a Decisions permission change. Three application-reuse tests already failed on
its integration base: implicit creation always inserted a new application and hit
native unique constraints before reuse or type validation could run.

Implicit connections now let PostgreSQL's existing company/name and company/key
identities arbitrate creation. A conflict reuses only one company-scoped row with
an equivalent display name (trimmed, case-insensitive); an unrelated key collision
or ambiguous name/key pair returns 422 without attaching a connection or minting
a duplicate key. Explicit and implicit reuse share the existing MCP transport/type
validation. Connection UIDs use the resolved application's native key. No schema,
migration, credential policy, or workflow gate is changed. Real embedded PostgreSQL
fixtures cover reuse, incompatible types, collisions, company isolation, and
concurrent creation; this supporting change does not certify a live Apps pilot.

## Verification and limits

Targeted tests cover source projection, brief/effect preflight, creator exclusion,
real authenticated HTTP/JWT/company/run/stale-target boundaries, both callback
allowlists, and Desk/queue disclosure with actual React components. UI network
boundaries are mocked; these tests are not a browser or live sandbox pilot.

Dynamic audience-switch loading/error/selection-reset behavior is not fully
behaviorally certified. Full historical mixed-card triage, atomic partial-answer
source display, and malformed atomic question/item hydration remain separate work.
No existing pending card is answered or migrated by this change. A production
image build does not prove live reviewer routing or approval behavior.
