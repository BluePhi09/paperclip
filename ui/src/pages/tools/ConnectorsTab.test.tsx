// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { McpConnector } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorsTab } from "./ConnectorsTab";

const listMock = vi.hoisted(() => vi.fn());
const createMock = vi.hoisted(() => vi.fn());
const createConnectionMock = vi.hoisted(() => vi.fn());
const checkConnectionHealthMock = vi.hoisted(() => vi.fn());
const updateConnectionMock = vi.hoisted(() => vi.fn());
const refreshCatalogMock = vi.hoisted(() => vi.fn());
const archiveConnectionMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/mcp-connectors", () => ({
  mcpConnectorsApi: {
    list: (companyId: string) => listMock(companyId),
    create: (companyId: string, input: { name: string }) => createMock(companyId, input),
    reenroll: vi.fn(),
    revoke: vi.fn(),
  },
}));

vi.mock("@/api/tools", () => ({
  toolsApi: {
    createConnection: (...args: unknown[]) => createConnectionMock(...args),
    checkConnectionHealth: (...args: unknown[]) => checkConnectionHealthMock(...args),
    refreshCatalog: (...args: unknown[]) => refreshCatalogMock(...args),
    updateConnection: (...args: unknown[]) => updateConnectionMock(...args),
    archiveConnection: (...args: unknown[]) => archiveConnectionMock(...args),
  },
}));

vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

function connector(overrides: Partial<McpConnector> = {}): McpConnector {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    name: "Homelab",
    status: "active",
    online: true,
    version: "0.1.0",
    upstreams: ["unifi"],
    lastSeenAt: new Date().toISOString(),
    lastConnectedAt: new Date().toISOString(),
    enrollmentExpiresAt: null,
    credentialRotatedAt: null,
    revokedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("ConnectorsTab", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function render() {
    root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <ConnectorsTab companyId="company-1" />
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  it("shows connector status, version and published upstream names", async () => {
    listMock.mockResolvedValue({
      connectors: [
        connector(),
        connector({ id: "22222222-2222-4222-8222-222222222222", name: "Office", online: false, upstreams: ["nas"] }),
        connector({ id: "33333333-3333-4333-8333-333333333333", name: "Old", status: "revoked", online: false }),
      ],
    });
    await render();
    expect(container.textContent).toContain("Homelab");
    expect(container.textContent).toContain("online");
    expect(container.textContent).toContain("v0.1.0");
    expect(container.textContent).toContain("unifi");
    expect(container.textContent).toContain("offline");
    expect(container.textContent).toContain("revoked");
  });

  it("shows the enrollment token once after creating a connector", async () => {
    listMock.mockResolvedValue({ connectors: [] });
    createMock.mockResolvedValue({
      connector: connector({ status: "pending", online: false, upstreams: [], version: null }),
      enrollmentToken: "pcmce_11111111-1111-4111-8111-111111111111.token",
      enrollmentExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    await render();
    const input = container.querySelector<HTMLInputElement>("#connector-name")!;
    await act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "Homelab");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(() => {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flushReact();
    expect(createMock).toHaveBeenCalledWith("company-1", { name: "Homelab" });
    expect(container.textContent).toContain("PAPERCLIP_MCP_CONNECTOR_ENROLLMENT_TOKEN=pcmce_");
    const done = [...container.querySelectorAll("button")].find((button) => button.textContent === "Done")!;
    await act(() => done.click());
    await flushReact();
    expect(container.textContent).not.toContain("pcmce_");
  });

  it("activates connection before refreshing catalog so action access is created", async () => {
    const callOrder: string[] = [];
    listMock.mockResolvedValue({ connectors: [connector({ upstreams: ["unifi"] })] });
    createConnectionMock.mockImplementation(async () => {
      callOrder.push("createConnection");
      return { id: "conn-123" };
    });
    checkConnectionHealthMock.mockImplementation(async () => {
      callOrder.push("checkConnectionHealth");
      return { status: "ok" };
    });
    updateConnectionMock.mockImplementation(async () => {
      callOrder.push("updateConnection");
      return { id: "conn-123", status: "active" };
    });
    refreshCatalogMock.mockImplementation(async () => {
      callOrder.push("refreshCatalog");
      return { discoveredCount: 5, quarantinedCount: 0 };
    });

    await render();
    const addBtn = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Add connection"))!;
    await act(() => addBtn.click());
    await flushReact();

    const submitBtn = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Connect and discover actions"))!;
    expect(submitBtn).toBeDefined();
    await act(() => submitBtn.click());
    await flushReact();

    expect(callOrder).toEqual([
      "createConnection",
      "checkConnectionHealth",
      "updateConnection",
      "refreshCatalog",
    ]);
  });

  it("archives connection if health check or catalog refresh fails to avoid duplicate drafts", async () => {
    listMock.mockResolvedValue({ connectors: [connector({ upstreams: ["unifi"] })] });
    createConnectionMock.mockResolvedValue({ id: "conn-456" });
    checkConnectionHealthMock.mockRejectedValue(new Error("Upstream unreachable"));
    archiveConnectionMock.mockResolvedValue({ id: "conn-456", status: "archived" });

    await render();
    const addBtn = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Add connection"))!;
    await act(() => addBtn.click());
    await flushReact();

    const submitBtn = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Connect and discover actions"))!;
    await act(() => submitBtn.click());
    await flushReact();

    expect(createConnectionMock).toHaveBeenCalled();
    expect(checkConnectionHealthMock).toHaveBeenCalledWith("conn-456");
    expect(archiveConnectionMock).toHaveBeenCalledWith("conn-456");
  });
});
