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
  // Optional for persisted v1 cards; required by the new-human creation preflight.
  mainSummary: z.string().trim().min(1).max(600).optional(),
  resolverTarget: z.discriminatedUnion("type", [
    z.object({ type: z.literal("human"), userId: text.optional(), reason: text }),
    z.object({ type: z.literal("agent"), agentId: z.string().guid(), reason: text }),
  ]),
  evidenceRefs: z.array(z.object({ source: text, revision: text })).min(1).max(20),
  selectionConsequences: z.array(z.object({ optionId: text, label: z.string().trim().min(1).max(80).optional(), consequence: text })).max(40),
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
    for (const field of ["reason", "scope", "excludedScope", "risks", "preconditions"] as const) {
      if (brief[field] === undefined) ctx.addIssue({ code: "custom", path: [field], message: `Authorization requires ${field}` });
    }
  }
  if (brief.decisionClass === "personal_fact" && brief.recommendationOptionId) {
    ctx.addIssue({ code: "custom", path: ["recommendationOptionId"], message: "Personal facts must not have a recommended answer" });
  }
  if (Boolean(brief.recommendationOptionId) !== Boolean(brief.recommendationReason)) {
    ctx.addIssue({ code: "custom", path: ["recommendationReason"], message: "A recommendation requires both an option and a reason" });
  }
});

export const decisionBriefMetadataSchema = z.object({
  brief: decisionBriefSchema.optional().describe("Required for new human Decisions: mainSummary, explicit purpose, labeled consequences; non-facts also scope, excludedScope, risks and preconditions. Missing context returns 422 decision_context_missing. Optional only for reading/replaying legacy cards."),
}).catchall(z.unknown());

export type DecisionBrief = z.infer<typeof decisionBriefSchema>;

export interface DecisionContextIssue {
  code: "decision_context_missing";
  path: string;
  message: string;
}

/** Structural preflight, not a claim that text is true or a semantic AI judge.
 * Keep separate from the reader schema: old persisted cards are never upgraded by reading them.
 */
export function humanDecisionQualityIssues(value: unknown, path = "brief"): DecisionContextIssue[] {
  const parsed = decisionBriefSchema.safeParse(value);
  if (!parsed.success) return parsed.error.issues.map((issue) => ({
    code: "decision_context_missing", path: [path, ...issue.path].join("."),
    message: `${issue.message}. Internally clarify the missing context; do not invent it.`,
  }));
  const brief = parsed.data;
  const issues: DecisionContextIssue[] = [];
  const missing = (field: string, message: string) => issues.push({ code: "decision_context_missing", path: `${path}.${field}`, message });
  const readable = (value: string | undefined) => Boolean(value?.trim()) && !/^(?:(?:siehe|see|refer to)\s+(?:task|issue|ticket|aufgabe|comments?|kommentare?|details).*|[A-Z]+-?\d+|TBD|TODO|N\/?A|OK|yes|no|ja|nein|accept|reject|approve)[.!?\s]*$/i.test(value!.trim());
  for (const field of ["subject", "mainSummary", "safeDefault"] as const) {
    if (!readable(brief[field])) missing(field, "Provide self-contained plain language, not a task reference, abbreviation or placeholder.");
  }
  if (brief.resolverTarget.type !== "human") missing("resolverTarget", "A human card must name the native human resolver.");
  if (!brief.purpose) missing("purpose", "State whether this records a fact, reviews a plan/result, or authorizes execution.");
  if (brief.subject.length > 160) missing("subject", "Use a concrete title of at most 160 characters; keep necessary context in mainSummary and scope.");
  for (const [index, option] of brief.selectionConsequences.entries()) {
    if (!readable(option.label)) missing(`selectionConsequences.${index}.label`, "Name the answer or authorized action in plain language; do not use only Yes/OK or an option ID.");
    if (!readable(option.consequence)) missing(`selectionConsequences.${index}.consequence`, "Explain what this answer permits and what it does not permit.");
  }
  if (brief.decisionClass !== "personal_fact") {
    for (const field of ["scope", "excludedScope", "risks"] as const) {
      if (!readable(brief[field])) missing(field, "State the exact scope, exclusions and material risk; say explicitly when none applies.");
    }
    if (!brief.preconditions) missing("preconditions", "List decision-critical prerequisites; [] explicitly means none were identified.");
    brief.preconditions?.forEach((entry, index) => {
      if (!readable(entry)) missing(`preconditions.${index}`, "Describe the prerequisite without referring the reader elsewhere.");
    });
  }
  if (brief.recommendationOptionId && !readable(brief.recommendationReason)) missing("recommendationReason", "Explain why this option is recommended.");
  return issues;
}
