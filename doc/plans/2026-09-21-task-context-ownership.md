# Task context ownership contract

## Purpose

Paperclip assembles a task brief and a wake event for several adapter lanes.
Each task description or current comment has one automatic model-facing owner
when its source can be verified. This contract makes the source explicit while keeping the existing
task, wake, continuation, attachment, and custom-template fields intact.

## Ownership

Heartbeat-generated context carries an additive `paperclipTurnContext` object:

```ts
{
  version: 1,
  assignment: {
    owner: "task_markdown",
    description: { id: issueId, revision: sha256(trimmedSanitizedDescription) }
  },
  events: {
    owner: "wake_prompt",
    comments: [{ id: commentId, revision: sha256(trimmedSanitizedBody) }]
  }
}
```

The ordered comment references preserve distinct comment IDs even when bodies
match. A revision is evidence for the exact source body used to assemble the
run context; it is not an authorization token. Current event rendering keeps
its trust, author, attachment, omission, ordering, and follow-up rules.

`buildPaperclipTaskMarkdown` defaults to its historical behavior for standalone
callers. Heartbeat full and compact assignment markdown selects assignment-only
rendering, while the structured wake prompt owns current comment bodies. Missing
ownership metadata uses the legacy wake behavior, which preserves third-party
contexts and old serialized runs.

Custom templates continue to receive their existing task markdown, wake prompt,
wake JSON, and context variables. Automatic gateway JSON is omitted only when
the wake prompt already owns the event; environment payloads and explicit
custom template inputs remain complete. Prepared local CLI sessions, ACP
sessions, and standalone gateway runs retain their prior session and fallback
contracts. A standalone caller that has no ownership metadata continues to
render its wake comments through the existing renderer.

Continuation rendering suppresses a current comment only when the continuation
is for the same issue, the message ID is present in the actually rendered
continuation selection, and the trimmed body matches. Edited bodies, missing
resume-delta messages, deleted messages, unrelated issue IDs, and distinct IDs
with equal bodies remain visible.

The continuation builder records `objectiveSource` when it selects the current
objective. A comment source uses its comment ID and update revision. A task
description or title uses its issue ID and a hash of the trimmed source text.
The renderer can then refer to the displayed source instead of repeating its
body. It retains the full objective for older envelopes, unknown or stale
revisions, a truncated brief, or a source absent from the selected resume delta.
This preserves changed task fields on compact resumes.

## Source and completion checks

Completion references may point to the task ID, description source ID and
revision, and ordered current comment IDs and revisions. A reference is valid
only when its source block was rendered into the model task prompt. Native
completion-only recovery restores the complete current criteria and removes
source references after replacing the task prompt; it must not infer ownership from text matching or
drop an unverified source.

## Compatibility and rollback

Schema identifiers `paperclip.native-execution-input.v5` and
`paperclip.native-model-envelope.v3` are public redaction discriminators; v4
and v2 remain supported for retained sessions and older checkpoints. Session
pinning must keep v4/v2 readers available while active sessions still reference
them.

If ownership assembly must be rolled back, first restore reader support for
active v5/v3 sessions and retain the v4/v2 readers. Then disable new ownership
metadata production and return automatic lanes to legacy wake rendering. Do
not delete checkpoints, invalidate active session pins, replay external
actions, or discard source comments. Existing runs must continue to read their
persisted schema and completion context until they reach a terminal state.
