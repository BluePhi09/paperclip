# Slack CEO POC 1 — local test handoff

Updated: 2026-09-22

## Status and boundaries

This checkout implements the **M1 connection foundation**, not the full POC 1 journey. The real Slack DM round-trip and follow-up continuity have passed; explicit Paperclip-to-Slack reply and private-note regression checks are described below. Stop at a real CEO DM conversation before building or testing channel discovery and fixes.

- Branch: `codex/slack-ceo-poc1`, based on `origin/master` at `a68f3d8e35e6e4da82069e64234c38769b18a1a1`.
- Checkout: `/Users/scott/Documents/Codex/2026-09-22/referenced-chatgpt-conversation-this-is-an/work/paperclip`.
- Test UI: https://scotts-macbook-pro.tail29c1aa.ts.net (use this HTTPS origin for sign-in and OAuth).
- Separate PostgreSQL database: loopback port 55439, instance `slack-ceo-poc1`, under the sibling `work/instance` directory. It uses the same data originally initialized in embedded mode, now started separately to meet authenticated/public mode's explicit-database requirement.
- Authentication is enabled, new signup is disabled, and both server and database bind only to loopback. The test server uses authenticated/public mode with an explicit HTTPS origin, auth rate limiting, and a built static UI (no Vite development-file serving). Telemetry and update checks are off.
- No accounts, CEO configuration, credentials, tasks, or files were copied from the original instance. Its checkout and database were not changed.
- Tailscale Funnel forwards HTTPS port 443 only to this test server's `127.0.0.1:3210`. The separate Paperclip CEO POC app is installed in the Paperclip Slack workspace. No PR or merge has been created.

### Current walkthrough checkpoint

The user created company **test10** and its **CEO** in the isolated instance. The CEO completed the harmless connectivity prompt with **“CEO is online.”** on task **TES-1**. Use these existing pilot records; do not silently rename the company or import the original instance.

Tailscale public ingress, OAuth, linked identity, and signed DM delivery are now working. The user’s first Slack message created **TES-2** and received **“CEO is online.”**; the next DM correctly recalled that response. Use this same bot and task; no app recreation, broader scopes, or additional OAuth approval is needed for the reply-mode change.

The tunnel runs in the background until explicitly stopped, and the Mac must stay awake for the pilot. To remove only this approved HTTPS route (not reset unrelated Tailscale configuration):

```sh
/Applications/Tailscale.app/Contents/MacOS/Tailscale funnel --https=443 off
```

### Implemented

Managed bot OAuth with a single **Connect Slack** action; durable ten-minute, one-use state tied to company, endpoint, user, browser session, and configuration; exact returned Slack app/workspace validation; server-side secret-vault storage; actual scope validation; OAuth-proven installer identity linking; reuse of the existing signed webhook, conversation/task binding, durable event deduplication, and publication machinery.

The selected normal-workspace profile is `ceo-dm-v1`:

| Permission | Purpose |
| --- | --- |
| `im:history` | Receive messages sent to this bot in DMs |
| `im:read` | Resolve bot DM metadata |
| `chat:write` | Reply in the conversation |
| `users:read` | Resolve the message author's identity |
| `commands` | Private connection and conversation commands |

No public/private channel history, group-DM history, file, reaction, assistant, or public-channel-posting scopes are requested. These grants are not described as user/channel-specific tokens: Paperclip separately restricts admission to the OAuth-proven pilot person and direct messages. Channel inventory, group/channel admission, file transfer, receipt reactions, and native streaming are disabled for the profile. Broader previously granted bot tokens are rejected. Existing non-pilot Slack connections retain their original behavior.

### Not implemented yet

`ensure_capability()`, separate personal read OAuth and automatic read retry, `#papercuts` discovery, held candidate tasks, enforced Start implementation approval, isolated coding delegation, and fix/artifact review. PR creation, Greptile, and merge remain outside POC 1 entirely.

**Do not ask this milestone to implement fixes.** Ordinary existing agent permissions are not a substitute for the planned M3 execution gate. Use conversational/read-only CEO test prompts until that gate exists and is verified.

## Start or restart the test server

From the checkout above:

```sh
PAPERCLIP_UI_DEV_MIDDLEWARE=false PAPERCLIP_SLACK_CEO_POC_ENABLED=true pnpm --filter @paperclipai/server dev
```

This uses the worktree's `.paperclip/config.json` and owner-only `.paperclip/.env`. Keep deployment mode `authenticated`, exposure `public`, explicit HTTPS origin, signup disabled, and host `127.0.0.1`. Do not start a second copy while port 3210 is already in use. Do not turn Vite middleware back on while Funnel is public. After frontend changes, rebuild with `pnpm --filter @paperclipai/ui build` before refreshing the browser.

The test database is now a separate process. If port 55439 is not listening after a reboot, start only this existing cluster; do not initialize a new one or copy production data:

```sh
./node_modules/.pnpm/@embedded-postgres+darwin-arm64@18.1.0-beta.16/node_modules/@embedded-postgres/darwin-arm64/native/bin/pg_ctl -D /Users/scott/Documents/Codex/2026-09-22/referenced-chatgpt-conversation-this-is-an/work/instance/instances/slack-ceo-poc1/db -l /Users/scott/Documents/Codex/2026-09-22/referenced-chatgpt-conversation-this-is-an/work/instance/instances/slack-ceo-poc1/logs/postgres-https-pilot.log -o '-p 55439 -h 127.0.0.1' -w start
```

The normal `pnpm dev` wrapper refuses this intentionally unseeded worktree. **Do not run `worktree ensure-seeded` just to clear that warning:** it copies the source database. The direct server command above starts the deliberately empty, separate instance; it does not disable authentication.

Rust/Cargo is not installed here. The full server typecheck/build script invokes the native runner build and therefore cannot finish. Direct server TypeScript checking and development startup work. A CEO using the native runner will still need the supported native build/runtime; do not claim a successful CEO run until it actually completes.

## Guided one-time setup

1. Open the test UI and choose **Sign in / Create account** to claim this fresh instance. Use a new local test-account password yourself; do not send it in chat. Your existing instance's login was not cloned.
2. Prepare the pilot **Paperclip** company and **CEO** in this instance, using the intended agent configuration through normal onboarding or a separately reviewed selective import. Do not clone all production credentials. Verify a harmless prompt in Paperclip first. In instance settings enable **Chat connectors**. If the worktree execution guard is shown, enable the instance's worktree run-execution setting through the normal UI for this clean instance; retain scheduler/routine suppression.
3. Choose a stable HTTPS tunnel or reverse proxy to this authenticated loopback server. Do not expose the bootstrap screen to the internet before claiming the instance and disabling further signup. Obtain any required workspace/operator approval. **Completed for this pilot:** the user approved the Tailscale Funnel route above; the login page is internet-accessible, while company data requires authentication.
4. Set the public origin and webhook origin in the worktree's ignored `.paperclip/.env`, keeping exact HTTPS origins:
   - `PAPERCLIP_PUBLIC_URL=https://your-pilot-host`
   - `PAPERCLIP_CHAT_WEBHOOK_PUBLIC_URL=https://your-pilot-host`
   - `PAPERCLIP_ALLOWED_HOSTNAMES=your-pilot-host`
   - `PAPERCLIP_AUTH_DISABLE_SIGN_UP=true` **after** claiming the local account.
   Restart and verify the same account signs in at that HTTPS origin. Start and complete OAuth from this origin in the same browser session, not partly on localhost.
5. In Paperclip, open **Apps → Slack → Chat with an agent**, choose CEO, and create the draft. With the pilot flag enabled, new Slack drafts use the minimal profile. Existing broad-profile drafts are not silently upgraded; make a separate draft.
6. Use the wizard's **Create a Slack app** link/manifest to register a **new internal app** in your normal workspace. Review the five scopes above before installation. No agent should click Slack's final approval on your behalf. If Slack requires request-URL verification before saving Events, finish app creation without enabling Events, complete OAuth, then return to enable/verify Events. Keep the same draft and callback URL.
7. From the new Slack app's **Basic Information**, obtain App ID, Client ID, Client Secret, and Signing Secret. Obtain the workspace's stable Team ID. Put secrets only in the ignored instance environment, never in a task, screenshot, source file, or chat transcript. Fill these operator settings:
   - `PAPERCLIP_SLACK_CEO_POC_ENABLED=true`
   - `PAPERCLIP_SLACK_CEO_POC_COMPANY_ID=<isolated Paperclip company ID>`
   - `PAPERCLIP_SLACK_CEO_POC_USER_ID=<signed-in local pilot user ID>`
   - `PAPERCLIP_SLACK_CEO_POC_AGENT_ID=<isolated CEO agent ID>`
   - `PAPERCLIP_SLACK_CEO_POC_APP_ID=A...`
   - `PAPERCLIP_SLACK_CEO_POC_TEAM_ID=T...`
   - `PAPERCLIP_SLACK_CEO_POC_CLIENT_ID=<Slack client ID>`
   - `PAPERCLIP_SLACK_CEO_POC_CLIENT_SECRET=<secret>`
   - `PAPERCLIP_SLACK_CEO_POC_SIGNING_SECRET=<secret>`
   Resolve the first three IDs from this instance, not from the original company. Codex can help identify them after you have completed sign-in/onboarding. Protect the environment file with owner-only permissions and keep it out of git.
8. Add the exact Redirect URL displayed on the Connect screen to Slack's **OAuth & Permissions → Redirect URLs**. It ends in `/api/chat-endpoints/<endpoint-id>/slack/oauth/callback`. This is **different** from the signed Events/Interactivity Request URL, which ends in `/api/chat-webhooks/<public-id>/slack`.
9. Restart the test server to load settings. Resume the saved draft from the HTTPS origin; click **Connect Slack** and approve the listed permissions. The callback verifies both provider identity and the initiating browser session and links the installing Slack person to that Paperclip user. It does not identify users by email or display name.
10. In Slack, enable the App Home Messages tab with messages writable. Set/verify the Events URL, subscribe only to `message.im`, `app_uninstalled`, and `tokens_revoked`, and configure Interactivity and the generated slash command to the same signed webhook URL. Use the wizard's verification step. Administrator app-install approval may be required; do not bypass workspace policies.
11. Resume the wizard. The linked account should appear automatically. If a process interruption occurred after credentials were saved but before identity finalization, the existing private `/<generated-command> connect` confirmation flow is the recovery path; verify the account in the same authenticated Paperclip user context. No ordinary message creates a task while unlinked.
12. DM the bot: **“Hello CEO—what can you help me with? Please just reply; don't start implementation.”** Confirm a real CEO response, one canonical Paperclip task, and a working task link. Restart the server and send a follow-up: it should use the same conversation. Try a different Slack person and confirm no task/run is admitted. Only after this live proof should M2 channel-read consent be added.

## Test the two Paperclip message paths

Open [TES-2](https://scotts-macbook-pro.tail29c1aa.ts.net/TES/issues/TES-2).

1. **Ordinary message (internal):** use the main task composer and ask: `Reply exactly "Internal reply stays in Paperclip." Do not edit files, delegate work, create tasks, or perform other actions.` The answer stays in Paperclip. No Slack publication should be created.
2. **Explicit Slack reply:** in the Connected to Slack banner, click **Reply via Slack**, enter `Reply exactly "Paperclip to Slack works." Do not edit files, delegate work, create tasks, or perform other actions.`, then click **Ask and reply via Slack**. The request stays in Paperclip; one final answer goes to the existing bot DM.
3. **Saved is not delivered:** the form acknowledges the saved request. Confirm the answer in Slack or the connection Activity delivery record. A failed/uncertain delivery must be resolved as that same publication, not by generating a replacement answer.
4. **Network interruption:** use **Retry same request** after a lost response. The browser retains the same request ID across reloads. Do not create a new message solely because the response was lost.
5. A successful conversation turn should become **Idle** without a corrective model run or a new missing-disposition warning. Real approvals, pending work, paused tasks, or delivery problems must remain visible.

**Send to channel** remains the separate action for publishing your own chosen text. Neither that action nor Reply via Slack grants implementation, PR, or merge permission. The new Reply via Slack mode is limited to the linked pilot person's existing minimal-profile DM and final text answer; it does not broadcast task history, intermediate notes, or files.

## Failure and recovery

- **Permissions do not match:** use a new internal app with exactly this profile. Slack scopes accumulate; removing them from the request does not shrink an old grant automatically.
- **Token rotation required:** this milestone explicitly refuses rotating bot credentials because the existing channel adapter has no refresh contract. Keep your workspace policy unchanged; report this as a blocker requiring refresh support.
- **Expired/denied/wrong-session OAuth:** return to the same draft and click Connect Slack again. An invalid browser session cannot consume another session's state. A valid callback consumes state once before exchanging the code.
- **Interrupted after token exchange but before durable storage:** a fresh authorization may be needed; the code is not replayed blindly.
- **Credentials saved but final UI/identity step interrupted:** resume the same endpoint's Verify/Identity screens. Verified installer metadata is stored before vault persistence so saved credentials need not be exchanged again solely for identity recovery.
- **Different app/workspace:** rejected before credentials are saved. The authorization URL's workspace hint alone is not trusted.
- **Workspace app approval pending:** wait for the administrator; no widened grant or alternate workspace is substituted.
- **No CEO response:** inspect the real task/run and runtime setup. OAuth success does not prove model authentication, runner availability, or agent execution.
- **No HTTPS URL:** local UI checks still work; real Slack OAuth/webhooks do not. No synthetic transport is represented as live Slack.

## Verification record

Automated tests cover the broker boundary, session restrictions, minimal scopes, UI gating, restart-safe pending state, one-time consumption, wrong workspace, membership/CEO checks, and OAuth-proven identity linking. Existing Slack activation, deduplication, identity revocation, and legacy scope validation are included in focused regressions. Provider traffic in these tests is synthetic; no real Slack app or agent is used.

UI and server direct TypeScript checks pass; design token gates pass. A full repository test/build and visual baseline review are not claimed. The full server script is blocked by the missing Cargo toolchain.

Browser smoke: authenticated HTTPS is working, signup remains disabled, and the original instance is untouched. The user observed real CEO responses on TES-1 and the Slack-bound TES-2. Real Slack DM continuity passed. The explicit reply mode was exercised with a real agent and Slack delivery; a recovery ordering race found during the first test was fixed and added to automated coverage.

Automated reply-mode coverage includes simultaneous duplicate requests, restart-safe durable request identity, company/user/DM authority, revocation after admission, private intermediate comments, one selected answer, private-turn settlement, and pending/failed/ambiguous delivery excluded from generic model recovery. A full repository build/test or production rollout is not claimed. Channel discovery and implementation remain later milestones.

### Latest live regression result — 2026-09-22, 14:09 PDT

- Normal Paperclip composer: one private answer, no Slack publication, task returned to Idle. Run `c075fb41-6ce1-4abb-9d25-8d71511bd492`.
- Reply via Slack: one final answer, **“Paperclip to Slack works — final check passed.”**, published successfully in one provider attempt. Run `ca7b2afc-38c4-4f8d-a484-5cd2703031af`; Slack message `1790111393.342499`.
- Both final test turns completed without a corrective recovery run. TES-2 is Idle. Earlier failed-test warnings remain in its history; they were not deleted or presented as successful tests.
- 175 focused tests passed across nine files; UI/server direct TypeScript checks, UI build, and design-token gates passed. Existing build warnings remain. The full repository suite and Rust-dependent server build were not run successfully.

## Provider references

- [Slack OAuth installation and additive scopes](https://docs.slack.dev/authentication/installing-with-oauth/)
- [Bot OAuth token response](https://docs.slack.dev/reference/methods/oauth.v2.access/)
- [DM event and required scope](https://docs.slack.dev/reference/events/message.im/)
- [Conversation metadata](https://docs.slack.dev/reference/methods/conversations.info/)
- [Posting messages](https://docs.slack.dev/reference/methods/chat.postMessage/)
