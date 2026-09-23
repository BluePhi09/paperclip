import express, { type Request } from "express";
import type { Db } from "@paperclipai/db";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { badRequest } from "../errors.js";
import { errorHandler } from "../middleware/index.js";
import type { ChatChannelService } from "../services/chat-channels.js";
import { chatChannelRoutes } from "./chat-channels.js";

const board: Request["actor"] = { type: "board", source: "session", userId: "owner", sessionId: "session", companyIds: ["company-a"], isInstanceAdmin: true };
function fixture(actor = board) {
  const service = { get: vi.fn().mockResolvedValue({ id: "endpoint", companyId: "company-a" }), startSlackBotOAuth: vi.fn().mockResolvedValue({ authorizationUrl: "https://slack.com/oauth/v2/authorize?state=nonce" }), completeSlackBotOAuth: vi.fn().mockResolvedValue({ id: "endpoint" }) };
  const upgrade = { ...service, startSlackThreadUpgrade: vi.fn().mockResolvedValue({ authorizationUrl: "https://slack.com/oauth/v2/authorize?state=upgrade" }) };
  const limit = vi.fn().mockResolvedValue([{ issuePrefix: "TES" }]);
  const where = vi.fn().mockReturnValue({ limit });
  const db = { select: vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue({ where }) }) };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.actor = actor; next(); });
  app.use("/api", chatChannelRoutes(db as unknown as Db, { service: upgrade as unknown as ChatChannelService, heartbeat: { wakeup: vi.fn() } }));
  app.use(errorHandler);
  return { app, service: upgrade, db, limit };
}
const path = "/api/chat-endpoints/endpoint/slack/oauth";
describe("Slack pilot OAuth route authority", () => {
  it.each([
    { type: "none" }, { type: "agent", companyId: "company-a" },
    { ...board, source: "local_implicit", sessionId: undefined },
    { ...board, sessionId: undefined },
  ] as Request["actor"][])("requires a real browser session (%j)", async actor => {
    const f = fixture(actor);
    await request(f.app).post(`${path}/start`).send({ permissionProfile: "ceo-dm-v1" }).expect(403);
    await request(f.app).get(`${path}/callback`).query({ state: "nonce", code: "code" }).expect(403);
    await request(f.app).post("/api/chat-endpoints/endpoint/slack/threading/upgrade").send({ permissionProfile: "ceo-dm-threaded-v2" }).expect(403);
    expect(f.service.startSlackThreadUpgrade).not.toHaveBeenCalled();
    await request(f.app).post("/api/chat-endpoints/endpoint/conversations/10000000-0000-4000-8000-000000000001/slack-replies")
      .send({ body: "Reply hello", clientRequestId: "10000000-0000-4000-8000-000000000002" }).expect(403);
    expect(f.service.startSlackBotOAuth).not.toHaveBeenCalled();
    expect(f.service.completeSlackBotOAuth).not.toHaveBeenCalled();
  });
  it("forbids overriding the permission profile", async () => {
    const f = fixture();
    await request(f.app).post(`${path}/start`).send({ permissionProfile: "broad", scopes: ["files:read"] }).expect(400);
    expect(f.service.startSlackBotOAuth).not.toHaveBeenCalled();
    await request(f.app).post(`${path}/start`).send({ permissionProfile: "ceo-dm-v1" }).expect(200);
    expect(f.service.startSlackBotOAuth).toHaveBeenCalledWith("endpoint", { userId: "owner", sessionId: "session" });
  });
  it("admits only the exact upgrade profile and returns active bots to management", async () => {
    const f = fixture();
    const upgradePath = "/api/chat-endpoints/endpoint/slack/threading/upgrade";
    await request(f.app).post(upgradePath).send({ permissionProfile: "ceo-dm-v1" }).expect(400);
    await request(f.app).post(upgradePath).send({ permissionProfile: "ceo-dm-threaded-v2", scopes: ["files:read"] }).expect(400);
    await request(f.app).post(upgradePath).send({ permissionProfile: "ceo-dm-threaded-v2" }).expect(200);
    expect(f.service.startSlackThreadUpgrade).toHaveBeenCalledWith("endpoint", { userId: "owner", sessionId: "session" });
    f.service.get.mockResolvedValue({ id: "endpoint", companyId: "company-a", status: "active" } as never);
    const response = await request(f.app).get(`${path}/callback`).query({ state: "nonce", code: "code" }).expect(303);
    expect(response.headers.location).toBe("/TES/apps/chat/endpoint/conversations");
  });
  it("uses an application-owned redirect and strips provider errors from URLs", async () => {
    const f = fixture();
    f.service.completeSlackBotOAuth.mockRejectedValueOnce(badRequest("Authorization denied"));
    const response = await request(f.app).get(`${path}/callback`).query({ state: "nonce", error: "access_denied", error_description: "private-provider-prose", returnTo: "https://evil.example" }).expect(303);
    expect(response.headers.location).toBe("/TES/apps/chat/connect?provider=slack&purpose=chat&resume=endpoint&stage=credentials&slackOauth=failed");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(f.service.completeSlackBotOAuth.mock.calls[0][1]).not.toHaveProperty("error_description");
  });
  it("returns to the endpoint's company after successful authorization", async () => {
    const f = fixture();
    f.limit.mockResolvedValueOnce([{ issuePrefix: "OTHER" }]);
    const response = await request(f.app).get(`${path}/callback`).query({ state: "nonce", code: "private-code", companyPrefix: "WRONG", returnTo: "https://evil.example" }).expect(303);
    expect(response.headers.location).toBe("/OTHER/apps/chat/connect?provider=slack&purpose=chat&resume=endpoint&stage=credentials");
    expect(f.service.completeSlackBotOAuth).toHaveBeenCalledWith("endpoint", { actor: { userId: "owner", sessionId: "session" }, state: "nonce", code: "private-code", error: null });
  });
  it("does not consume the authorization code if the company no longer exists", async () => {
    const f = fixture();
    f.limit.mockResolvedValueOnce([]);
    await request(f.app).get(`${path}/callback`).query({ state: "nonce", code: "code" }).expect(404);
    expect(f.service.completeSlackBotOAuth).not.toHaveBeenCalled();
  });
  it("does not resolve a destination or exchange a code across company boundaries", async () => {
    const f = fixture({ ...board, isInstanceAdmin: false, companyIds: ["company-b"] });
    await request(f.app).get(`${path}/callback`).query({ state: "nonce", code: "code" }).expect(404);
    expect(f.db.select).not.toHaveBeenCalled();
    expect(f.service.completeSlackBotOAuth).not.toHaveBeenCalled();
  });
});
