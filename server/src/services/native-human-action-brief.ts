import { decisionBriefSchema, type DecisionBrief } from "@paperclipai/shared";
import { assertHumanDecisionContext } from "./human-decision-context.js";

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
  const brief = {
    version: 1, decisionClass: "human_risk_decision", purpose: "execution_authorization",
    subject: input.subject, mainSummary: input.summary,
    resolverTarget: { type: "human", reason: "Only the person may authorize this action." },
    evidenceRefs: [{ source: input.source, revision: input.revision }],
    selectionConsequences: [
      { optionId: "accept", label: input.acceptLabel, consequence: input.acceptConsequence },
      { optionId: "reject", label: input.rejectLabel, consequence: input.rejectConsequence },
    ],
    safeDefault: "Do not execute this action without an answer.", reason: input.summary,
    scope: input.scope, excludedScope: input.excludedScope, risks: input.risks, preconditions: input.preconditions,
  };
  assertHumanDecisionContext(brief, "payload.brief");
  return decisionBriefSchema.parse(brief);
}
