import { decisionBriefSchema, humanDecisionQualityIssues } from "@paperclipai/shared";

/** Explanation only; the native resolver and its target revision retain authority. */
export function DecisionBriefSummary({ value, hintWhenMissing = true }: { value: unknown; hintWhenMissing?: boolean }) {
  if (value === undefined) {
    if (!hintWhenMissing) return null;
    return <p className="mt-3 text-xs text-muted-foreground">No short summary was provided. Read the full request below before answering; missing context is never an approval.</p>;
  }
  const parsed = decisionBriefSchema.safeParse(value);
  if (!parsed.success) return <p role="status" className="mt-3 text-xs text-destructive">Decision brief unavailable: invalid or unsupported version. Use the original details; no authorization is inferred.</p>;
  const brief = parsed.data;
  const optionLabel = (id: string) => brief.selectionConsequences.find(entry => entry.optionId === id)?.label ?? id;
  const incomplete = brief.resolverTarget.type === "human" && humanDecisionQualityIssues(brief).length > 0;
  return (
    <section aria-label="Decision brief" className="mt-3 space-y-2 rounded-lg border border-border p-3 text-sm">
      <p className="font-medium text-foreground">{brief.subject}</p>
      {brief.mainSummary && <p>{brief.mainSummary}</p>}
      {incomplete && <p className="text-xs text-muted-foreground">This older summary is incomplete. Check the full request; nothing beyond it is approved.</p>}
      {(brief.scope || brief.excludedScope || brief.risks || brief.preconditions?.length) ? (
        <div className="space-y-1 text-xs">
          {brief.scope && <p><span className="font-medium text-muted-foreground">Scope: </span>{brief.scope}</p>}
          {brief.excludedScope && <p><span className="font-medium text-muted-foreground">Not included: </span>{brief.excludedScope}</p>}
          {brief.risks && <p><span className="font-medium text-muted-foreground">Risk: </span>{brief.risks}</p>}
          {brief.preconditions?.length ? <p><span className="font-medium text-muted-foreground">Requires: </span>{brief.preconditions.join("; ")}</p> : null}
        </div>
      ) : null}
      {brief.selectionConsequences.length > 0 && (
        <ul className="space-y-1 text-xs text-foreground">
          {brief.selectionConsequences.map((entry) => <li key={entry.optionId}><span className="font-medium">{entry.label ?? entry.optionId}</span> — {entry.consequence}</li>)}
        </ul>
      )}
      {brief.recommendationOptionId && <p className="text-xs text-muted-foreground">Recommended: {optionLabel(brief.recommendationOptionId)} — {brief.recommendationReason}</p>}
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer font-medium">Details and evidence</summary>
        <div className="mt-2 space-y-2">
          <p>If unanswered: {brief.safeDefault}</p>
          <p>Resolver: {brief.resolverTarget.type === "human" ? "Human / Board" : `Agent ${brief.resolverTarget.agentId}`} · {brief.resolverTarget.reason}</p>
          {brief.evidenceRefs.map((ref, index) => <p key={index}>{ref.source} · {ref.revision}</p>)}
          {brief.reason && <p>{brief.reason}</p>}
        </div>
      </details>
    </section>
  );
}
