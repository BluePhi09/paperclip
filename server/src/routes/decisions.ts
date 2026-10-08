import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import {
  createDecisionArchiveProposalSchema,
  decisionBriefMetadataSchema,
  decisionBriefSchema,
  decisionInputsSchema,
  decisionOptionsSchema,
  type AttentionArchiveManifestEntry,
  type AttentionArchiveTargetSnapshot,
  type AttentionItem,
  type CreateDecisionArchiveProposalInput,
  type DecisionBrief,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { decisionService, type DecisionServiceOptions } from "../services/decisions.js";
import { assertBoard, assertBoardOrAgent, assertCompanyAccess, getAccessibleResource, getActorInfo } from "./authz.js";
import { attentionService } from "../services/attention.js";
import { authorizationDeniedDetails, authorizationService } from "../services/authorization.js";
import { canReadDecisionSource } from "../services/decision-queues.js";
import { hashAttentionArchiveManifest } from "../services/decision-retention.js";
import { forbidden, unprocessable } from "../errors.js";

const createSchema = z.object({
  title: z.string().trim().min(1).max(500),
  body: z.string().max(100_000),
  ruleKey: z.string().trim().max(240).nullable().optional(),
  options: decisionOptionsSchema,
  inputs: decisionInputsSchema.nullable().optional(),
  expiresAt: z.coerce.date().optional(),
  idempotencyKey: z.string().trim().min(1).max(500).nullable().optional(),
  continuationPolicy: z.enum(["none", "wake_origin_agent"]).optional(),
  metadata: decisionBriefMetadataSchema.optional(),
}).strict();
const bundleSchema = z.object({ title: z.string().trim().min(1).max(500), summary: z.string().max(100_000), decisions: z.array(createSchema).min(1).max(50) }).strict();
const decideSchema = z.object({ optionId: z.string().trim().min(1).max(120), inputValues: z.record(z.string(), z.string().max(20_000)).optional(), idempotencyKey: z.string().trim().min(1).max(500).nullable().optional() }).strict();
const dismissSchema = z.object({ reason: z.string().max(20_000).nullable().optional() }).strict();
const statsQuerySchema = z.object({
  groupBy: z.literal("ruleKey"),
  originAgentId: z.string().guid().optional(),
  since: z.coerce.date().optional(),
}).strict();

function agentContext(req: Parameters<typeof getActorInfo>[0]) {
  if (req.actor.type !== "agent" || !req.actor.agentId || !req.actor.runId) return null;
  return { agentId: req.actor.agentId, runId: req.actor.runId };
}

function boardUserId(req: Parameters<typeof getActorInfo>[0]) {
  assertBoard(req);
  return req.actor.userId ?? "local-implicit-board";
}

/**
 * Deterministic brief for the native archive proposal. Archiving is reversible
 * shelf housekeeping: it neither answers nor deletes the archived items.
 */
export function attentionArchiveProposalBrief(manifest: readonly AttentionArchiveManifestEntry[], manifestHash: string): DecisionBrief {
  const count = manifest.length;
  const items = count === 1 ? "1 aging item" : `${count} aging items`;
  return decisionBriefSchema.parse({
    version: 1,
    decisionClass: "human_risk_decision",
    purpose: "execution_authorization",
    subject: `Archive ${items} from your Decisions list?`,
    mainSummary: `An agent reviewed ${items} that have been waiting past the retention threshold and proposes moving them to the archive. Archived items leave the active list; they are not answered, approved or deleted, and you can restore them from the archived filter.`,
    resolverTarget: { type: "human", reason: "Only you decide which of your open items leave your active list." },
    evidenceRefs: [{ source: "attention-archive-manifest", revision: manifestHash }],
    selectionConsequences: [
      { optionId: "archive", label: "Archive reviewed items", consequence: "Move exactly the listed items to the archive if none of them changed since the proposal." },
      { optionId: "keep", label: "Keep items", consequence: "Leave all listed items in the active list." },
    ],
    safeDefault: "Leave all listed items in the active list.",
    reason: "Aging items crowd out current decisions; each listed item names the agent's reason below.",
    scope: `Only the ${items} listed below, at their reviewed versions.`,
    excludedScope: "No item is answered, approved, rejected or deleted, and no other item is archived.",
    risks: "An archived item no longer appears in the default list until you restore it, so a still-relevant request may be overlooked.",
    preconditions: ["Every listed item must be unchanged since the proposal; otherwise nothing is archived."],
  });
}

export function decisionRoutes(db: Db, options: DecisionServiceOptions) {
  const router = Router();
  const svc = decisionService(db, options);
  router.post(
    "/companies/:companyId/decision-archive-proposals",
    validate(createDecisionArchiveProposalSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const agent = agentContext(req);
      if (!agent) {
        res.status(403).json({ error: "Agent run context required" });
        return;
      }
      const access = await authorizationService(db).decide({
        actor: req.actor,
        action: "decision_triage:manage",
        resource: { type: "company", companyId },
      });
      if (!access.allowed) throw forbidden(access.explanation, authorizationDeniedDetails(access));

      const proposal = req.body as CreateDecisionArchiveProposalInput;
      const requested = new Map<string, CreateDecisionArchiveProposalInput["items"][number]>(proposal.items.map((item) => [
        `${item.sourceKind}:${item.sourceId}`,
        item,
      ]));
      const found = new Map<string, AttentionItem>();
      const snapshot = await db.transaction(async (tx) => attentionService(tx as unknown as Db).list(companyId, {
        includeDismissed: true,
        all: true,
        allowUnscopedAll: true,
      }), { isolationLevel: "repeatable read" });
      for (const item of snapshot.items) {
        const key = `${item.sourceKind}:${item.subject.id}`;
        if (requested.has(key)) found.set(key, item);
      }

      const manifest: AttentionArchiveManifestEntry[] = [];
      for (const [key, item] of [...requested.entries()].sort(([left], [right]) => left.localeCompare(right))) {
        const attentionItem = found.get(key);
        if (!attentionItem || !attentionItem.shelf || attentionItem.archivedAt) {
          throw unprocessable("Every archive proposal item must be on the current aging shelf");
        }
        if (!(await canReadDecisionSource(db, req.actor, companyId, attentionItem.sourceKind, attentionItem.subject.id))) {
          throw unprocessable("Every archive proposal item must be on the current aging shelf");
        }
        manifest.push({
          companyId,
          sourceKind: attentionItem.sourceKind,
          sourceId: attentionItem.subject.id,
          expectedVersion: attentionItem.retentionVersion,
          activityAt: attentionItem.activityAt,
          reason: item.reason,
        });
      }
      const manifestHash = hashAttentionArchiveManifest(manifest);
      const targetSnapshots = Object.fromEntries(manifest.map((entry) => [
        `attention:${entry.sourceKind}:${entry.sourceId}`,
        {
          status: "attention",
          assigneeAgentId: null,
          assigneeUserId: null,
          updatedAt: entry.activityAt,
          attentionArchive: entry,
        } satisfies AttentionArchiveTargetSnapshot,
      ]));
      const body = manifest.map((entry) => `- **${entry.sourceKind}:${entry.sourceId}** — ${entry.reason}`).join("\n");
      const created = await svc.create({
        companyId,
        actor: req.actor,
        ...agent,
        title: `Archive ${manifest.length} aging decision${manifest.length === 1 ? "" : "s"}?`,
        body,
        ruleKey: "attention.bulk_archive",
        idempotencyKey: proposal.idempotencyKey ?? `attention-archive:${manifestHash}:${agent.runId}`,
        continuationPolicy: "wake_origin_agent",
        options: [
          { id: "archive", label: "Archive reviewed items", style: "destructive", effects: [] },
          { id: "keep", label: "Keep items", effects: [] },
        ],
        metadata: { kind: "attention_archive_proposal", manifestHash, brief: attentionArchiveProposalBrief(manifest, manifestHash) },
        additionalTargetSnapshots: targetSnapshots,
        requireHumanBrief: true,
      });
      res.status(201).json(created);
    },
  );
  router.post("/companies/:companyId/decisions", validate(createSchema), async (req, res) => {
    const companyId = req.params.companyId as string; assertCompanyAccess(req, companyId);
    const agent = agentContext(req); if (!agent) { res.status(403).json({ error: "Agent run context required" }); return; }
    res.status(201).json(await svc.create({ companyId, actor: req.actor, ...agent, ...req.body, requireHumanBrief: true }));
  });
  router.post("/companies/:companyId/decision-bundles", validate(bundleSchema), async (req, res) => {
    const companyId = req.params.companyId as string; assertCompanyAccess(req, companyId);
    const agent = agentContext(req); if (!agent) { res.status(403).json({ error: "Agent run context required" }); return; }
    const body = req.body as z.infer<typeof bundleSchema>;
    res.status(201).json(await svc.createBundle({
      companyId, actor: req.actor, ...agent, ...body,
      decisions: body.decisions.map((decision) => ({ ...decision, requireHumanBrief: true })),
    }));
  });
  router.get("/companies/:companyId/decisions", async (req, res) => {
    const companyId = req.params.companyId as string; assertBoard(req); assertCompanyAccess(req, companyId);
    const query = z.object({ status: z.enum(["open", "decided", "expired", "cancelled"]).optional(), bundleId: z.string().guid().optional(), targetIssueId: z.string().guid().optional(), originAgentId: z.string().guid().optional(), limit: z.coerce.number().int().positive().max(100).optional() }).safeParse(req.query);
    if (!query.success) { res.status(400).json({ error: "Invalid decision filters", details: query.error.flatten() }); return; }
    res.json(await svc.list(companyId, query.data));
  });
  /**
   * Gardener telemetry contract:
   * { groupBy: "ruleKey", filters: { originAgentId: string|null, since: ISO-8601|null },
   *   totals: { proposed, accepted, rejected, expired },
   *   groups: [{ ruleKey: string|null, proposed, accepted, rejected, expired,
   *     chosenOptions: [{ optionId, count }] }] }
   * Accepted means a non-dismissed decided outcome; rejected means an explicit dismiss;
   * chosenOptions counts accepted outcomes only; expired is separate, and cancelled
   * decisions contribute only to proposed.
   */
  router.get("/companies/:companyId/decisions/stats", async (req, res) => {
    const companyId = req.params.companyId as string; assertBoardOrAgent(req); assertCompanyAccess(req, companyId);
    const query = statsQuerySchema.safeParse(req.query);
    if (!query.success) { res.status(400).json({ error: "Invalid decision stats filters", details: query.error.flatten() }); return; }
    if (req.actor.type === "agent" && query.data.originAgentId && query.data.originAgentId !== req.actor.agentId) {
      res.status(403).json({ error: "Agents may only read their own decision stats" }); return;
    }
    const originAgentId = req.actor.type === "agent" ? req.actor.agentId : query.data.originAgentId;
    res.json(await svc.stats(companyId, { originAgentId, since: query.data.since }));
  });
  router.get("/decisions/:id", async (req, res) => {
    assertBoardOrAgent(req);
    const decision = await getAccessibleResource(req, res, svc.get(req.params.id as string), "Decision not found");
    if (!decision) return;
    if (req.actor.type === "agent" && req.actor.agentId !== decision.originAgentId) { res.status(403).json({ error: "Only the origin agent may read this decision" }); return; }
    res.json(await svc.outcome(decision.id));
  });
  router.post("/decisions/:id/decide", validate(decideSchema), async (req, res) => {
    const userId = boardUserId(req);
    const decision = await getAccessibleResource(req, res, svc.get(req.params.id as string), "Decision not found");
    if (!decision) return;
    res.json(await svc.decide({ id: decision.id, decidedByUserId: userId, userActor: req.actor, ...req.body }));
  });
  router.post("/decisions/:id/dismiss", validate(dismissSchema), async (req, res) => {
    const userId = boardUserId(req);
    const decision = await getAccessibleResource(req, res, svc.get(req.params.id as string), "Decision not found");
    if (!decision) return;
    res.json(await svc.dismiss(decision.id, userId, req.actor, req.body.reason));
  });
  router.post("/decisions/:id/cancel", async (req, res) => {
    assertBoardOrAgent(req);
    const decision = await getAccessibleResource(req, res, svc.get(req.params.id as string), "Decision not found");
    if (!decision) return;
    const actor = getActorInfo(req); res.json(await svc.cancel(decision.id, { actorType: actor.actorType, actorId: actor.actorId, runId: actor.runId }));
  });
  return router;
}
