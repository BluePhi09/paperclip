import { humanDecisionQualityIssues, decisionBriefSchema, type CreateIssueThreadInteraction, type DecisionContextIssue } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";

export function assertHumanDecisionContext(brief: unknown, path: string, options?: readonly { id: string; label?: string | null }[]) {
  const issues = humanDecisionQualityIssues(brief, path);
  const parsed = decisionBriefSchema.safeParse(brief);
  if (parsed.success && options) {
    const consequences = parsed.data.selectionConsequences;
    for (const option of options) {
      const consequence = consequences.find(entry => entry.optionId === option.id);
      if (!consequence?.label || option.label !== consequence.label) issues.push({ code: "decision_context_missing", path: `${path}.selectionConsequences`, message: `Native option ${option.id} must use the same explicit human label as its consequence.` });
    }
    if (options.length !== consequences.length || new Set(consequences.map(entry => entry.optionId)).size !== consequences.length) {
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

/** Called on the native creation path after effective policy and idempotent replay lookup. */
export function assertHumanInteractionContext(data: CreateIssueThreadInteraction, effectivePolicy: string) {
  if (data.addresseeAgentId && !data.addresseeUserId && effectivePolicy !== "human_only") return;
  if (data.kind === "ask_user_questions") {
    data.payload.questions.forEach((question, index) => assertHumanDecisionContext(question.brief, `payload.questions.${index}.brief`, question.options));
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
