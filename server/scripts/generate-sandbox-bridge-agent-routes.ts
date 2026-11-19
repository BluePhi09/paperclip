// Regenerate the sandbox bridge agent route surface from the server OpenAPI
// authorization metadata. Usage (from the repo root):
//   pnpm --dir server exec tsx scripts/generate-sandbox-bridge-agent-routes.ts
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOpenApiDocument } from "../src/routes/openapi.js";
import {
  buildSandboxBridgeAgentRouteSurface,
  renderSandboxBridgeAgentRoutesModule,
} from "../src/routes/sandbox-bridge-agent-routes.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.resolve(
  here,
  "../../packages/adapter-utils/src/sandbox-callback-bridge-agent-routes.generated.ts",
);
const surface = buildSandboxBridgeAgentRouteSurface(buildOpenApiDocument());
writeFileSync(target, renderSandboxBridgeAgentRoutesModule(surface));
console.log(`wrote ${surface.allowed.length} allowed and ${surface.denied.length} shadow-denied operations to ${target}`);
