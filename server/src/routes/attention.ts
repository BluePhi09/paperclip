import { Router } from "express";
import type { Db } from "@paperclipai/db";
import type { AttentionSortMode } from "@paperclipai/shared";
import { attentionService } from "../services/attention.js";
import { badRequest } from "../errors.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

function optionalQueryString(value: unknown, field: string) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw badRequest(`${field} must be a non-empty string`);
  return value.trim();
}

export function attentionRoutes(db: Db) {
  const router = Router();
  const svc = attentionService(db);

  router.get("/companies/:companyId/attention/expert", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (req.actor.type !== "agent" || !req.actor.agentId) {
      res.status(403).json({ error: "Agent context required" });
      return;
    }
    if (Object.keys(req.query).length > 0) throw badRequest("Expert feed is actor-bound and accepts no filters");
    res.json(await svc.listExpert(companyId, req.actor.agentId));
  });

  router.get("/companies/:companyId/attention", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    if (!req.actor.userId) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }

    const audience = optionalQueryString(req.query.audience, "audience");
    if (audience !== undefined && !["human", "agent", "unclassified", "all"].includes(audience)) {
      throw badRequest("audience must be human, agent, unclassified, or all");
    }
    const resolverAgentId = optionalQueryString(req.query.resolverAgentId, "resolverAgentId");
    const includeDismissed = req.query.includeDismissed === "true";
    const archived = req.query.archived === "true";
    const all = req.query.all === "true";
    const activitySince = optionalQueryString(req.query.activitySince, "activitySince");
    const activityUntil = optionalQueryString(req.query.activityUntil, "activityUntil");
    const queue = optionalQueryString(req.query.queue, "queue");
    const cursor = optionalQueryString(req.query.cursor, "cursor");
    const sortValue = optionalQueryString(req.query.sort, "sort");
    if (sortValue !== undefined && sortValue !== "activity" && sortValue !== "decide") {
      throw badRequest("sort must be 'activity' or 'decide'");
    }
    const limitValue = optionalQueryString(req.query.limit, "limit");
    const limit = limitValue === undefined ? undefined : Number(limitValue);
    if (limit !== undefined && !Number.isInteger(limit)) throw badRequest("limit must be an integer");
    const feed = await svc.list(companyId, {
      userId: req.actor.userId,
      audience: audience as "human" | "agent" | "unclassified" | "all" | undefined,
      resolverAgentId,
      includeDismissed,
      archived,
      all,
      allowUnscopedAll: all,
      activitySince,
      activityUntil,
      queue,
      cursor,
      sort: sortValue as AttentionSortMode | undefined,
      limit,
    });
    res.json(feed);
  });

  return router;
}
