import { Router, type Request, type RequestHandler } from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { governanceServices, type Db } from "@paperclipai/db";
import { governanceService } from "../services/governance-verification.js";
import { assertCompanyAccess } from "./authz.js";
import { forbidden, notFound, unprocessable } from "../errors.js";

const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const consumePath = new RegExp(`^/api/governance/dsm/v1/verifications/(${uuid})/consume$`);
const eventPath = new RegExp(`^/api/governance/dsm/v1/dispatches/(${uuid})/events$`);
/** Terminal interception: no machine principal is ever installed in the legacy actor union. */
export function governanceMachineBoundary(db: Db): RequestHandler {
  const svc = governanceService(db);
  return async (req, res, next) => {
    const authorization = req.header("authorization") ?? "";
    const bearer = /^bearer\s+(pcgov_\S*)\s*$/i.exec(authorization);
    const machineBearer = /^bearer\s+pcgov_/i.test(authorization);
    const dedicatedPath = req.path.startsWith("/api/governance/dsm/v1/");
    if (!machineBearer && !dedicatedPath) return next();
    const consume = consumePath.exec(req.path);
    const event = eventPath.exec(req.path);
    if (req.method !== "POST" || !(consume || event || req.path === "/api/governance/dsm/v1/verifications")) {
      res.status(403).json({ code: "governance_route_denied" }); return;
    }
    if (!bearer) { res.status(401).json({ code: "governance_credential_required" }); return; }
    try {
      const principal = event ? await svc.authenticateOutcome(bearer[1]!) : await svc.authenticate(bearer[1]!);
      res.set("Cache-Control", "no-store");
      res.json(consume
        ? await svc.consume(principal, consume[1]!, req.body)
        : event ? await svc.appendEvent(principal, event[1]!, req.body)
          : await svc.verify(principal, req.body));
    } catch (err) { next(err); }
  };
}

function owner(req: Request, companyId: string) {
  // Local implicit Board and generic agent/Board keys are not owner authority.
  if (req.actor.type !== "board" || !req.actor.userId || req.actor.source !== "session"
    || !req.actor.memberships?.some(m => m.companyId === companyId && m.status === "active" && m.membershipRole === "owner")) {
    throw forbidden("Explicit company owner session required");
  }
  assertCompanyAccess(req, companyId);
  return req.actor.userId;
}

export function governanceOwnerRoutes(db: Db) {
  const router = Router();
  const svc = governanceService(db);
  async function scopedOwner(req: Request) {
    const companyId = String(req.params.companyId);
    const ownerUserId = owner(req, companyId);
    const serviceId = z.string().uuid().safeParse(req.params.serviceId);
    if (!serviceId.success) throw notFound("Governance service not found");
    const [service] = await db.select({ id: governanceServices.id }).from(governanceServices).where(and(
      eq(governanceServices.id, serviceId.data), eq(governanceServices.companyId, companyId),
      eq(governanceServices.ownerUserId, ownerUserId),
    ));
    if (!service) throw notFound("Governance service not found");
    return { serviceId: service.id, ownerUserId };
  }
  router.post("/companies/:companyId/governance/services", async (req, res) => {
    const companyId = String(req.params.companyId);
    const ownerUserId = owner(req, companyId);
    const body = z.object({ nasTarget: z.string().regex(/^[A-Za-z0-9._-]{1,80}$/) }).strict().safeParse(req.body);
    if (!body.success) throw unprocessable("Invalid service request");
    res.set("Cache-Control", "no-store").status(201).json(await svc.createService({ companyId, ownerUserId, nasTarget: body.data.nasTarget }));
  });
  router.delete("/companies/:companyId/governance/services/:serviceId", async (req, res) => {
    const scope = await scopedOwner(req);
    await svc.revokeService(scope.serviceId, scope.ownerUserId);
    res.status(204).end();
  });
  router.get("/companies/:companyId/governance/services/:serviceId/credentials", async (req, res) => {
    const scope = await scopedOwner(req);
    res.set("Cache-Control", "no-store").json(await svc.listCredentials(scope.serviceId, scope.ownerUserId));
  });
  router.post("/companies/:companyId/governance/services/:serviceId/credentials", async (req, res) => {
    const scope = await scopedOwner(req);
    const body = z.object({ expiresAt: z.string().datetime() }).strict().safeParse(req.body);
    if (!body.success) throw unprocessable("Invalid credential request");
    res.set("Cache-Control", "no-store").status(201).json(await svc.issueCredential(scope.serviceId, scope.ownerUserId, new Date(body.data.expiresAt)));
  });
  router.delete("/companies/:companyId/governance/services/:serviceId/credentials/:credentialId", async (req, res) => {
    const scope = await scopedOwner(req);
    const id = z.string().uuid().safeParse(req.params.credentialId);
    if (!id.success) throw notFound("Governance credential not found");
    await svc.revokeCredential(scope.serviceId, id.data, scope.ownerUserId);
    res.status(204).end();
  });
  return router;
}
