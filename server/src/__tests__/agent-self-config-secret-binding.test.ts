import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  companySecretBindings,
  companySecretProviderConfigs,
  companySecretVersions,
  companySecrets,
  createDb,
  principalPermissionGrants,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import { secretService } from "../services/secrets.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

function createApp(db: Db, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", agentRoutes(db));
  app.use(errorHandler);
  return app;
}

// Review of #39 (point 2): `agent_config:update` is allow_self, so any sandboxed
// agent reaches PATCH /api/agents/{self}. Persisting a secret_ref env binding
// creates the agent's secret binding, so a self-patch must not be able to
// attach a company secret the agent was never given.
describeEmbeddedPostgres("agent self-config secret references", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-agent-self-secret-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-self-secret-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companySecretProviderConfigs);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  async function seed(env: Record<string, unknown> = {}) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Self Secret Co ${companyId.slice(0, 8)}`,
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const [agent] = await db.insert(agents).values({
      companyId,
      name: `Worker ${randomUUID().slice(0, 8)}`,
      role: "engineer",
      adapterType: "claude_local",
      adapterConfig: { env },
      runtimeConfig: {},
      permissions: {},
    }).returning();
    await db.insert(companyMemberships).values({
      companyId, principalType: "agent", principalId: agent!.id, status: "active", membershipRole: "member",
    });
    const foreign = await secretService(db).create(companyId, {
      name: `foreign-${randomUUID()}`, provider: "local_encrypted", value: "someone-elses-key",
    });
    return { companyId, agent: agent!, foreign };
  }

  const agentActor = (companyId: string, agentId: string): Express.Request["actor"] =>
    ({ type: "agent", agentId, companyId, source: "agent_jwt" });

  it("rejects a self-patch that binds a company secret the agent does not already reference", async () => {
    const { companyId, agent, foreign } = await seed();
    const res = await request(createApp(db, agentActor(companyId, agent.id)))
      .patch(`/api/agents/${agent.id}`)
      .send({ adapterConfig: { env: { ANTHROPIC_API_KEY: { type: "secret_ref", secretId: foreign.id } } } });
    expect(res.status).toBe(403);
    const [stored] = await db.select().from(agents).where(eq(agents.id, agent.id));
    expect(JSON.stringify(stored!.adapterConfig)).not.toContain(foreign.id);
    expect(await db.select().from(companySecretBindings).where(eq(companySecretBindings.secretId, foreign.id))).toEqual([]);
  });

  it("keeps a secret reference the agent already holds when it patches itself", async () => {
    const seeded = await seed();
    const env = { ANTHROPIC_API_KEY: { type: "secret_ref", secretId: seeded.foreign.id } };
    await db.update(agents).set({ adapterConfig: { env } }).where(eq(agents.id, seeded.agent.id));
    const res = await request(createApp(db, agentActor(seeded.companyId, seeded.agent.id)))
      .patch(`/api/agents/${seeded.agent.id}`)
      .send({ adapterConfig: { env } });
    expect(res.status).toBe(200);
  });

  it("lets a configuring agent pass on only a secret it references itself", async () => {
    const { companyId, agent, foreign } = await seed();
    const own = await secretService(db).create(companyId, { name: `own-${randomUUID()}`, provider: "local_encrypted", value: "own-key" });
    const [manager] = await db.insert(agents).values({
      companyId, name: "Manager", role: "engineer", adapterType: "claude_local",
      adapterConfig: { env: { ANTHROPIC_API_KEY: { type: "secret_ref", secretId: own.id } } }, runtimeConfig: {}, permissions: {},
    }).returning();
    await db.insert(companyMemberships).values({ companyId, principalType: "agent", principalId: manager!.id, status: "active", membershipRole: "member" });
    await db.insert(principalPermissionGrants).values({ companyId, principalType: "agent", principalId: manager!.id, permissionKey: "agents:configure", scope: null });
    const app = createApp(db, agentActor(companyId, manager!.id));
    const patch = (secretId: string) => request(app).patch(`/api/agents/${agent.id}`)
      .send({ adapterConfig: { env: { ANTHROPIC_API_KEY: { type: "secret_ref", secretId } } } });
    expect((await patch(foreign.id)).status).toBe(403);
    expect((await patch(own.id)).status).toBe(200);
  });

  it("lets the board bind any company secret", async () => {
    const { agent, foreign } = await seed();
    const res = await request(createApp(db, { type: "board", userId: "local-board", source: "local_implicit" }))
      .patch(`/api/agents/${agent.id}`)
      .send({ adapterConfig: { env: { ANTHROPIC_API_KEY: { type: "secret_ref", secretId: foreign.id } } } });
    expect(res.status).toBe(200);
  });
});
