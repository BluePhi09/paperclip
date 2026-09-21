# Native onboarding and Agent Chat qualification — 21 September 2026

This record distinguishes live behavior from the existence of an eval. No native
onboarding default or production prompt was changed. All paid work ran on isolated
GitHub Actions workers with real providers, Chromium, Paperclip, and public APIs.

## Native onboarding

[Campaign 35656761484](https://github.com/paperclipai/paperclip/actions/runs/35656761484)
on master `846336e5a0d3003e1b938e8c983aa5a65bda81ff`: **26/26 passed**,
with **26/26 cleanup passes**. The 13 cases ran on both native Codex and native
Claude: interviews, clear/ambiguous requests, plain messages, explicit plans,
ordinary-task isolation, plan acceptance, card/reply acceptance, acceptance during
active work, clarification, revision, and rejection. The observed completed models
were `gpt-5.6-sol` and `claude-sonnet-5`; some Codex first-response cases stop on an
answerable native question before model metadata is emitted.

The real wizard creates the agent. The existing fixture switches its runtime
through the public API before the first provider run, preserving the wizard's
model choice, persona, skills, and task. This qualifies the pre-default native
first-task process. It does not qualify native selection in the onboarding UI or
production rollout, neither of which is enabled by this change.

## Initial new-case campaign

[Campaign 35657128077](https://github.com/paperclipai/paperclip/actions/runs/35657128077)
on `3ca6d25e0d20dd36e74c0868872802856e5503fc` retained all six failures:

- Active reassignment, both providers: the fixture sent an instructions bundle to
  the general agent PATCH endpoint. It did not update the worker's managed file,
  so the worker finished before the intended wait. The active boundary was never
  exercised. Use the instructions-file endpoint and verify its persisted content.
- Answer quality, both providers: the prompt did not specify whether the blocker
  field should contain only its reference or also its description, and did not
  explicitly exclude the current chat from the active-run count. Codex returned
  the reference plus its correct description; Claude correctly counted this chat
  and explained that no other work was active. Claude also put the explanation
  outside the JSON. These attempts do not establish a factual reasoning failure.
  The fixture now specifies the JSON shape, reference-only field, and task scope.
- Worker crash, both providers: after the verified worker loss, Retry was visible
  and accepted. The second run immediately failed with
  `native_session_cleanup_quarantined`. The saved plan and original message
  survived, but no usable recovered answer was produced. This is a real recovery
  boundary, not a model failure. Reported billing is incomplete for these crashed
  runs; absent usage must not be described as zero cost.

The fault helper now uses a Linux pidfd, checks the command's exact run ID and
start ticks, and signals the owned handle. Tests reject changed identity and dead
handles. Linux CI also exercises a real disposable child. macOS does not run this
fault case; the supported qualification host is Linux.

## Recovery correction

A quarantined failure can precede creation of its coordinator row. The execution
projection now preserves `recovery_needed` even without that row or with a stale
retryable coordinator. The generic failed-run retry endpoint refuses this exact
native quarantine instead of admitting another doomed run. An explicitly
reconciled successor still clears the historical projection correctly.

The worker-crash eval remains **non-passing** when recovery is unavailable. It
records that saved work survives, verifies the unavailable Retry UI and HTTP 409,
and reports the missing usable recovery. Passing a guard test is not recovery
qualification. Selecting verified cleanup plus a fresh attempt versus exact-session
resume remains a product decision; neither is silently enabled here.

## Answer-quality review

Review method: inspect retained user comments, agent comments, question/confirmation
cards, and durable task outcomes. This is an agent-authored semantic review, not an
independent LLM-judge score and not a claim about all possible questions.

The 26 onboarding recordings show focused questions for ambiguous requests,
concrete proposals for clear requests, preservation of the supplied day/fee/audience,
and respect for revision and rejection. The first status answers in the new
campaign correctly identify the resolved budget issue, current venue blocker,
deferred printing, and unknown attendance count. The second-turn counterfactual
questions were not reached in that initial campaign.

Two user-facing limitations remain worth deciding:

- One Claude acceptance reply exposed internal wording: “per the confirmation
  proposal mode.” This conflicts with the existing skill's wording preference.
- Five of the six Claude acceptance journeys left a future-tense handoff as the
  latest parent-thread reply, even though the child later completed. The saved
  child output and task status passed. Codex posted completion follow-ups in the
  corresponding journeys. Decide whether a final parent-thread completion notice
  should be a required outcome; the current onboarding oracle does not require it.

Production instructions were preserved. These observations must not be hidden by
changing prompts solely to make the benchmark green.

## Grounded status answers: corrected live proof

[Campaign 35658262695](https://github.com/paperclipai/paperclip/actions/runs/35658262695)
on `4a26f10be7dd6aeabf2ca7b44b3d6b2ece7817e0`: **2/2 passed**, both
cleanup passes. Each provider answered both turns, preserved both source tasks,
and started no execution on either task. The original failed attempts above are
retained; this is a new campaign with an explicit output contract.

Semantic review of all four retained replies against the task descriptions and
chronological comments found:

- Both identified venue confirmation as the current blocker, printing as deferred,
  no task execution, and unknown attendance. Both gave the useful next step of
  confirming the venue before printing.
- Both rejected the obsolete budget claim and unsupported printing claim on the
  follow-up, and distinguished a planned Friday from a guaranteed calendar date.
  Neither invented a venue, date, or attendance count.
- Codex's explanations were compact and clear. Claude's second explanation was
  longer but readable and grounded in named task records. Its phrase “no venue has
  been confirmed” is slightly stronger than “no confirmation is recorded”; its
  immediately following quotation and null fact make the evidence limitation clear.

This qualifies these two-turn grounding stories, not general answer quality,
statistical reliability, multilingual behavior, or arbitrary long conversations.
The five review dimensions remain factual grounding, stale-premise correction,
honest uncertainty, useful next step, and clear prose. No production prompt changed.
