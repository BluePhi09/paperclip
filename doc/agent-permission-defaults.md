# Agent permission defaults

This document describes the server defaults for an ordinary, standard trust agent. An agent must belong to the same company and be active where the action requires active membership. A responsible user's authority, project or run trust policy, scope rules, and approval gates can narrow these defaults.

## Granted by default

| Capability | Source and limit |
| --- | --- |
| Task assignment | New standard agents receive one direct grant: `tasks:assign` without a scope, subject to company and route checks. Every other permission grant (for example `agents:configure`, `skills:create`, `tools:use`, `inbox:manage`) is granted explicitly by the board per agent. |
| Agent creation | New standard agents have `canCreateAgents: true`. This is a legacy authorization path for `agents:create`, not an `agents:create` grant row. Stored legacy records without the flag stay closed. |
| Skill creation setting | `canCreateSkills: true` is the normalized setting. Protected skill configuration changes still require a direct `skills:create` grant or a consented `skills:suggest-changes` grant. |
| Same-company visibility and work | Standard agents can read same-company agents, projects, issues, and company scope; read and manage decision queues; read runtime and secret metadata where the route allows it; comment or mutate their own or unassigned issues; and assign tasks under the assignment policy. The route and resource checks still apply. |
| Own configuration and wake | An agent can read its own configuration, update unprotected parts of it, and wake itself. Protected changes still require the relevant grant. |

## Not granted by default

Apart from `tasks:assign`, no permission key has a blanket grant for new standard agents. This includes `agents:configure`, `agents:suggest-changes`, `agents:create` (the flag above is separate), `skills:create`, `skills:suggest-changes`, all `tools:*` keys, `audit:view_agent_actions`, `inbox:manage`, `tasks:assign_scope`, `tasks:manage_active_checkouts`, `environments:manage`, `users:invite`, `users:manage_permissions`, and `joins:approve`. Existing agents keep their current permissions. The defaults above apply when a new standard agent is created or a pending new hire is activated. Some actions have separate bounded paths; the absence of a grant row does not describe every route decision.

The default grant does not grant company administration, user permission management, blanket tool administration, or cross-company access. The responsible user's permissions, route checks, and the normal approval gates still apply.

Agent-authenticated callers cannot set process adapter configuration or switch an existing agent onto the process adapter. For local adapters, they cannot change host command, argument, working-directory, arbitrary environment, or filesystem sandbox command settings. Provider credential secret references on known environment keys remain allowed so agents can hire peers with their own credentials. When a caller uses an AI connection pool, a new peer can use a plain provider authentication override on the small allowlist of supported keys. Arbitrary environment keys remain blocked. The same limits apply to creation, hiring, adapter switches, and configuration rollback. They also cannot restore host-executed workspace commands through a configuration revision. This keeps host-executed commands under board control while agents that hold `agents:configure` configure other supported agent settings.

## Exceptions and rollout

The default grant is withheld from low trust agents and managed built-in agents. Low trust run or project policies can also deny privileged actions even if an agent has a grant. There is no permission backfill or upgrade migration for existing agents. A standard pending new hire receives the default grant when approved and activated. Invitation approval retains the default grant when it replaces a new agent's grants and preserves any explicitly scoped default grant. Existing scoped grants stay unchanged. A grant removed by an operator stays removed; ordinary updates and startup do not reapply it.

Agents created before this default was narrowed keep the grants they received at creation. Enabling a warm runtime can still depend on the target agent's adapter and runtime configuration, provider availability, and any responsible-user or approval checks.
