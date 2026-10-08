/**
 * Re-route legacy human Decisions (see doc/DECISIONS-CONCISE-CHAT.md).
 *
 *   plan  (read-only): pnpm decisions:legacy-routing plan --company <id> [--overrides overrides.json] > plan.json
 *   apply (writes):    pnpm decisions:legacy-routing apply --plan plan.json --yes
 *
 * Review plan.json before applying. Apply only executes reviewed reroute/split
 * entries whose cards are unchanged; re-running is a no-op.
 */
import { readFileSync } from "node:fs";
import { createDb } from "../packages/db/src/index.js";
import { loadConfig } from "../server/src/config.js";
import {
  applyLegacyDecisionRouting,
  planLegacyDecisionRouting,
  type LegacyRoutingPlan,
} from "../server/src/services/legacy-decision-routing.js";

function flag(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

async function main() {
  const mode = process.argv[2];
  if (mode !== "plan" && mode !== "apply") {
    throw new Error("Usage: legacy-decision-routing plan --company <id> [--overrides file] | apply --plan file --yes");
  }
  const config = loadConfig();
  const db = createDb(
    process.env.DATABASE_URL?.trim()
    || config.databaseUrl
    || `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`,
  );
  if (mode === "plan") {
    const companyId = flag("--company");
    if (!companyId) throw new Error("--company is required");
    const overridesPath = flag("--overrides");
    const overrides = overridesPath ? JSON.parse(readFileSync(overridesPath, "utf8")) : {};
    const plan = await planLegacyDecisionRouting(db, companyId, overrides);
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    const counts = plan.entries.reduce<Record<string, number>>((acc, entry) => ({ ...acc, [entry.action.type]: (acc[entry.action.type] ?? 0) + 1 }), {});
    console.error(`Planned ${plan.entries.length} human-facing pending cards: ${JSON.stringify(counts)}. Nothing was changed.`);
    return;
  }
  const planPath = flag("--plan");
  if (!planPath) throw new Error("--plan is required");
  if (!process.argv.includes("--yes")) throw new Error("apply changes live cards; review the plan and pass --yes");
  const plan = JSON.parse(readFileSync(planPath, "utf8")) as LegacyRoutingPlan;
  const results = await applyLegacyDecisionRouting(db, plan);
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  if (results.some((result) => result.status === "failed")) process.exitCode = 1;
}

void main().then(() => process.exit(process.exitCode ?? 0)).catch((error) => {
  console.error(`Legacy decision routing failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
