import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  authorizeSandboxCallbackBridgeRequestWithRoutes,
  DEFAULT_SANDBOX_CALLBACK_BRIDGE_ROUTE_ALLOWLIST,
} from "@paperclipai/adapter-utils/sandbox-callback-bridge";
import { buildOpenApiDocument } from "../routes/openapi.js";
import {
  buildSandboxBridgeAgentRouteSurface,
  renderSandboxBridgeAgentRoutesModule,
} from "../routes/sandbox-bridge-agent-routes.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const generatedPath = path.resolve(
  here,
  "../../../packages/adapter-utils/src/sandbox-callback-bridge-agent-routes.generated.ts",
);

function concrete(template: string): string {
  return template.replace(/\{[^}]+\}/g, "x-1");
}

describe("sandbox bridge agent route surface", () => {
  const document = buildOpenApiDocument();
  const surface = buildSandboxBridgeAgentRouteSurface(document);

  it("matches the checked-in adapter-utils module (regenerate on drift)", () => {
    // Fix: pnpm --dir server exec tsx scripts/generate-sandbox-bridge-agent-routes.ts
    expect(readFileSync(generatedPath, "utf8")).toBe(renderSandboxBridgeAgentRoutesModule(surface));
  });

  it("allows only operations the server documents for agent actors", () => {
    const actorOf = new Map<string, string | undefined>();
    for (const [route, item] of Object.entries<Record<string, any>>(document.paths)) {
      for (const [verb, operation] of Object.entries<Record<string, any>>(item)) {
        actorOf.set(`${verb.toUpperCase()} ${route}`, operation?.["x-paperclip-authorization"]?.actor);
      }
    }
    const boardLabeledAgentRoutes = new Set([
      "POST /api/issues/{id}/interactions/{interactionId}/accept",
      "POST /api/issues/{id}/interactions/{interactionId}/reject",
      "POST /api/issues/{id}/interactions/{interactionId}/respond",
      "POST /api/issues/{id}/interactions/{interactionId}/withdraw",
    ]);
    for (const [method, route] of surface.allowed) {
      const key = `${method} ${route}`;
      if (boardLabeledAgentRoutes.has(key)) continue;
      expect([key, actorOf.get(key)]).toEqual([key, expect.stringMatching(/^(agent|board_or_agent)$/)]);
    }
  });

  it("denies every board, instance-admin, public and runtime-tools REST operation at the bridge", () => {
    const allowed = new Set(surface.allowed.map(([method, route]) => `${method} ${route}`));
    const leaks: string[] = [];
    for (const [route, item] of Object.entries<Record<string, any>>(document.paths)) {
      if (!route.startsWith("/api/") || route === "/api/openapi.json") continue;
      for (const [verb, operation] of Object.entries<Record<string, any>>(item)) {
        const method = verb.toUpperCase();
        if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) continue;
        if (allowed.has(`${method} ${route}`)) continue;
        const actor = operation?.["x-paperclip-authorization"]?.actor;
        if (actor === "agent" || actor === "board_or_agent") continue; // excluded credential routes are checked below
        if (authorizeSandboxCallbackBridgeRequestWithRoutes({ method, path: concrete(route) }) === null) {
          leaks.push(`${method} ${route} (${actor})`);
        }
      }
    }
    expect(leaks).toEqual([]);
  });

  it("keeps credential management off the bridge but forwards the run-bound secret routes", () => {
    const denied = [
      ["POST", "/api/agents/x-1/keys"],
      ["GET", "/api/companies/x-1/secrets"],
      ["POST", "/api/secrets/x-1/rotate"],
      ["POST", "/api/companies/x-1/exports"],
      ["POST", "/api/tool-gateway/sessions"],
      ["GET", "/api/environments/x-1/secret-refs"],
    ];
    for (const [method, route] of denied) {
      expect(authorizeSandboxCallbackBridgeRequestWithRoutes({ method, path: route })).not.toBeNull();
    }
    const allowed = [
      ["GET", "/api/agents/me/secrets"],
      ["POST", "/api/agents/me/secrets/GITHUB_TOKEN/value"],
      ["GET", "/api/agents/me/secret-proposals"],
      ["POST", "/api/agents/me/secret-proposals"],
      ["DELETE", "/api/agents/me/secret-proposals/x-1"],
    ];
    for (const [method, route] of allowed) {
      expect(authorizeSandboxCallbackBridgeRequestWithRoutes({ method, path: route })).toBeNull();
    }
  });

  it("forwards the routes that used to fail with Route not allowed (grant-gated on the server)", () => {
    for (const [method, route] of [
      ["PUT", "/api/agents/x-1/instructions-bundle/file"],
      ["PATCH", "/api/agents/x-1"],
      ["POST", "/api/companies/x-1/skills"],
      ["GET", "/api/issues/x-1/activity"],
      ["GET", "/api/companies/x-1/costs/quota-windows"],
      ["GET", "/api/companies/x-1/costs/window-spend"],
    ]) {
      expect(authorizeSandboxCallbackBridgeRequestWithRoutes({ method, path: route })).toBeNull();
    }
    expect(DEFAULT_SANDBOX_CALLBACK_BRIDGE_ROUTE_ALLOWLIST.length).toBeGreaterThan(surface.allowed.length);
  });
});
