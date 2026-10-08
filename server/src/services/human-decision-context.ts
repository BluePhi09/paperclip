import { humanDecisionQualityIssues, decisionBriefSchema, type CreateIssueThreadInteraction, type DecisionContextIssue } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";

export interface HumanDecisionOption {
  id: string;
  label?: string | null;
  /** Free-text answer slots may be explained but need not be. */
  optional?: boolean;
}

export function assertHumanDecisionContext(brief: unknown, path: string, options?: readonly HumanDecisionOption[]) {
  const issues = humanDecisionQualityIssues(brief, path);
  const parsed = decisionBriefSchema.safeParse(brief);
  if (parsed.success && options) {
    const consequences = parsed.data.selectionConsequences;
    const known = new Set(options.map((option) => option.id));
    for (const option of options) {
      const consequence = consequences.find(entry => entry.optionId === option.id);
      if (!consequence && option.optional) continue;
      if (!consequence?.label || option.label !== consequence.label) issues.push({ code: "decision_context_missing", path: `${path}.selectionConsequences`, message: `Native option ${option.id} must use the same explicit human label as its consequence.` });
    }
    if (new Set(consequences.map(entry => entry.optionId)).size !== consequences.length || consequences.some(entry => !known.has(entry.optionId))) {
      issues.push({ code: "decision_context_missing", path: `${path}.selectionConsequences`, message: "Explain each native option exactly once." });
    }
  }
  rejectMissingContext(issues);
}

function rejectMissingContext(issues: DecisionContextIssue[]) {
  if (issues.length) throw unprocessable("Human decision context is missing. Clarify it internally before creating the card.", {
    code: "decision_context_missing", issues,
  });
}

/** Whether a new card is answered by a person (and therefore lands in their Decisions). */
export function isHumanFacingInteraction(data: Pick<CreateIssueThreadInteraction, "addresseeAgentId" | "addresseeUserId">, effectivePolicy: string) {
  return !(data.addresseeAgentId && !data.addresseeUserId && effectivePolicy !== "human_only");
}

/**
 * Mandatory brief gate for agent-authored human cards. Callers opt in at the
 * agent-authored boundaries (HTTP interaction route); deterministic native
 * producers attach their own briefs and are not blocked here.
 * Runs after effective policy, idempotent replay and target freshness checks.
 */
export function assertHumanInteractionContext(data: CreateIssueThreadInteraction, effectivePolicy: string) {
  if (!isHumanFacingInteraction(data, effectivePolicy)) return;
  if (data.kind === "ask_user_questions") {
    data.payload.questions.forEach((question, index) => assertHumanDecisionContext(
      question.brief,
      `payload.questions.${index}.brief`,
      question.options.map((option) => ({ id: option.id, label: option.label, optional: option.freeText === true })),
    ));
  } else if (data.kind === "request_item_verdicts") {
    data.payload.items.forEach((item, index) => assertHumanDecisionContext(item.brief, `payload.items.${index}.brief`));
  } else if (data.kind === "request_confirmation" || data.kind === "request_checkbox_confirmation") {
    const options = [
      { id: "accept", label: data.payload.acceptLabel }, { id: "reject", label: data.payload.rejectLabel },
      ...(data.kind === "request_checkbox_confirmation" ? data.payload.options : []),
    ];
    assertHumanDecisionContext(data.payload.brief, "payload.brief", options);
  }
}
