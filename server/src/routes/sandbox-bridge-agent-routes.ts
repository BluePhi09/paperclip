/**
 * Derive the sandbox callback bridge route surface from the server's own
 * route authorization metadata (`x-paperclip-authorization` in the OpenAPI
 * document) instead of a hand-maintained regex list.
 *
 * Bridge rule: a sandboxed run may reach an operation through the bridge iff
 * the server documents that operation as callable by an agent actor
 * (`agent` or `board_or_agent`). The bridge then forwards the request with the
 * run's own agent JWT, so the route's normal authorization (company scope,
 * `access.decide` grants such as `agents:configure`, consent gates, task
 * binding) decides the outcome. Board-only, instance-admin, public and
 * runtime-tools operations stay denied at the bridge (deny by default).
 *
 * Credential and secret management stays denied at the bridge even where the
 * server would let an agent call it: the bridge response flows back into the
 * sandbox and its run log, so these keep using their dedicated clients. The
 * run-bound secret and secret-proposal routes documented in the Paperclip
 * skill are the explicit exception.
 *
 * The result is checked in as
 * `packages/adapter-utils/src/sandbox-callback-bridge-agent-routes.generated.ts`
 * (adapter-utils cannot import the server). A server test fails when the
 * checked-in file drifts from this function's output.
 */

type Json = Record<string, any>;

export type SandboxBridgeOperation = readonly [method: string, pathTemplate: string];

export interface SandboxBridgeAgentRouteSurface {
  /** Operations an agent actor may call; the bridge forwards them. */
  allowed: SandboxBridgeOperation[];
  /**
   * Operations that are NOT bridge-callable but whose concrete paths a more
   * generic allowed template would also match (for example the board-only
   * `GET /api/companies/stats` versus `GET /api/companies/{companyId}`). The
   * bridge checks these first so the generic template cannot widen them.
   */
  denied: SandboxBridgeOperation[];
}

const METHODS = new Set(["get", "post", "put", "patch", "delete"]);
const AGENT_ACTORS = new Set(["agent", "board_or_agent"]);

/**
 * Operations the OpenAPI metadata labels board-only although the route
 * authorizes agents itself. Each handler calls
 * `getIssueThreadInteractionResolutionAuthorization`, which only applies
 * `assertBoard` to non-agent actors and then checks run attribution,
 * containment, and resolver policy for agents. The previous static bridge
 * allowlist admitted them, so dropping them would regress interaction flows.
 */
const AGENT_AUTHORIZED_ROUTES_LABELED_BOARD = new Set([
  "POST /api/issues/{id}/interactions/{interactionId}/accept",
  "POST /api/issues/{id}/interactions/{interactionId}/reject",
  "POST /api/issues/{id}/interactions/{interactionId}/respond",
  "POST /api/issues/{id}/interactions/{interactionId}/withdraw",
]);

/** Same protocol classification the native runner's `call_api` uses. */
function isProtocolOperation(path: string, operation: Json): boolean {
  return !path.startsWith("/api/")
    || /\/(oauth|auth|runtime-tools|mcp|ws)(\/|$)/.test(path)
    || /\/(claude-login|login-sessions|start-authorization|finalize-oauth-access)(\/|$)/.test(path)
    || /event-stream|websocket/i.test(JSON.stringify(operation.responses ?? {}));
}

const RUN_BOUND_SECRET_ROUTES = new Set([
  "GET /api/agents/me/secrets",
  "POST /api/agents/me/secrets/{key}/value",
  "GET /api/agents/me/secret-proposals",
  "POST /api/agents/me/secret-proposals",
  "DELETE /api/agents/me/secret-proposals/{id}",
]);

/** Credential, export and token surfaces that never ride the generic bridge. */
export function isSandboxBridgeCredentialRoute(method: string, path: string): boolean {
  if (RUN_BOUND_SECRET_ROUTES.has(`${method} ${path}`)) return false;
  return /^\/api\/tool-gateway\/sessions(\/|$)/.test(path)
    || /^\/api\/chat-identity-links(\/|$)/.test(path)
    || /\/chat-endpoints\/\{[^}]+\}\/principals\/\{[^}]+\}\/link(?:-intent)?$/.test(path)
    || /^\/api\/companies\/\{[^}]+\}\/exports?(\/|$)/.test(path)
    || /\/(secrets|setup-secret|secret-proposals|secret-provider-configs|secret-refs|user-secrets|user-secret-definitions|keys|board-api-keys|credentials|setup-token-login-sessions|board-claim|invites|join-requests|gateway-tokens|tokens|token|rotate-secret|terminal-session-token|claim-api-key)(\/|$)/.test(path);
}

function segments(path: string): string[] {
  return path.replace(/^\//, "").split("/");
}

function isParam(segment: string): boolean {
  return /^\{[^}]+\}$/.test(segment);
}

/**
 * True when `specific` has a literal wherever `generic` has a literal (equal)
 * and at least one literal where `generic` has a parameter, so some concrete
 * path matches both and `specific` is the intended route for it.
 */
function shadows(generic: string, specific: string): boolean {
  const a = segments(generic);
  const b = segments(specific);
  if (a.length !== b.length) return false;
  let narrower = false;
  for (let i = 0; i < a.length; i += 1) {
    if (isParam(a[i])) {
      if (!isParam(b[i])) narrower = true;
      continue;
    }
    if (isParam(b[i]) || a[i] !== b[i]) return false;
  }
  return narrower;
}

export function buildSandboxBridgeAgentRouteSurface(document: Json): SandboxBridgeAgentRouteSurface {
  const allowed: SandboxBridgeOperation[] = [];
  const excluded: SandboxBridgeOperation[] = [];
  for (const [path, item] of Object.entries<Json>(document.paths ?? {})) {
    for (const [verb, operation] of Object.entries<Json>(item)) {
      if (!METHODS.has(verb)) continue;
      const method = verb.toUpperCase();
      const actor = operation?.["x-paperclip-authorization"]?.actor;
      const callable = (AGENT_ACTORS.has(actor) || AGENT_AUTHORIZED_ROUTES_LABELED_BOARD.has(`${method} ${path}`))
        && !isProtocolOperation(path, operation)
        && !isSandboxBridgeCredentialRoute(method, path);
      (callable ? allowed : excluded).push([method, path]);
    }
  }
  const denied = excluded.filter(([method, path]) =>
    path.startsWith("/api/")
    && allowed.some(([allowedMethod, allowedPath]) => allowedMethod === method && shadows(allowedPath, path)));
  const order = (a: SandboxBridgeOperation, b: SandboxBridgeOperation) =>
    a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]);
  return { allowed: allowed.sort(order), denied: denied.sort(order) };
}

/** Render the checked-in adapter-utils module. */
export function renderSandboxBridgeAgentRoutesModule(surface: SandboxBridgeAgentRouteSurface): string {
  const list = (ops: SandboxBridgeOperation[]) =>
    ops.map(([method, path]) => `  [${JSON.stringify(method)}, ${JSON.stringify(path)}],`).join("\n");
  return [
    "// GENERATED FILE. Do not edit by hand.",
    "// Source: server/src/routes/sandbox-bridge-agent-routes.ts (server OpenAPI",
    "// `x-paperclip-authorization` metadata). Regenerate with",
    "//   pnpm --dir server exec tsx scripts/generate-sandbox-bridge-agent-routes.ts",
    "// The server test `sandbox-bridge-agent-routes.test.ts` fails on drift.",
    "",
    "/** Agent-callable REST operations the sandbox bridge forwards (method, path template). */",
    "export const SANDBOX_CALLBACK_BRIDGE_AGENT_API_OPERATIONS: ReadonlyArray<readonly [string, string]> = [",
    list(surface.allowed),
    "];",
    "",
    "/** Non-agent operations a generic allowed template would otherwise shadow; checked first. */",
    "export const SANDBOX_CALLBACK_BRIDGE_DENIED_API_OPERATIONS: ReadonlyArray<readonly [string, string]> = [",
    list(surface.denied),
    "];",
    "",
  ].join("\n");
}
