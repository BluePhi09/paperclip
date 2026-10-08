import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { decisionBriefSchema, humanDecisionQualityIssues } from "@paperclipai/shared";

const mocks = vi.hoisted(() => ({
  create: vi.fn(async (input: Record<string, unknown>) => ({ id: "decision-1", title: input.title })),
  createBundle: vi.fn(async () => ({ id: "bundle-1" })),
  attentionList: vi.fn(),
  decide: vi.fn(async () => ({ allowed: true })),
  canRead: vi.fn(async () => true),
}));

vi.mock("../services/decisions.js", () => ({
  decisionService: () => ({ create: mocks.create, createBundle: mocks.createBundle }),
}));
vi.mock("../services/attention.js", () => ({
  attentionService: () => ({ list: mocks.attentionList }),
}));
vi.mock("../services/authorization.js", () => ({
  authorizationService: () => ({ decide: mocks.decide }),
  authorizationDeniedDetails: () => ({}),
}));
vi.mock("../services/decision-queues.js", () => ({ canReadDecisionSource: mocks.canRead }));

const COMPANY = "company-1";
const AGENT = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";

async function createApp() {
  const [{ decisionRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/decisions.js"),
    import("../middleware/error-handler.js"),
  ]);
  const db = { transaction: async (fn: (tx: unknown) => unknown) => fn({}) };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = { type: "agent", agentId: AGENT, companyId: COMPANY, runId: RUN };
    next();
  });
  app.use("/api", decisionRoutes(db as never, {} as never));
  app.use(errorHandler);
  return app;
}

const shelfItem = (id: string) => ({
  sourceKind: "approval", subject: { id }, shelf: true, archivedAt: null, retentionVersion: 3, activityAt: "2026-04-01T00:00:00.000Z",
});

describe("decision routes: human brief gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.attentionList.mockResolvedValue({ items: [shelfItem("issue-a"), shelfItem("issue-b"), shelfItem("issue-not-requested")] });
  });

  it("creates the archive proposal with a complete native brief and the opted-in gate", async () => {
    const res = await request(await createApp())
      .post(`/api/companies/${COMPANY}/decision-archive-proposals`)
      .send({ items: [
        { sourceKind: "approval", sourceId: "issue-b", reason: "Superseded by a newer plan" },
        { sourceKind: "approval", sourceId: "issue-a", reason: "No longer relevant" },
      ] });
    expect(res.status).toBe(201);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    const input = mocks.create.mock.calls[0]![0] as {
      companyId: string; agentId: string; runId: string; title: string; ruleKey: string; requireHumanBrief: boolean;
      continuationPolicy: string; options: Array<{ id: string; label: string }>;
      metadata: { kind: string; manifestHash: string; brief: unknown };
      additionalTargetSnapshots: Record<string, unknown>;
    };
    expect(input).toMatchObject({
      companyId: COMPANY, agentId: AGENT, runId: RUN, title: "Archive 2 aging decisions?",
      ruleKey: "attention.bulk_archive", continuationPolicy: "wake_origin_agent", requireHumanBrief: true,
      metadata: { kind: "attention_archive_proposal", manifestHash: expect.any(String) },
    });
    expect(input.options.map(({ id, label }) => ({ id, label }))).toEqual([
      { id: "archive", label: "Archive reviewed items" },
      { id: "keep", label: "Keep items" },
    ]);
    const brief = decisionBriefSchema.parse(input.metadata.brief);
    expect(humanDecisionQualityIssues(brief, "metadata.brief")).toEqual([]);
    expect(brief).toMatchObject({
      decisionClass: "human_risk_decision", purpose: "execution_authorization",
      subject: "Archive 2 aging items from your Decisions list?",
      evidenceRefs: [{ source: "attention-archive-manifest", revision: input.metadata.manifestHash }],
    });
    expect(brief.selectionConsequences.map(({ optionId, label }) => ({ id: optionId, label }))).toEqual(
      input.options.map(({ id, label }) => ({ id, label })),
    );
    expect(Object.keys(input.additionalTargetSnapshots).sort()).toEqual(["attention:approval:issue-a", "attention:approval:issue-b"]);
  });

  it("rejects items that are not on the aging shelf before creating anything", async () => {
    mocks.attentionList.mockResolvedValue({ items: [{ ...shelfItem("issue-a"), shelf: false }] });
    const res = await request(await createApp())
      .post(`/api/companies/${COMPANY}/decision-archive-proposals`)
      .send({ items: [{ sourceKind: "approval", sourceId: "issue-a", reason: "Old" }] });
    expect(res.status).toBe(422);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("opts agent-authored decisions and every bundled decision into the brief gate", async () => {
    const decision = { title: "Pick a vendor", body: "Two offers", options: [{ id: "a", label: "Vendor A", effects: [] }, { id: "b", label: "Vendor B", effects: [] }] };
    const app = await createApp();
    expect((await request(app).post(`/api/companies/${COMPANY}/decisions`).send(decision)).status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      companyId: COMPANY, agentId: AGENT, runId: RUN, title: "Pick a vendor", body: "Two offers", requireHumanBrief: true,
      options: [expect.objectContaining({ id: "a" }), expect.objectContaining({ id: "b" })],
    }));
    expect((await request(app).post(`/api/companies/${COMPANY}/decision-bundles`).send({ title: "Bundle", summary: "Two", decisions: [decision, { ...decision, title: "Second" }] })).status).toBe(201);
    expect(mocks.createBundle).toHaveBeenCalledWith(expect.objectContaining({
      companyId: COMPANY, agentId: AGENT, runId: RUN, title: "Bundle", summary: "Two",
      decisions: [
        expect.objectContaining({ title: "Pick a vendor", requireHumanBrief: true }),
        expect.objectContaining({ title: "Second", requireHumanBrief: true }),
      ],
    }));
  });
});
