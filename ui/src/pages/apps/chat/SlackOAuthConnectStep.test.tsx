// @vitest-environment jsdom
import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SlackOAuthConsent } from "./SlackOAuthConnectStep";

describe("Slack CEO minimal consent UI", () => {
  let root: Root;
  let container: HTMLDivElement;
  const onConnect = vi.fn();
  beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); onConnect.mockClear(); });
  afterEach(() => { flushSync(() => root.unmount()); container.remove(); });
  function render(configured: boolean, failed = false, pending = false) {
    flushSync(() => root.render(<SlackOAuthConsent onConnect={onConnect} onExit={() => undefined} failed={failed} pending={pending} endpoint={{ assignedAgentName: "CEO", setup: { step: "provider_setup", slackOAuth: {
      enabled: true, configured, profile: "ceo-dm-v1", callbackUrl: "https://pilot.example/callback",
      scopes: ["chat:write", "commands", "im:history", "im:read", "users:read"], missing: configured ? [] : ["PAPERCLIP_SLACK_CEO_POC_CLIENT_ID"],
    } } }} />));
  }
  const connectButton = () => [...container.querySelectorAll("button")].find(button => /Connect Slack|Opening Slack/.test(button.textContent ?? ""))!;
  it("offers one connect action and accurately explains the limited grant", async () => {
    render(true);
    expect(connectButton().disabled).toBe(false);
    expect(container.textContent).toContain("DM-only permissions");
    expect(container.textContent).not.toContain("files:read");
    expect(container.textContent).toContain("not yet available in this milestone");
    await act(async () => connectButton().click());
    expect(onConnect).toHaveBeenCalledOnce();
  });
  it("blocks the action until operator setup is complete", () => {
    render(false);
    expect(connectButton().disabled).toBe(true);
    expect(container.querySelector('[role="status"]')?.textContent).toContain("PAPERCLIP_SLACK_CEO_POC_CLIENT_ID");
    expect(container.querySelector('input[type="password"]')).toBeNull();
  });
  it("shows recovery and prevents duplicate clicks during a handoff", () => {
    render(true, true, true);
    expect(connectButton().disabled).toBe(true);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("do not change your organization’s security policy");
  });
});
