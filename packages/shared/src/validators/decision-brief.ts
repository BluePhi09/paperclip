import { z } from "zod";

const text = z.string().trim().min(1).max(2000);

// Purpose is optional for effectless legacy-style briefs, never for authorization.
const purposesByClass = {
  personal_fact: ["fact"],
  human_risk_decision: ["execution_authorization"],
  expert_review: ["plan_review", "result_verification", "execution_authorization"],
  internal_detail: ["internal_detail", "execution_authorization"],
} as const;

/** Shared semantic boundary, not a grant: native/Board authorization still applies. */
export function decisionBriefAuthorizesEffects(brief: unknown): boolean {
  const parsed = decisionBriefSchema.safeParse(brief);
  return parsed.success && parsed.data.decisionClass !== "personal_fact" && parsed.data.purpose === "execution_authorization";
}

export const decisionBriefSchema = z.object({
  version: z.literal(1),
  decisionClass: z.enum(["personal_fact", "human_risk_decision", "expert_review", "internal_detail"]),
  subject: text,
  resolverTarget: z.discriminatedUnion("type", [
    z.object({ type: z.literal("human"), userId: text.optional(), reason: text }),
    z.object({ type: z.literal("agent"), agentId: z.string().guid(), reason: text }),
  ]),
  evidenceRefs: z.array(z.object({ source: text, revision: text })).min(1).max(20),
  selectionConsequences: z.array(z.object({ optionId: text, consequence: text })).min(1).max(40),
  safeDefault: text,
  recommendationOptionId: text.optional(),
  recommendationReason: text.optional(),
  purpose: z.enum(["fact", "plan_review", "execution_authorization", "result_verification", "internal_detail"]).optional(),
  reason: text.optional(),
  scope: text.optional(),
  excludedScope: text.optional(),
  risks: text.optional(),
  preconditions: z.array(text).max(20).optional(),
}).superRefine((brief, ctx) => {
  const allowed: readonly string[] = purposesByClass[brief.decisionClass];
  if (brief.purpose !== undefined && !allowed.includes(brief.purpose)) {
    ctx.addIssue({ code: "custom", path: ["purpose"], message: "Purpose contradicts decision class" });
  }
  if (brief.decisionClass === "human_risk_decision" || brief.purpose === "execution_authorization") {
    for (const field of ["reason", "scope", "excludedScope", "risks", "preconditions", "recommendationOptionId", "recommendationReason"] as const) {
      if (brief[field] === undefined) ctx.addIssue({ code: "custom", path: [field], message: `Authorization requires ${field}` });
    }
  }
  if (brief.decisionClass === "personal_fact" && brief.recommendationOptionId) {
    ctx.addIssue({ code: "custom", path: ["recommendationOptionId"], message: "Personal facts must not have a recommended answer" });
  }
});

export type DecisionBrief = z.infer<typeof decisionBriefSchema>;
