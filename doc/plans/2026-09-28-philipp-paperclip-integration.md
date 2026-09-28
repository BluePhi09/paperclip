# Philipp's Paperclip integration branch

This branch is a development integration of Philipp's five open upstream pull requests, rebased by cherry-picking their commit series onto `paperclipai/paperclip` `master` at `0f14d261233c545aa6a8a38ec253c498a5130fff`. It is **not** the running deployment. The closed superseded PR #13994 is not applied separately.

- #13996: weekly detect-only runtime image workflow.
- #13995: published `:latest` runtime defaults and image-pull behavior.
- #14001: Kubernetes sandbox login PTY, bounded lease expiry, and per-lease egress.
- #14257: transaction-scoped wakeup/release DB reads to avoid pool exhaustion.
- #14291: outbound MCP connector (draft, not yet ready for production).

The image workflow and Kubernetes plugin branches overlap. Conflict resolution retains the `:latest` defaults, preloaded-image pull policy, sandbox hard-stop semantics, and per-lease policy. An outdated Gemini `:v1` test expectation was updated to `:latest` after integration.

## Deployment boundary

Do not switch the live `nebula` deployment to this branch yet. The existing GitOps manifest pins the official `2026.916.1` image by digest; the deployed Kubernetes plugin is independently installed from a local path on the PVC. A custom server image does **not** replace that plugin automatically. Build and publish a versioned/digest-pinned image, validate database migration and rollback against a disposable copy, deploy the plugin built from this same branch while preserving its registration/dependencies, and only then update GitOps. The local Claude runtime override (`gitea.bluephi09.me/hermes/agent-runtime-claude:latest`) lives in deployed plugin `dist` and is not represented in this source; preserve it in environment configuration or a durable plugin override before rollout. Never introduce the public-facing trusted-host workaround for Claude subscription sign-in. Off-node DB/PVC backups and restore testing remain open.

## Verification at branch creation

- Kubernetes plugin: typecheck, build, 265 tests passed.
- Weekly workflow: 8 Node tests passed.
- Focused wakeup + connector suites: 86 tests passed.
- UI, connector, and direct server `tsc --noEmit` typechecks passed.
- Root recursive typecheck and the server's scripted typecheck were blocked by missing `cargo` (runner dependency), so the full repository and production image have **not** been verified.
- Upstream #14291 remains a draft with failing CI as of integration; keep this branch experimental pending its review and an end-to-end rollout test.
