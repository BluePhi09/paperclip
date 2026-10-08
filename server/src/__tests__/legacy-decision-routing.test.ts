import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, issueThreadInteractions, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  applyLegacyDecisionRouting,
  LEGACY_DECISION_ROUTING_VERSION,
  planLegacyDecisionRouting,
} from "../services/legacy-decision-routing.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const factBrief = {
  version: 1, decisionClass: "personal_fact", purpose: "fact",
  subject: "Do people outside your household use your services?",
  mainSummary: "Name the group and service, no names. Your answer records a fact and permits no change.",
  resolverTarget: { type: "human", reason: "Only you know who uses your services." },
  evidenceRefs: [{ source: "privacy review", revision: "1" }],
  selectionConsequences: [{ optionId: "household", label: "Only my household", consequence: "Record this fact only." }],
  safeDefault: "Leave the question open; change nothing.",
};

describeEmbeddedPostgres("legacy decision routing", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-legacy-decision-routing-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueThreadInteractions);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const creatorId = randomUUID();
    const expertId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Paperclip", issuePrefix: `L${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    for (const [id, name] of [[creatorId, "Atlas"], [expertId, "Network expert"]] as const) {
      await db.insert(agents).values({ id, companyId, name, role: "engineer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    }
    await db.insert(issues).values({ id: issueId, companyId, title: "Homelab", status: "in_review", priority: "medium", assigneeAgentId: creatorId });
    const expertBrief = {
      version: 1, decisionClass: "expert_review", purpose: "result_verification",
      subject: "Verify the DHCP range", resolverTarget: { type: "agent", agentId: expertId, reason: "Network expert" },
      evidenceRefs: [{ source: "router export", revision: "3" }],
      selectionConsequences: [{ optionId: "ok", consequence: "Record the verified range." }],
      safeDefault: "Leave unverified.",
    };
    const legacy = (values: Partial<typeof issueThreadInteractions.$inferInsert> & Pick<typeof issueThreadInteractions.$inferInsert, "kind" | "payload">) => ({
      id: randomUUID(), companyId, issueId, status: "pending", continuationPolicy: "wake_assignee",
      requestedResolverPolicy: "human_only", effectiveResolverPolicy: "human_only", createdByAgentId: creatorId, ...values,
    });
    const mixed = legacy({
      kind: "ask_user_questions",
      title: "Two questions",
      payload: { version: 1, questions: [
        { id: "household", prompt: "Who uses your services?", selectionMode: "single", options: [{ id: "household", label: "Only my household" }], brief: factBrief },
        { id: "dhcp", prompt: "Is the DHCP range correct?", selectionMode: "single", options: [{ id: "ok", label: "Correct" }], brief: expertBrief },
      ] },
    });
    // The title sounds technical; with no structured evidence it must not move.
    const untyped = legacy({ kind: "request_confirmation", title: "Technical check: read the NAS output", payload: { version: 1, prompt: "Read the NAS output" } });
    const governed = legacy({ kind: "request_confirmation", title: "Approve tool", payload: { version: 1, prompt: "Run tool?", toolAction: { requestId: randomUUID() } } });
    const agentCard = { ...legacy({ kind: "request_confirmation", payload: { version: 1, prompt: "Review" } }), addresseeAgentId: expertId, effectiveResolverPolicy: "anyone", requestedResolverPolicy: "anyone" };
    await db.insert(issueThreadInteractions).values([mixed, untyped, governed, agentCard] as never);
    return { companyId, issueId, creatorId, expertId, mixed, untyped, governed, agentCard };
  }

  it("plans read-only from structured evidence, never from titles", async () => {
    const fx = await seed();
    const before = await db.select().from(issueThreadInteractions);
    const plan = await planLegacyDecisionRouting(db, fx.companyId);
    expect(await db.select().from(issueThreadInteractions)).toEqual(before);
    const byId = new Map(plan.entries.map((entry) => [entry.interactionId, entry]));
    expect(byId.has(fx.agentCard.id)).toBe(false);
    expect(byId.get(fx.mixed.id)?.action).toEqual({ type: "split", groups: [
      { key: `expert:${fx.expertId}`, route: "expert", agentId: fx.expertId, unitIds: ["dhcp"] },
      { key: "human", route: "human", unitIds: ["household"] },
    ] });
    expect(byId.get(fx.untyped.id)).toMatchObject({ action: { type: "needs_triage" }, units: [{ route: { route: "needs_triage", basis: "no_structured_classification" } }] });
    expect(byId.get(fx.governed.id)).toMatchObject({ action: { type: "keep_human" }, units: [{ route: { route: "human", basis: "governed_action" } }] });
  });

  it("routes reviewed triage only when bound to the exact card content and never moves governed actions", async () => {
    const fx = await seed();
    const first = await planLegacyDecisionRouting(db, fx.companyId);
    const hash = (id: string) => first.entries.find((entry) => entry.interactionId === id)!.sourceHash;
    const plan = await planLegacyDecisionRouting(db, fx.companyId, {
      [fx.untyped.id]: { sourceHash: hash(fx.untyped.id), units: { card: { route: "expert", agentId: fx.expertId } } },
      [fx.governed.id]: { sourceHash: hash(fx.governed.id), units: { card: { route: "expert", agentId: fx.expertId } } },
      [fx.mixed.id]: { sourceHash: "stale", units: { household: { route: "expert", agentId: fx.expertId } } },
    });
    const byId = new Map(plan.entries.map((entry) => [entry.interactionId, entry]));
    expect(byId.get(fx.untyped.id)?.action).toEqual({ type: "reroute", agentId: fx.expertId });
    expect(byId.get(fx.governed.id)?.action).toEqual({ type: "keep_human" });
    expect(byId.get(fx.mixed.id)?.units[0]?.route).toEqual({ route: "needs_triage", basis: "invalid_override" });
    const selfReview = await planLegacyDecisionRouting(db, fx.companyId, {
      [fx.untyped.id]: { sourceHash: hash(fx.untyped.id), units: { card: { route: "expert", agentId: fx.creatorId } } },
    });
    expect(selfReview.entries.find((entry) => entry.interactionId === fx.untyped.id)?.action).toEqual({ type: "needs_triage" });
  });

  it("splits mixed cards, re-routes technical checks and is idempotent", async () => {
    const fx = await seed();
    const initial = await planLegacyDecisionRouting(db, fx.companyId);
    const plan = await planLegacyDecisionRouting(db, fx.companyId, {
      [fx.untyped.id]: { sourceHash: initial.entries.find((entry) => entry.interactionId === fx.untyped.id)!.sourceHash, units: { card: { route: "expert", agentId: fx.expertId } } },
    });
    const results = await applyLegacyDecisionRouting(db, plan);
    expect(results.map((result) => [result.interactionId, result.status])).toEqual([
      [fx.mixed.id, "applied"],
      [fx.untyped.id, "applied"],
    ]);
    const rows = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.companyId, fx.companyId));
    const original = rows.find((row) => row.id === fx.mixed.id)!;
    expect(original.status).toBe("cancelled");
    expect(original.result).toMatchObject({ outcome: "withdrawn", reason: expect.stringContaining(LEGACY_DECISION_ROUTING_VERSION) });
    const [expertCard, humanCard] = results[0]!.replacementInteractionIds!.map((id) => rows.find((row) => row.id === id)!);
    expect(expertCard).toMatchObject({ addresseeAgentId: fx.expertId, createdByAgentId: fx.creatorId, status: "pending" });
    expect((expertCard!.payload as { questions: Array<{ id: string }> }).questions.map((q) => q.id)).toEqual(["dhcp"]);
    expect(humanCard).toMatchObject({ addresseeAgentId: null, effectiveResolverPolicy: "human_only", createdByAgentId: fx.creatorId, status: "pending" });
    expect((humanCard!.payload as { questions: Array<{ id: string; brief?: unknown }> }).questions).toEqual([expect.objectContaining({ id: "household", brief: factBrief })]);
    const rerouted = rows.find((row) => row.id === results[1]!.replacementInteractionIds![0])!;
    expect(rerouted).toMatchObject({ kind: "request_confirmation", addresseeAgentId: fx.expertId, title: "Technical check: read the NAS output" });
    expect(rows.find((row) => row.id === fx.governed.id)?.status).toBe("pending");

    const again = await applyLegacyDecisionRouting(db, plan);
    expect(again.map((result) => result.status)).toEqual(["already_applied", "already_applied"]);
    expect(await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.companyId, fx.companyId))).toHaveLength(rows.length);
  });

  it("skips cards that changed after review", async () => {
    const fx = await seed();
    const plan = await planLegacyDecisionRouting(db, fx.companyId);
    await db.update(issueThreadInteractions).set({ title: "Edited", updatedAt: new Date(Date.now() + 1000) }).where(eq(issueThreadInteractions.id, fx.mixed.id));
    expect(await applyLegacyDecisionRouting(db, plan)).toEqual([{ interactionId: fx.mixed.id, status: "skipped_changed" }]);
    expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, fx.mixed.id)))[0]?.status).toBe("pending");
  });
});
