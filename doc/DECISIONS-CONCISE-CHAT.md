# New human decisions: concise context and native discussion

New human-facing decision cards must explain the choice without requiring a task or comment lookup. This is a creation contract, not an automatic rewrite of the backlog.

Implementation status: this branch is not ready to merge or deploy. The new preflight fails closed, but native runtime question/plan/review producers, onboarding and MCP elicitation still need complete author-supplied context integration. Existing service regression fixtures also require explicit valid briefs. The current native-chat test replaces the task surface and is not proof of the complete composer request boundary. Passing focused tests does not waive these integration and verification gaps.

## Authoring contract

Use the existing version 1 brief. `mainSummary` is authored text (maximum 600 characters), not an automatically generated summary. `subject` is a concrete title (maximum 160 characters on new human cards). Explain the subject, what the answer decides, what acceptance permits, and the material risk. The summary is never clipped by the renderer. Scope, exceptions, risks and prerequisites remain visible outside Details even if this repeats something important in the summary.

Each `selectionConsequences` entry has a readable `label` (maximum 80 characters). Native option labels and brief labels must match. Confirmation IDs remain `accept` and `reject`; labels do not change the underlying request. Item-verdict buttons use their per-item brief labels. Questions use their native option labels. A recommendation is optional and requires an option and a reason together. Personal facts must not recommend an answer or authorize effects.

New non-factual human cards must include `scope`, `excludedScope`, `risks` and `preconditions`. `[]` explicitly declares that no prerequisites were identified; an absent array is missing context. An absent recommendation means no recommendation. No permission, effect, risk assessment or factual answer is inferred from omission. Keep evidence and technical history in Details. Do not put a material precondition only in evidence references.

The preflight rejects missing text, reference-only text such as "see task", bare task identifiers, placeholders and generic Yes/OK labels. It cannot establish factual truth or recognize every euphemism. Authors remain responsible for current evidence, comprehensible language and complete scope. Never shorten a text by deleting risks to pass the length limit. Separate independent choices instead.

## Creation and API behavior

`humanDecisionQualityIssues` is the shared structural preflight. `assertHumanDecisionContext` and `assertHumanInteractionContext` run on the actual service creation paths, before inserts:

- Standalone Decisions and Decision bundles: `metadata.brief`.
- Native confirmation / checkbox confirmation: `payload.brief`.
- Native questions: `payload.questions[].brief`, one atomic explanation per question.
- Native item verdicts: `payload.items[].brief`, one explanation per item.

Human-facing means a human addressee, effective `human_only`, or no named agent addressee. Merely labeling the card expert does not bypass preflight. Named expert-agent cards retain native routing and creator exclusion. Human briefs require the native effective human-only restriction. Governance caps and company checks still apply.

Missing creation context returns HTTP 422 with `details.code = decision_context_missing` and an `issues` array containing `code`, `path`, and `message`. Schema-invalid values can fail the existing request-schema boundary with HTTP 400. Resolve missing context internally before retrying. In particular, a producer that does not yet supply a complete human brief gets an error; there is no silent legacy-create switch or invented fallback explanation. Existing matching idempotency keys can return the original stored card. This is not authority to rewrite or approve it.

OpenAPI exposes the shared brief metadata shape and native interaction schema. Stored version 1 briefs remain readable without the new fields. Missing, unsupported or incomplete stored explanations show an explicit conservative warning. Every collapsed native confirmation opens its original detail before either answer, including keyboard button activation. Existing native policy, target-revision and effect checks remain unchanged.

## Discuss with the responsible agent

The Decisions queue/Desk row uses the native company-scoped Agent Chat route. For an expert item the contact is the actual `resolverAgentId`. For a human native interaction it is the recorded `createdByAgentId` (labeled source agent, not task assignee); for standalone Decisions it is `originAgentId`. Assignment, names in prose and the creator's guessed expertise are never used as substitutes.

The contact, card, subject and linked task must belong to the selected company. A missing, deleted, paused or pending agent gives an explanatory fallback and, where safe, a task link. Disabled Agent Chat also gives a fallback. The link does not call `useOpenAgentChat`, because that helper ensures a persistent conversation. Navigation does not call ensure, send a message, wake an agent, accept/reject a card or change its revision.

`nativeChatDraftNavigation` runs only on the explicit click. It carries the stable source kind/ID, company, task ID and available native target revision in router state. For a known user it prepares an empty native tab-scoped composer draft. Existing text and uncertain submissions are never overwritten. If storage is unavailable or another draft exists, the context remains visible separately in the chat. It is ordinary text, not HTML and not authority. Back/forward and reload do not re-import or re-send it. Query strings never import message text. Only the normal explicit first write can create the conversation.

## Legacy re-routing (plan, then reviewed apply)

`pnpm decisions:legacy-routing plan --company <id> [--overrides overrides.json] > plan.json` is read-only. It lists every pending human-facing question, item-verdict and confirmation card and classifies each question, item or confirmation only from structured evidence: a governed tool/secret action, the unit's stored brief (decision class and resolver target), or an operator-reviewed override bound to the exact source hash of the card. Titles and prose are never used.

- Human approvals, personal facts and governed actions stay with the person.
- Units whose brief names an expert resolver move to that agent. The card creator is never its own reviewer.
- Mixed cards are split: one card per expert plus one human card. Confirmations are atomic and are moved or kept whole.
- Anything without structured evidence stays with the person and is reported as `needs_triage` for review.

`pnpm decisions:legacy-routing apply --plan plan.json --yes` re-plans under row locks and executes only `reroute`/`split` entries whose source hash and action still match the reviewed plan. Replacement cards use deterministic idempotency keys and the original is withdrawn (no wake, answer or approval), so re-running is a no-op (`already_applied`). Cards changed after review are `skipped_changed`. Nothing is run automatically; applying to live data needs separate parent authorization after reviewing the plan.

The same split rules apply to the illustrative wording below. Do not map a fact answer to authorization for another question. There is no automatic supersession, resolution or old-card approval.

Illustrative wording and boundaries (fictional examples):

- "Should the media server be reachable from the internet?" Explain the single forwarding rule (port and target host), what becomes publicly visible and what stays prohibited (all other forwarding, UPnP). The alternate answer commissions a plan only. Technical prerequisites must be checked before implementation.
- Split "accept that a media archive has no redundancy" from "investigate backup options and costs". Investigation permits no purchase. Deleting data is a separate destructive authorization.
- If a maintenance card's subject is missing or its proposed windows have expired, mark it internally unresolved. Do not invent a current description or reuse expired dates. A later valid question explains the expected downtime, the window, the manual fallback, verification and resume.
- "Does anyone outside your team use the shared services?" Ask only for group and service, not names. The answer is a personal fact and authorizes no change. Any follow-up configuration change is a separate choice.

Deployment alone never repairs the historical cards. Parent validation and separate authorization are required before any live changes. This feature authorizes no merge, deployment, agent wake or database mutation of the backlog.
