import { Router, type Request } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { companyMemberships, issueInternalNotes, issues, type Db } from "@paperclipai/db";
import { conflict, forbidden, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { persistActivity } from "../services/activity-log.js";

const noteInput = z.object({ body: z.string().trim().min(1).max(8000), clientRequestId: z.string().uuid() }).strict();

/** No agent/API-key/local-implicit access, even when acting for a human. These
 * notes intentionally have no general comments/search/activity integration. */
export function issueInternalNoteRoutes(db: Db) {
  const router = Router();
  async function authorize(req: Request, tx: Db, write = false) {
    if (req.actor.type !== "board" || req.actor.source !== "session" || !req.actor.userId || !req.actor.sessionId) {
      throw forbidden("Sign in as a person to access Internal notes");
    }
    const id = z.string().uuid().parse(req.params.id);
    const [row] = await tx.select({ issue: issues, membership: companyMemberships }).from(issues)
      .innerJoin(companyMemberships, and(eq(companyMemberships.companyId, issues.companyId),
        eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, req.actor.userId),
        eq(companyMemberships.status, "active")))
      .where(eq(issues.id, id)).limit(1);
    if (!row) throw notFound("Task not found");
    if (write && row.membership.membershipRole === "viewer") throw forbidden("Viewer access is read-only");
    return { issue: row.issue, userId: req.actor.userId };
  }
  router.get("/issues/:id/internal-notes", async (req, res) => {
    const { issue } = await authorize(req, db);
    const conditions = [eq(issueInternalNotes.companyId, issue.companyId), eq(issueInternalNotes.issueId, issue.id)];
    if (req.query.before) {
      const id = z.string().uuid().parse(req.query.before);
      const [cursor] = await db.select().from(issueInternalNotes).where(and(...conditions, eq(issueInternalNotes.id, id)));
      if (!cursor) throw notFound("Note not found");
      // Keep PostgreSQL timestamp precision; round-tripping through Date loses
      // microseconds and can skip notes sharing a transaction timestamp.
      conditions.push(sql`(${issueInternalNotes.createdAt}, ${issueInternalNotes.id}) < (
        select n.created_at, n.id from issue_internal_notes n
        where n.id = ${cursor.id} and n.company_id = ${issue.companyId} and n.issue_id = ${issue.id})`);
    }
    const rows = await db.select().from(issueInternalNotes).where(and(...conditions))
      .orderBy(desc(issueInternalNotes.createdAt), desc(issueInternalNotes.id)).limit(51);
    res.set("Cache-Control", "no-store").json({ notes: rows.slice(0, 50), nextCursor: rows.length > 50 ? rows[49].id : null });
  });
  router.post("/issues/:id/internal-notes", validate(noteInput), async (req, res) => {
    const note = await db.transaction(async tx => {
      const { issue, userId } = await authorize(req, tx as unknown as Db, true);
      const [created] = await tx.insert(issueInternalNotes).values({ companyId: issue.companyId, issueId: issue.id,
        authorUserId: userId, body: req.body.body, clientRequestId: req.body.clientRequestId })
        .onConflictDoNothing().returning();
      const [saved] = created ? [created] : await tx.select().from(issueInternalNotes).where(and(
        eq(issueInternalNotes.issueId, issue.id), eq(issueInternalNotes.authorUserId, userId),
        eq(issueInternalNotes.clientRequestId, req.body.clientRequestId)));
      if (!saved || saved.body !== req.body.body) throw conflict("This request ID belongs to a different note");
      if (created) {
        // Audit the mutation once without copying the body or publishing an
        // activity event into the task stream, plugin bus or agent context.
        await persistActivity(tx as unknown as Db, {
          companyId: issue.companyId, actorType: "user", actorId: userId,
          action: "issue_internal_note.created", entityType: "issue_internal_note", entityId: created.id,
        });
      }
      // No task mutation, comment, audit-body copy, wake, SSE payload or outbox.
      return saved;
    });
    res.set("Cache-Control", "no-store").status(201).json(note);
  });
  return router;
}
