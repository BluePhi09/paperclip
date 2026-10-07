import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { createDb, companies, companyMemberships, connectionGrants, connectionGrantMembers, toolConnections } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "@paperclipai/db/test-embedded-postgres";
import { aiConnectionService } from "../services/ai-connections.js";
import { aiConnectionRoutes } from "../routes/ai-connections.js";
import { guardedRemoteHttpFetch } from "../services/remote-http-fetch.js";
import { secretService } from "../services/secrets.js";
import { errorHandler } from "../middleware/error-handler.js";

vi.mock("../services/remote-http-fetch.js", () => ({ guardedRemoteHttpFetch: vi.fn() }));
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let home: string;
const companyId = randomUUID();
let service: ReturnType<typeof aiConnectionService>;

beforeAll(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "paperclip-model-catalog-"));
  vi.stubEnv("PAPERCLIP_HOME", home);
  database = await startEmbeddedPostgresTestDatabase("paperclip-model-catalog-db-");
  db = createDb(database.connectionString);
  service = aiConnectionService(db);
  await db.insert(companies).values({ id: companyId, name: "Model catalog tests", issuePrefix: "MCT" });
  await db.insert(companyMemberships).values(["alice", "bob"].map(principalId => ({ companyId, principalId, principalType: "user", status: "active", membershipRole: "member" })));
}, 90000);
afterAll(async () => { await database?.cleanup(); vi.unstubAllEnvs(); if (home) await rm(home, { recursive: true, force: true }); });
beforeEach(() => { vi.mocked(guardedRemoteHttpFetch).mockReset().mockImplementation(async () => Response.json({ data: [{ id: "custom/model", owned_by: "vendor" }] })); });

function app(userId = "alice", actorType: "board" | "agent" | "none" = "board") {
  const app = express();
  app.use((req, _res, next) => {
    req.actor = { type: actorType, source: "session", userId, companyIds: [companyId], memberships: [{ companyId, status: "active", membershipRole: "member" }] } as typeof req.actor;
    next();
  });
  app.use(aiConnectionRoutes(db));
  app.use(errorHandler);
  return app;
}
const create = (ownership: "personal" | "shared" = "personal") => service.save(companyId, "alice", {
  provider: "openai", method: "api_key", ownership, name: "Custom gateway", allAgents: true, agentIds: [],
  routing: { kind: "gateway", protocol: "responses", auth: "bearer", baseUrl: "https://gateway.example/v1", models: [] },
}, "saved-catalog-key");
const url = (account: { connectionId: string; grantId: string }) => `/companies/${companyId}/ai-connections/${account.connectionId}/models?grantId=${account.grantId}`;

it("reads an authenticated model catalog without changing routing or exposing the saved secret", async () => {
  const account = await create();
  const response = await request(app()).get(url(account));
  expect(response.status).toBe(200);
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.body).toEqual({ models: [{ id: "custom/model", ownedBy: "vendor" }] });
  expect(JSON.stringify(response.body)).not.toContain("saved-catalog-key");
  expect(guardedRemoteHttpFetch).toHaveBeenCalledWith(new URL("https://gateway.example/v1/models"), expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer saved-catalog-key" }) }), expect.anything());
  expect((await service.list(companyId, "alice")).find(c => c.id === account.connectionId)?.routing?.models).toEqual([]);
});

it("rechecks authorization after an in-flight catalog read", async () => {
  const account = await create();
  vi.mocked(guardedRemoteHttpFetch).mockImplementationOnce(async () => {
    await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, account.grantId));
    return Response.json({ data: [{ id: "private-model" }] });
  });
  const response = await request(app()).get(url(account));
  expect(response.status).toBe(422);
  expect(response.text).not.toContain("private-model");
});

it("denies another user's personal grant, even to a board caller", async () => {
  const account = await create();
  expect((await request(app("bob")).get(url(account))).status).toBe(404);
  expect(guardedRemoteHttpFetch).not.toHaveBeenCalled();
});

it("checks actual membership instead of trusting route actor metadata", async () => {
  const account = await create("shared");
  expect((await request(app("outsider")).get(url(account))).status).toBe(403);
  expect(guardedRemoteHttpFetch).not.toHaveBeenCalled();
});

it.each(["agent", "none"] as const)("denies %s actors", async actorType => {
  const account = await create();
  expect((await request(app("alice", actorType)).get(url(account))).status).toBe(403);
  expect(guardedRemoteHttpFetch).not.toHaveBeenCalled();
});

it("requires exact connection/grant/company pairs and rejects URL overrides", async () => {
  const account = await create();
  const other = await create();
  expect((await request(app()).get(url({ ...account, grantId: other.grantId }))).status).toBe(404);
  expect((await request(app()).get(url(account).replace(companyId, randomUUID()))).status).toBe(403);
  expect((await request(app()).get(url(account) + "&url=https://evil.example")).status).toBe(400);
  expect((await request(app()).get(url(account).split("?")[0]!)).status).toBe(400);
  expect((await request(app()).get(url(account) + "&grantId=" + other.grantId)).status).toBe(400);
  expect(guardedRemoteHttpFetch).not.toHaveBeenCalled();
});

it("allows the shared audience, then immediately denies a removed audience member despite the cache", async () => {
  const account = await create("shared");
  expect((await request(app("bob")).get(url(account))).status).toBe(200);
  await db.insert(connectionGrantMembers).values({ companyId, grantId: account.grantId, subjectType: "user", subjectId: "alice" });
  expect((await request(app("bob")).get(url(account))).status).toBe(404);
  expect(guardedRemoteHttpFetch).toHaveBeenCalledTimes(1);
});

it.each(["revoked", "expired", "needs_reauthorization"])("denies %s grants before network/cache access", async status => {
  const account = await create();
  expect((await request(app()).get(url(account))).status).toBe(200);
  await db.update(connectionGrants).set({ status }).where(eq(connectionGrants.id, account.grantId));
  expect((await request(app()).get(url(account))).status).toBe(422);
  expect(guardedRemoteHttpFetch).toHaveBeenCalledTimes(1);
});

it.each([{ status: "archived" }, { enabled: false }, { healthStatus: "error" }])("denies unavailable connections before network access: %j", async change => {
  const account = await create();
  await db.update(toolConnections).set(change).where(eq(toolConnections.id, account.connectionId));
  expect((await request(app()).get(url(account))).status).toBe(change.status === "archived" ? 404 : 422);
  expect(guardedRemoteHttpFetch).not.toHaveBeenCalled();
});

it("uses rotated vault credentials instead of the previous cached catalog", async () => {
  const account = await create();
  expect((await request(app()).get(url(account))).status).toBe(200);
  const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, account.grantId));
  const ref = grant!.credentialSecretRefs.find(ref => ref.configPath === "ai.credential")!;
  await secretService(db).rotate(ref.secretId, { value: "rotated-catalog-key" }, { userId: "alice" });
  vi.mocked(guardedRemoteHttpFetch).mockResolvedValueOnce(Response.json({ data: [{ id: "rotated-model" }] }));
  const response = await request(app()).get(url(account));
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ models: [{ id: "rotated-model" }] });
  expect(guardedRemoteHttpFetch).toHaveBeenLastCalledWith(expect.any(URL), expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer rotated-catalog-key" }) }), expect.anything());
  expect(guardedRemoteHttpFetch).toHaveBeenCalledTimes(2);
});

it("explicit refresh bypasses the server cache through the API", async () => {
  const account = await create();
  expect((await request(app()).get(url(account))).status).toBe(200);
  expect((await request(app()).get(url(account))).status).toBe(200);
  expect(guardedRemoteHttpFetch).toHaveBeenCalledTimes(1);
  vi.mocked(guardedRemoteHttpFetch).mockResolvedValueOnce(Response.json({ data: [{ id: "fresh-model" }] }));
  expect((await request(app()).get(url(account) + "&refresh=true")).body).toEqual({ models: [{ id: "fresh-model" }] });
  expect(guardedRemoteHttpFetch).toHaveBeenCalledTimes(2);
});

it("denies inactive membership even with a cached result", async () => {
  const account = await create();
  expect((await request(app()).get(url(account))).status).toBe(200);
  await db.update(companyMemberships).set({ status: "inactive" }).where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, "alice")));
  try {
    expect((await request(app()).get(url(account))).status).toBe(403);
    expect(guardedRemoteHttpFetch).toHaveBeenCalledTimes(1);
  } finally {
    await db.update(companyMemberships).set({ status: "active" }).where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, "alice")));
  }
});
