import { decisionBriefSchema, type DecisionBrief } from "@paperclipai/shared";
import { assertHumanDecisionContext } from "./human-decision-context.js";

/** Field limits of the shared brief contract (reader schema and new-human-card preflight). */
export const BRIEF_TEXT_LIMITS = { subject: 160, summary: 600, text: 2000, label: 80 } as const;

/**
 * Shortens generated text to a brief field limit with a visible marker. Native producers
 * interpolate names and arguments they do not control; an over-long value must not make
 * the card itself fail. Callers pass a marker naming where the complete text remains.
 */
export function clipBriefText(value: string, max: number, marker = "…"): string {
  const text = value.trim();
  if (text.length <= max) return text;
  let head = text.slice(0, Math.max(0, max - marker.length));
  // Never leave half of a surrogate pair at the cut.
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  return `${head.trimEnd()}${marker}`;
}

export function nativeConnectionAuthorizationBrief(name: string, source: string, revision: string, acceptLabel: string) {
  return nativeHumanActionBrief({
    subject: `Open authorization for ${name}?`,
    summary: `Open the account authorization flow for ${name}. Review the requested permissions there before granting access. This answer alone does not grant account permissions.`,
    scope: `Only open the authorization flow for ${name}.`,
    excludedScope: "No account permissions are granted by this answer; provider consent remains a separate action.",
    risks: "Completing provider consent can allow the connected agent to read or change account data within the permissions you grant.",
    preconditions: ["Check the account identity and requested permissions on the provider's consent screen."],
    source, revision, acceptLabel, rejectLabel: "Not now",
    acceptConsequence: "Open authorization; grant permissions only through separate provider consent.",
    rejectConsequence: "Do not authorize the connection now.",
  });
}

/** For deterministic native producers with known effects, never for summarizing arbitrary task prose. */
export function nativeHumanActionBrief(input: {
  subject: string; summary: string; scope: string; excludedScope: string; risks: string;
  preconditions: string[]; source: string; revision: string; acceptLabel: string; rejectLabel: string;
  acceptConsequence: string; rejectConsequence: string;
}): DecisionBrief {
  const { subject, summary: summaryLimit, text: textLimit, label } = BRIEF_TEXT_LIMITS;
  const text = (value: string) => clipBriefText(value, textLimit);
  const brief = {
    version: 1, decisionClass: "human_risk_decision", purpose: "execution_authorization",
    subject: clipBriefText(input.subject, subject), mainSummary: clipBriefText(input.summary, summaryLimit),
    resolverTarget: { type: "human", reason: "Only the person may authorize this action." },
    evidenceRefs: [{ source: text(input.source), revision: text(input.revision) }],
    selectionConsequences: [
      { optionId: "accept", label: clipBriefText(input.acceptLabel, label), consequence: text(input.acceptConsequence) },
      { optionId: "reject", label: clipBriefText(input.rejectLabel, label), consequence: text(input.rejectConsequence) },
    ],
    safeDefault: "Do not execute this action without an answer.", reason: text(input.summary),
    scope: text(input.scope), excludedScope: text(input.excludedScope), risks: text(input.risks), preconditions: input.preconditions.map(text),
  };
  assertHumanDecisionContext(brief, "payload.brief");
  return decisionBriefSchema.parse(brief);
}
