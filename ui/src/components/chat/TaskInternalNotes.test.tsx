// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskInternalNotes } from "./TaskInternalNotes";
import { internalNotesApi } from "@/api/internalNotes";
vi.mock("@/api/internalNotes", () => ({ internalNotesApi: { list: vi.fn(), create: vi.fn() } }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("isolated human-note editor", () => {
  let root: Root, element: HTMLDivElement, client: QueryClient;
  beforeEach(() => {
    vi.clearAllMocks(); localStorage.clear();
    vi.spyOn(localStorage, "setItem");
    element = document.createElement("div"); document.body.append(element); root = createRoot(element);
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    vi.mocked(internalNotesApi.list).mockResolvedValue({ notes: [], nextCursor: null });
  });
  afterEach(async () => { await act(async () => root.unmount()); client.clear(); element.remove(); vi.restoreAllMocks(); });
  const button = (text: string) => [...document.querySelectorAll("button")].find(b => b.textContent === text)!;
  async function render(issueId = "issue") {
    await act(async () => root.render(<QueryClientProvider client={client}><TaskInternalNotes key={issueId} issueId={issueId} companyId="company" userId="user" /></QueryClientProvider>));
  }
  async function enter(text: string) {
    await act(async () => {
      const input = document.querySelector("textarea")!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  it("uses a separate editor, saves with one retry ID, and never puts note text in localStorage", async () => {
    vi.mocked(internalNotesApi.create).mockRejectedValueOnce(new Error("lost receipt"));
    await render(); await act(async () => button("Internal notes").click());
    expect(document.body.textContent).toContain("Not sent to Slack or included in agent context");
    await enter("private-canary");
    await act(async () => button("Save Internal note").click());
    await vi.waitFor(() => expect(button("Retry same note")).toBeDefined());
    const id = vi.mocked(internalNotesApi.create).mock.calls[0][2];
    vi.mocked(internalNotesApi.create).mockResolvedValueOnce({ id: "note", companyId: "company", issueId: "issue", authorUserId: "user", body: "private-canary", createdAt: new Date().toISOString() });
    await act(async () => button("Retry same note").click());
    expect(internalNotesApi.create).toHaveBeenNthCalledWith(2, "issue", "private-canary", id);
    await vi.waitFor(() => expect(document.body.textContent).toContain("The CEO was not notified"));
    expect(localStorage.setItem).not.toHaveBeenCalled();
  });
  it("does not carry an unsaved note into another task", async () => {
    await render(); await act(async () => button("Internal notes").click()); await enter("private-canary");
    await render("other"); await act(async () => button("Internal notes").click());
    expect(document.querySelector("textarea")?.value).toBe("");
    expect(internalNotesApi.create).not.toHaveBeenCalled();
  });
});
