/**
 * Legacy Decisions re-routing (plan → reviewed apply).
 *
 * Older human-facing cards were created before audiences and concise briefs
 * existed. Many were routed to the person although parts of them are technical
 * checks. This job re-routes them without guessing:
 *
 * - Every question/item/confirmation is classified only from structured
 *   evidence: a governed tool/secret action, the unit's stored brief
 *   (decision class and resolver target), or an operator-reviewed override that
 *   is bound to the exact source hash. Titles and prose are never used.
 * - Human approvals, personal facts and governed actions stay with the person.
 * - Units with a named expert resolver move to that expert agent.
 * - Mixed cards are split: one card per expert plus one human card.
 * - Anything without structured evidence stays with the person and is listed
 *   as `needs_triage` for review.
 * - Only active/idle/running agents receive cards. A paused, pending-approval,
 *   errored or terminated resolver makes the unit `needs_triage` with a warning.
 * - The plan lists what a replacement cannot carry over (source run/comment
 *   provenance) and every resolver-policy change, so the reviewer sees it.
 * - Every applied re-routing writes one activity-log entry.
 *
 * `plan` is read-only. `apply` re-plans under row locks and executes only the
 * actions whose source hash and action match the reviewed plan. Replacement
 * cards use deterministic idempotency keys and the original card is withdrawn
 * (no wake, no answer, no approval), so a re-run is a no-op.
 */
import { createHash } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, issueThreadInteractions, issues } from "@paperclipai/db";
import { logActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import { decisionBriefSchema, type CreateIssueThreadInteraction } from "@paperclipai/shared";
import { issueThreadInteractionService } from "./issue-thread-interactions.js";
import { isHumanFacingInteraction } from "./human-decision-context.js";

export const LEGACY_DECISION_ROUTING_VERSION = "legacy-decision-routing:v1";

type InteractionRow = typeof issueThreadInteractions.$inferSelect;

export type LegacyRoute =
  | { route: "human"; basis: "governed_action" | "brief_human_class" | "brief_human_resolver" | "override" }
  | { route: "expert"; agentId: string; basis: "brief_expert_resolver" | "override" }
  | { route: "needs_triage"; basis: "no_structured_classification" | "invalid_override" | "partially_answered" | "inactive_resolver" };

export interface LegacyRoutingOverride {
  /** Hash of the exact card content the reviewer classified. */
  sourceHash: string;
  units: Record<string, { route: "human" } | { route: "expert"; agentId: string }>;
}

export interface LegacyRoutingPlanEntry {
  interactionId: string;
  issueId: string;
  kind: string;
  sourceHash: string;
  createdByAgentId: string | null;
  units: Array<{ unitId: string; label: string; route: LegacyRoute }>;
  /** Human-readable review notes: inactive resolvers, dropped provenance, narrowed policy. */
  warnings: string[];
  /** What the replacement cards change compared with the original; null when nothing is replaced. */
  replacementChanges: {
    droppedSourceRunId: string | null;
    droppedSourceCommentId: string | null;
    resolverPolicy: Array<{ group: string; from: string; to: string }>;
  } | null;
  action:
    | { type: "keep_human" }
    | { type: "needs_triage" }
    | { type: "reroute"; agentId: string }
    | { type: "split"; groups: Array<{ key: string; route: "human" | "expert"; agentId?: string; unitIds: string[] }> };
}

export interface LegacyRoutingPlan {
  schema: typeof LEGACY_DECISION_ROUTING_VERSION;
  companyId: string;
  overrides: Record<string, LegacyRoutingOverride>;
  entries: LegacyRoutingPlanEntry[];
}

export type LegacyRoutingApplyResult = {
  interactionId: string;
  status: "applied" | "already_applied" | "skipped_changed" | "skipped_not_actionable" | "failed";
  replacementInteractionIds?: string[];
  error?: string;
};

const ROUTABLE_KINDS = new Set(["ask_user_questions", "request_item_verdicts", "request_confirmation", "request_checkbox_confirmation"]);

const canonical = (value: unknown): unknown => Array.isArray(value)
  ? value.map(canonical)
  : value && typeof value === "object" && !(value instanceof Date)
    ? Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]))
    : value instanceof Date ? value.toISOString() : value;

export function legacyRoutingSourceHash(row: InteractionRow): string {
  return createHash("sha256").update(JSON.stringify(canonical({
    id: row.id, kind: row.kind, status: row.status, title: row.title, summary: row.summary,
    payload: row.payload, result: row.result ?? null,
    requestedResolverPolicy: row.requestedResolverPolicy, effectiveResolverPolicy: row.effectiveResolverPolicy,
    addresseeAgentId: row.addresseeAgentId, addresseeUserId: row.addresseeUserId,
    createdByAgentId: row.createdByAgentId, updatedAt: row.updatedAt,
  }))).digest("hex");
}

type Unit = { unitId: string; label: string; brief: unknown };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function unitsOf(row: InteractionRow): Unit[] {
  const payload = record(row.payload);
  if (row.kind === "ask_user_questions") {
    return (Array.isArray(payload.questions) ? payload.questions : []).map((question) => {
      const q = record(question);
      return { unitId: String(q.id), label: String(q.prompt ?? q.id), brief: q.brief };
    });
  }
  if (row.kind === "request_item_verdicts") {
    return (Array.isArray(payload.items) ? payload.items : []).map((item) => {
      const i = record(item);
      return { unitId: String(i.id), label: String(i.label ?? i.id), brief: i.brief };
    });
  }
  return [{ unitId: "card", label: String(payload.prompt ?? row.title ?? row.id), brief: payload.brief }];
}

/** Agents that can pick up a card now. Everything else must not receive one. */
const ROUTABLE_AGENT_STATUSES = new Set(["active", "idle", "running"]);

type CompanyAgents = ReadonlyMap<string, string>;

function classifyUnit(unit: Unit, governed: boolean, override: LegacyRoutingOverride["units"][string] | undefined,
  overrideValid: boolean, creatorAgentId: string | null, companyAgents: CompanyAgents): LegacyRoute {
  if (governed) return { route: "human", basis: "governed_action" };
  if (override) {
    if (!overrideValid) return { route: "needs_triage", basis: "invalid_override" };
    if (override.route === "human") return { route: "human", basis: "override" };
    if (override.agentId === creatorAgentId || !companyAgents.has(override.agentId)) {
      return { route: "needs_triage", basis: "invalid_override" };
    }
    if (!ROUTABLE_AGENT_STATUSES.has(companyAgents.get(override.agentId)!)) return { route: "needs_triage", basis: "inactive_resolver" };
    return { route: "expert", agentId: override.agentId, basis: "override" };
  }
  const brief = decisionBriefSchema.safeParse(unit.brief);
  if (!brief.success) return { route: "needs_triage", basis: "no_structured_classification" };
  if (brief.data.decisionClass === "personal_fact" || brief.data.decisionClass === "human_risk_decision") {
    return { route: "human", basis: "brief_human_class" };
  }
  const target = brief.data.resolverTarget;
  if (target.type === "agent") {
    if (target.agentId === creatorAgentId || !companyAgents.has(target.agentId)) {
      return { route: "needs_triage", basis: "no_structured_classification" };
    }
    if (!ROUTABLE_AGENT_STATUSES.has(companyAgents.get(target.agentId)!)) return { route: "needs_triage", basis: "inactive_resolver" };
    return { route: "expert", agentId: target.agentId, basis: "brief_expert_resolver" };
  }
  return { route: "human", basis: "brief_human_resolver" };
}

/** Resolver agent a unit names (override first, then brief), for review warnings only. */
function namedResolverAgentId(unit: Unit, override: LegacyRoutingOverride["units"][string] | undefined): string | null {
  if (override) return override.route === "expert" ? override.agentId : null;
  const brief = decisionBriefSchema.safeParse(unit.brief);
  return brief.success && brief.data.resolverTarget.type === "agent" ? brief.data.resolverTarget.agentId : null;
}

function planEntry(row: InteractionRow, override: LegacyRoutingOverride | undefined, companyAgents: CompanyAgents): LegacyRoutingPlanEntry {
  const sourceHash = legacyRoutingSourceHash(row);
  const payload = record(row.payload);
  const governed = payload.toolAction !== undefined || payload.secretProposal !== undefined;
  const overrideValid = override?.sourceHash === sourceHash;
  const partiallyAnswered = row.kind === "request_item_verdicts" && (record(row.result).items as unknown[] | undefined)?.length;
  const warnings: string[] = [];
  const units = unitsOf(row).map((unit) => {
    const route = partiallyAnswered && !governed
      ? { route: "needs_triage", basis: "partially_answered" } as const
      : classifyUnit(unit, governed, override?.units[unit.unitId], overrideValid, row.createdByAgentId, companyAgents);
    if (route.route === "needs_triage" && route.basis === "inactive_resolver") {
      const agentId = namedResolverAgentId(unit, override?.units[unit.unitId]);
      warnings.push(`Unit ${unit.unitId}: resolver agent ${agentId} is ${agentId ? companyAgents.get(agentId) : "unknown"}; it stays with the person until the agent is active again or the unit is re-classified.`);
    }
    return { unitId: unit.unitId, label: unit.label.slice(0, 200), route };
  });
  const base = { interactionId: row.id, issueId: row.issueId, kind: row.kind, sourceHash, createdByAgentId: row.createdByAgentId, units };
  const withAction = (action: LegacyRoutingPlanEntry["action"]): LegacyRoutingPlanEntry => {
    const groups = action.type === "reroute"
      ? [{ key: `expert:${action.agentId}`, route: "expert" as const, agentId: action.agentId }]
      : action.type === "split" ? action.groups : [];
    if (groups.length === 0) return { ...base, warnings, replacementChanges: null, action };
    const resolverPolicy = groups.flatMap((group) => {
      const to = group.route === "expert" ? `addressed_agent:${group.agentId}` : "human_only";
      return to === row.effectiveResolverPolicy ? [] : [{ group: group.key, from: row.effectiveResolverPolicy, to }];
    });
    // Replacement cards are new cards created by the original author; they do not
    // inherit the original source run or source comment (both stay on the withdrawn card).
    if (row.sourceRunId) warnings.push(`Replacement cards will not keep the source run ${row.sourceRunId}; it stays on the withdrawn original.`);
    if (row.sourceCommentId) warnings.push(`Replacement cards will not keep the source comment ${row.sourceCommentId}; it stays on the withdrawn original.`);
    for (const change of resolverPolicy) {
      if (change.to === "human_only") warnings.push(`The human card narrows the resolver policy from ${change.from} to human_only: agents can no longer answer it.`);
    }
    return {
      ...base, warnings, action,
      replacementChanges: { droppedSourceRunId: row.sourceRunId ?? null, droppedSourceCommentId: row.sourceCommentId ?? null, resolverPolicy },
    };
  };
  const expertGroups = new Map<string, string[]>();
  const humanUnits: string[] = [];
  for (const unit of units) {
    if (unit.route.route === "expert") expertGroups.set(unit.route.agentId, [...(expertGroups.get(unit.route.agentId) ?? []), unit.unitId]);
    else humanUnits.push(unit.unitId);
  }
  if (expertGroups.size === 0) {
    return withAction(units.some((unit) => unit.route.route === "needs_triage") ? { type: "needs_triage" } : { type: "keep_human" });
  }
  if (expertGroups.size === 1 && humanUnits.length === 0) {
    return withAction({ type: "reroute", agentId: [...expertGroups.keys()][0]! });
  }
  // Confirmations are one atomic unit, so only questions/items can be split.
  return withAction({
      type: "split",
      groups: [
        ...[...expertGroups.entries()].sort(([a], [b]) => a.localeCompare(b))
          .map(([agentId, unitIds]) => ({ key: `expert:${agentId}`, route: "expert" as const, agentId, unitIds })),
        ...(humanUnits.length ? [{ key: "human", route: "human" as const, unitIds: humanUnits }] : []),
      ],
  });
}

async function pendingHumanFacingRows(db: Db, companyId: string) {
  const rows = await db.select().from(issueThreadInteractions)
    .where(and(eq(issueThreadInteractions.companyId, companyId), eq(issueThreadInteractions.status, "pending")))
    .orderBy(asc(issueThreadInteractions.createdAt), asc(issueThreadInteractions.id));
  return rows.filter((row) => ROUTABLE_KINDS.has(row.kind) && isHumanFacingInteraction(
    { addresseeAgentId: row.addresseeAgentId, addresseeUserId: row.addresseeUserId },
    row.effectiveResolverPolicy,
  ));
}

async function companyAgentStatuses(db: Db, companyId: string): Promise<CompanyAgents> {
  const rows = await db.select({ id: agents.id, status: agents.status }).from(agents).where(eq(agents.companyId, companyId));
  return new Map(rows.map((row) => [row.id, row.status]));
}

/** Read-only: never writes. */
export async function planLegacyDecisionRouting(db: Db, companyId: string, overrides: Record<string, LegacyRoutingOverride> = {}): Promise<LegacyRoutingPlan> {
  const [rows, agentIds] = await Promise.all([pendingHumanFacingRows(db, companyId), companyAgentStatuses(db, companyId)]);
  return {
    schema: LEGACY_DECISION_ROUTING_VERSION,
    companyId,
    overrides,
    entries: rows.map((row) => planEntry(row, overrides[row.id], agentIds)),
  };
}

function subsetPayload(row: InteractionRow, unitIds: readonly string[], keepBrief: (brief: unknown) => boolean) {
  // A replacement is a new card; it must not claim an in-flight runtime request.
  const { runtimeRequestId: _runtimeRequestId, ...payload } = record(row.payload);
  const wanted = new Set(unitIds);
  const stripBrief = <T extends Record<string, unknown>>(entry: T): T => {
    if (entry.brief === undefined || keepBrief(entry.brief)) return entry;
    const { brief: _brief, ...rest } = entry;
    return rest as T;
  };
  if (row.kind === "ask_user_questions") {
    const questions = (payload.questions as Record<string, unknown>[]).filter((question) => wanted.has(String(question.id))).map(stripBrief);
    const questionSet = record(payload.questionSet);
    return {
      ...payload,
      questions,
      ...(payload.questionSet ? {
        questionSet: {
          ...questionSet,
          questions: (questionSet.questions as Record<string, unknown>[]).filter((question) => wanted.has(String(question.id))).map(stripBrief),
        },
      } : {}),
    };
  }
  if (row.kind === "request_item_verdicts") {
    return { ...payload, items: (payload.items as Record<string, unknown>[]).filter((item) => wanted.has(String(item.id))).map(stripBrief) };
  }
  return stripBrief(payload);
}

function briefTargets(brief: unknown, route: "human" | "expert", agentId?: string) {
  const parsed = decisionBriefSchema.safeParse(brief);
  if (!parsed.success) return false;
  const target = parsed.data.resolverTarget;
  return route === "human" ? target.type === "human" : target.type === "agent" && target.agentId === agentId;
}

function replacementInput(row: InteractionRow, group: { key: string; route: "human" | "expert"; agentId?: string; unitIds: string[] }) {
  const payload = subsetPayload(row, group.unitIds, (brief) => briefTargets(brief, group.route, group.agentId));
  return {
    kind: row.kind,
    idempotencyKey: `${LEGACY_DECISION_ROUTING_VERSION}:${row.id}:${group.key}`,
    title: row.title,
    summary: row.summary,
    continuationPolicy: row.continuationPolicy,
    ...(group.route === "expert"
      ? { addresseeAgentId: group.agentId }
      : { resolverPolicy: "human_only", ...(row.addresseeUserId ? { addresseeUserId: row.addresseeUserId } : {}) }),
    payload,
  } as unknown as CreateIssueThreadInteraction;
}

function sameAction(a: LegacyRoutingPlanEntry["action"], b: LegacyRoutingPlanEntry["action"]) {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/**
 * Executes the reviewed plan. Only `reroute`/`split` entries are touched, and
 * only while the card is unchanged since review. Safe to re-run.
 */
export async function applyLegacyDecisionRouting(db: Db, plan: LegacyRoutingPlan): Promise<LegacyRoutingApplyResult[]> {
  if (plan.schema !== LEGACY_DECISION_ROUTING_VERSION) throw new Error("Unsupported legacy decision routing plan");
  const agentIds = await companyAgentStatuses(db, plan.companyId);
  const results: LegacyRoutingApplyResult[] = [];
  for (const reviewed of plan.entries) {
    if (reviewed.action.type !== "reroute" && reviewed.action.type !== "split") continue;
    const publications: ActivityPublication[] = [];
    try {
      results.push(await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        // Same lock order as interaction creation and resolution: issue, then card.
        const [issue] = await tx.select({ id: issues.id, companyId: issues.companyId, status: issues.status }).from(issues)
          .where(and(eq(issues.id, reviewed.issueId), eq(issues.companyId, plan.companyId))).for("update");
        const [row] = await tx.select().from(issueThreadInteractions)
          .where(and(eq(issueThreadInteractions.id, reviewed.interactionId), eq(issueThreadInteractions.companyId, plan.companyId)))
          .for("update");
        if (!issue || !row) return { interactionId: reviewed.interactionId, status: "skipped_changed" } as const;
        if (row.status !== "pending") {
          const reason = String(record(row.result).reason ?? "");
          return reason.startsWith(LEGACY_DECISION_ROUTING_VERSION)
            ? { interactionId: row.id, status: "already_applied" } as const
            : { interactionId: row.id, status: "skipped_changed" } as const;
        }
        const current = planEntry(row, plan.overrides[row.id], agentIds);
        if (current.sourceHash !== reviewed.sourceHash || !sameAction(current.action, reviewed.action)) {
          return { interactionId: row.id, status: "skipped_changed" } as const;
        }
        const groups = current.action.type === "reroute"
          ? [{ key: `expert:${current.action.agentId}`, route: "expert" as const, agentId: current.action.agentId, unitIds: current.units.map((unit) => unit.unitId) }]
          : current.action.type === "split" ? current.action.groups : [];
        const svc = issueThreadInteractionService(txDb);
        const creator = { agentId: row.createdByAgentId, userId: row.createdByUserId };
        const replacements = [];
        for (const group of groups) {
          replacements.push(await svc.create(
            { id: row.issueId, companyId: row.companyId },
            replacementInput(row, group),
            creator,
            { supersedePendingSiblingInteractions: false },
          ));
        }
        const replacementIds = replacements.map((interaction) => interaction.id);
        await svc.withdrawInteraction(
          issue,
          row.id,
          { reason: `${LEGACY_DECISION_ROUTING_VERSION}: re-routed to ${replacementIds.join(", ")}` },
          { systemId: LEGACY_DECISION_ROUTING_VERSION },
        );
        await logActivity(txDb, {
          companyId: row.companyId,
          actorType: "system",
          actorId: LEGACY_DECISION_ROUTING_VERSION,
          action: "issue.thread_interaction_rerouted",
          entityType: "issue",
          entityId: row.issueId,
          issueId: row.issueId,
          details: {
            interactionId: row.id,
            interactionKind: row.kind,
            withdrawn: true,
            actionType: current.action.type,
            groups: groups.map((group, index) => ({ key: group.key, unitIds: group.unitIds, replacementInteractionId: replacementIds[index] })),
            replacementInteractionIds: replacementIds,
            sourceHash: current.sourceHash,
            droppedSourceRunId: row.sourceRunId ?? null,
            droppedSourceCommentId: row.sourceCommentId ?? null,
          },
        }, publications);
        return { interactionId: row.id, status: "applied", replacementInteractionIds: replacementIds } as const;
      }));
      for (const publication of publications) publishActivity(publication);
    } catch (error) {
      results.push({ interactionId: reviewed.interactionId, status: "failed", error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}
