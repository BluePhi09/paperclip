import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agentWakeupRequests, chatActions, chatPublications, companies, companyMemberships, createDb,
  issueComments, issueInternalNotes, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { issueInternalNoteRoutes } from "../routes/issue-internal-notes.js";
import { errorHandler } from "../middleware/error-handler.js";
import { issueService } from "../services/issues.js";
import { companySearchService } from "../services/company-search.js";
import { companySearchQuerySchema } from "@paperclipai/shared";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("human-only Internal notes", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("paperclip-private-notes-"); db = createDb(database.connectionString); }, 90000);
  afterAll(async () => { await db?.$client.end({ timeout: 0 }); await database?.cleanup(); });
  async function fixture() {
    const companyId = randomUUID(), issueId = randomUUID(), userId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Private notes", issuePrefix: companyId.slice(0, 8) });
    await db.insert(issues).values({ id: issueId, companyId, title: "Thread", status: "in_review" });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "owner" });
    const actor = { type: "board", source: "session", sessionId: randomUUID(), userId, companyIds: [companyId] };
    const appFor = (override = {}) => {
      const app = express(); app.use(express.json());
      app.use((req, _res, next) => { (req as any).actor = { ...actor, ...override }; next(); });
      app.use("/api", issueInternalNoteRoutes(db)); app.use(errorHandler);
      return app;
    };
    return { companyId, issueId, userId, actor, appFor, path: `/api/issues/${issueId}/internal-notes` };
  }
  it("stores one idempotent note separately without comments, search, task mutation, work or publication", async () => {
    const f = await fixture(), app = f.appFor();
    const input = { body: "human-only-canary-91427", clientRequestId: randomUUID() };
    const before = await db.select().from(issues).where(eq(issues.id, f.issueId));
    const [a, b] = await Promise.all([request(app).post(f.path).send(input), request(app).post(f.path).send(input)]);
    expect(a.status).toBe(201); expect(b.body.id).toBe(a.body.id);
    expect((await request(app).get(f.path)).body.notes).toHaveLength(1);
    expect((await request(app).get(f.path)).headers["cache-control"]).toBe("no-store");
    expect(await db.select().from(issues).where(eq(issues.id, f.issueId))).toEqual(before);
    for (const table of [issueComments, chatPublications, chatActions, agentWakeupRequests]) {
      expect(await db.select().from(table).where(eq(table.companyId, f.companyId))).toHaveLength(0);
    }
    const audit = await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "issue_internal_note.created", entityType: "issue_internal_note",
      entityId: a.body.id, actorType: "user", actorId: f.userId, details: null });
    expect(JSON.stringify(audit)).not.toContain(input.body);
    expect(await issueService(db).listComments(f.issueId)).toHaveLength(0);
    expect((await companySearchService(db).search(f.companyId, companySearchQuerySchema.parse({ q: input.body }))).results).toHaveLength(0);
    expect((await request(app).post(f.path).send({ ...input, body: "different" })).status).toBe(409);
  });
  it.each([
    { type: "agent", onBehalfOfUserId: "human" }, { type: "none" },
    { source: "board_api_key" }, { source: "local_implicit" }, { sessionId: undefined },
  ])("denies non-human-session access on both paths: %j", async override => {
    const f = await fixture(), app = f.appFor(override);
    expect((await request(app).get(f.path)).status).toBe(403);
    expect((await request(app).post(f.path).send({ body: "secret", clientRequestId: randomUUID() })).status).toBe(403);
  });
  it("uses current company membership, not cached actor membership or admin claims", async () => {
    const f = await fixture(), app = f.appFor({ isInstanceAdmin: true });
    await db.update(companyMemberships).set({ status: "inactive" }).where(eq(companyMemberships.companyId, f.companyId));
    expect((await request(app).get(f.path)).status).toBe(404);
    expect((await request(app).get(`/api/issues/${randomUUID()}/internal-notes`)).status).toBe(404);
    expect((await request(f.appFor({ userId: randomUUID() })).get(f.path)).status).toBe(404);
  });
  it("lets current viewers read but not write", async () => {
    const f = await fixture();
    await db.update(companyMemberships).set({ membershipRole: "viewer" }).where(eq(companyMemberships.companyId, f.companyId));
    expect((await request(f.appFor()).get(f.path)).status).toBe(200);
    expect((await request(f.appFor()).post(f.path).send({ body: "no", clientRequestId: randomUUID() })).status).toBe(403);
  });
  it("paginates without leaking another task's cursor, and database rejects mixed-company notes", async () => {
    const f = await fixture(), other = await fixture();
    await db.insert(issueInternalNotes).values(Array.from({ length: 51 }, (_, i) => ({ companyId: f.companyId, issueId: f.issueId, authorUserId: f.userId, body: String(i), clientRequestId: randomUUID() })));
    const first = await request(f.appFor()).get(f.path);
    expect(first.body.notes).toHaveLength(50);
    const last = await request(f.appFor()).get(f.path).query({ before: first.body.nextCursor });
    expect(last.body.notes).toHaveLength(1); expect(last.body.nextCursor).toBeNull();
    expect((await request(other.appFor()).get(other.path).query({ before: first.body.nextCursor })).status).toBe(404);
    await expect(db.insert(issueInternalNotes).values({ companyId: other.companyId, issueId: f.issueId, authorUserId: f.userId, body: "no", clientRequestId: randomUUID() })).rejects.toThrow();
  });
});
