// @vitest-environment jsdom
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PermissionKey } from "@paperclipai/shared";
import { AgentGrantsEditor, formatGrantScope } from "./AgentGrantsEditor";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function grant(id: string, permissionKey: PermissionKey, scope: Record<string, unknown> | null = null) {
  return { id, permissionKey, scope };
}

function render(props: Partial<Parameters<typeof AgentGrantsEditor>[0]> = {}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  const onReplace = vi.fn();
  const createdRoot = createRoot(container);
  root = createdRoot;
  flushSync(() => {
    createdRoot.render(
      <AgentGrantsEditor
        grants={[
          grant("g1", "tasks:assign"),
          grant("g2", "agents:configure"),
          grant("g3", "tools:use", { projectIds: ["p1"] }),
        ]}
        hasMembership
        onReplace={onReplace}
        {...props}
      />,
    );
  });
  return { onReplace, container: container! };
}

afterEach(() => {
  if (root) flushSync(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("AgentGrantsEditor", () => {
  it("lists every grant with its scope", () => {
    const { container } = render();
    const text = container.textContent ?? "";
    expect(text).toContain("tasks:assign");
    expect(text).toContain("agents:configure");
    expect(text).toContain("tools:use");
    expect(text).toContain('{"projectIds":["p1"]}');
    expect(text).toContain("Company-wide");
  });

  it("removes a single grant and keeps the rest including scope", () => {
    const { container, onReplace } = render();
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Remove agents:configure"]');
    expect(button).not.toBeNull();
    flushSync(() => button!.click());
    expect(onReplace).toHaveBeenCalledWith([
      { permissionKey: "tasks:assign", scope: null },
      { permissionKey: "tools:use", scope: { projectIds: ["p1"] } },
    ]);
  });

  it("adds a company-wide grant from the known permission keys", () => {
    const { container, onReplace } = render();
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="Permission to grant"]')!;
    const options = Array.from(select.options).map((option) => option.value);
    expect(options).not.toContain("tasks:assign");
    expect(options).toContain("tools:use");
    flushSync(() => {
      select.value = "skills:create";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const add = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Add grant")!;
    flushSync(() => add.click());
    expect(onReplace).toHaveBeenCalledWith([
      { permissionKey: "tasks:assign", scope: null },
      { permissionKey: "agents:configure", scope: null },
      { permissionKey: "tools:use", scope: { projectIds: ["p1"] } },
      { permissionKey: "skills:create", scope: null },
    ]);
  });

  it("explains when the agent has no membership", () => {
    const { container } = render({ grants: [], hasMembership: false });
    expect(container.textContent).toContain("no company membership");
    expect(container.querySelector("select")).toBeNull();
  });

  it("formats empty scopes as company-wide", () => {
    expect(formatGrantScope(null)).toBe("Company-wide");
    expect(formatGrantScope({})).toBe("Company-wide");
  });
});
