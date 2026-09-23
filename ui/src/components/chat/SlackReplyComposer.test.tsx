// @vitest-environment jsdom
import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SlackReplyComposer } from "./SlackReplyComposer";
import { chatEndpointsApi } from "@/api/chatEndpoints";
import { queryKeys } from "@/lib/queryKeys";

vi.mock("@/api/auth", () => ({ authApi: { getSession: vi.fn() } }));
vi.mock("@/api/chatEndpoints", () => ({ chatEndpointsApi: { requestSlackReply: vi.fn() } }));
const key = "paperclip:slack-reply:v1:company:user:issue:endpoint:conversation";
const retained = { body: "Reply hello", clientRequestId: "10000000-0000-4000-8000-000000000001" };
describe("explicit Slack reply composer", () => {
  let root: Root, container: HTMLDivElement, client: QueryClient;
  beforeEach(() => {
    localStorage.clear(); vi.clearAllMocks();
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false }, mutations: { retry: false } } });
    client.setQueryData(queryKeys.auth.session, { user: { id: "user" } });
  });
  afterEach(() => { flushSync(() => root.unmount()); container.remove(); client.clear(); localStorage.clear(); });
  async function render(sharedThread = false) {
    await act(async () => { root.render(<QueryClientProvider client={client}><SlackReplyComposer sharedThread={sharedThread} companyId="company" issueId="issue" endpointId="endpoint" conversationId="conversation" /></QueryClientProvider>); });
  }
  const button = (text: string) => [...container.querySelectorAll("button")].find(b => b.textContent === text)!;
  it("explains shared request delivery before execution in the new thread", async () => {
    await render(true);
    await act(async () => button("Reply via Slack").click());
    expect(container.textContent).toContain("Your request and the agent’s answer are shared");
    expect(container.textContent).toContain("starts after your request is delivered");
    expect(container.textContent).not.toContain("Only the agent’s answer");
    expect(chatEndpointsApi.requestSlackReply).not.toHaveBeenCalled();
  });
  it("does not send anything on opening and explains the private default", async () => {
    await render();
    await act(async () => button("Reply via Slack").click());
    expect(container.textContent).toContain("Ordinary task messages stay internal");
    expect(chatEndpointsApi.requestSlackReply).not.toHaveBeenCalled();
    expect(button("Ask and reply via Slack").disabled).toBe(true);
  });
  it("retains the same request identity after a lost response, then clears only after acknowledgement", async () => {
    localStorage.setItem(key, JSON.stringify(retained));
    vi.mocked(chatEndpointsApi.requestSlackReply).mockRejectedValueOnce(new Error("Connection lost"));
    await render();
    expect(container.querySelector("textarea")?.disabled).toBe(true);
    await act(async () => { button("Retry same request").click(); });
    await vi.waitFor(() => expect(container.textContent).toContain("Connection lost"));
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual(retained);
    vi.mocked(chatEndpointsApi.requestSlackReply).mockResolvedValueOnce({ requestId: "receipt", commentId: "comment", status: "submitted" });
    await act(async () => { button("Retry same request").click(); });
    await vi.waitFor(() => expect(localStorage.getItem(key)).toBeNull());
    expect(chatEndpointsApi.requestSlackReply).toHaveBeenNthCalledWith(1, "endpoint", "conversation", retained.body, retained.clientRequestId);
    expect(chatEndpointsApi.requestSlackReply).toHaveBeenNthCalledWith(2, "endpoint", "conversation", retained.body, retained.clientRequestId);
    await vi.waitFor(() => expect(container.textContent).toContain("not a delivery receipt"));
  });
  it("fails closed when a stored draft is malformed", async () => {
    localStorage.setItem(key, "malformed");
    await render();
    await act(async () => button("Reply via Slack").click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("could not be read");
    expect(button("Ask and reply via Slack").disabled).toBe(true);
    expect(chatEndpointsApi.requestSlackReply).not.toHaveBeenCalled();
  });
});
