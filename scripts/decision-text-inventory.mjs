#!/usr/bin/env node
/** Offline, read-only inventory. No database client, network, apply mode or source rewrite. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

export function decisionTextInventory(text) {
  const entries = new Map();
  for (const line of text.split(/\r?\n/).filter(line => line.trim())) {
    let row;
    try { row = JSON.parse(line); } catch {
      const sourceHash = digest(line);
      entries.set(`unparseable:${sourceHash}`, { key: `unparseable:${sourceHash}`, sourceHash, disposition: "blocked_incomplete_export", missingContext: ["Complete JSON source required; truncated exports are not migration inputs."], proposedText: null });
      continue;
    }
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("Each inventory line must be a JSON object");
    const sourceHash = digest(row);
    const identity = row.companyId && row.id ? `${row.companyId}:${row.kind ?? "decision"}:${row.id}` : `unbound:${sourceHash}`;
    const prior = entries.get(identity);
    if (prior && prior.sourceHash !== sourceHash) throw new Error(`Conflicting snapshots for ${identity}; take a single consistent snapshot`);
    const payload = row.payload ?? {};
    const atomic = (payload.questions ?? payload.items ?? []).map(entry => ({
      id: entry.id, decisionClass: entry.brief?.decisionClass ?? "needs_parent_classification",
      disposition: "separate_personal_fact_expert_review_risk_authorization_before_any_effect_migration",
    }));
    const missingContext = [
      ...(!row.id || !row.companyId ? ["Stable source id and companyId"] : []),
      ...(!row.status ? ["Current status"] : []),
      ...(!row.effectiveResolverPolicy ? ["Verified effective resolver policy / human_only"] : []),
      ...(!Object.hasOwn(payload, "target") && !Object.hasOwn(row, "targetSnapshots") ? ["Explicit native target/revision or confirmed absence"] : []),
      ...(!row.createdByAgentId && !row.originAgentId ? ["Verified source agent"] : []),
    ];
    entries.set(identity, {
      key: identity, sourceHash, issue: row.issue ?? row.issueId ?? row.originIssueId ?? null,
      preservation: { status: row.status ?? null, resolverPolicy: row.resolverPolicy ?? null,
        requestedResolverPolicy: row.requestedResolverPolicy ?? row.resolverPolicy ?? null,
        effectiveResolverPolicy: row.effectiveResolverPolicy ?? null,
        target: payload.target ?? row.targetSnapshots ?? null, effectsHash: digest(row.options ?? payload.toolAction ?? payload.secretProposal ?? null) },
      atomic, missingContext, disposition: missingContext.length ? "blocked_missing_context" : "requires_parent_text_and_authority_review",
      proposedText: null,
    });
  }
  return { schema: "paperclip.decision-text-inventory.v1", mode: "read_only", mutations: false,
    automaticApproval: false, entries: [...entries.values()].sort((a, b) => a.key.localeCompare(b.key)),
    nextStep: "Parent validates factual context, atomic question separation, exact source hash, status, human_only, revision and effects. No migration is authorized by this manifest." };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0].startsWith("--")) throw new Error("Usage: node scripts/decision-text-inventory.mjs SNAPSHOT.jsonl (read-only; no --apply)");
  process.stdout.write(`${JSON.stringify(decisionTextInventory(readFileSync(args[0], "utf8")), null, 2)}\n`);
}
