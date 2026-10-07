import { decisionBriefSchema, humanDecisionQualityIssues } from "@paperclipai/shared";

/** Explanation only; the native resolver and its target revision retain authority. */
export function DecisionBriefSummary({ value }: { value: unknown }) {
  if (value === undefined) return <p role="status" className="mt-3 text-xs text-muted-foreground">Alte Karte ohne Kurztext: Umfang und Folgen zuerst in der Originalfrage prüfen. Fehlender Kontext ist keine Freigabe.</p>;
  const parsed = decisionBriefSchema.safeParse(value);
  if (!parsed.success) return <p role="status" className="mt-3 text-xs text-destructive">Decision brief unavailable: invalid or unsupported version. Use the original details; no authorization is inferred.</p>;
  const brief = parsed.data;
  const optionLabel = (id: string) => brief.selectionConsequences.find(entry => entry.optionId === id)?.label ?? id;
  const legacy = brief.resolverTarget.type === "human" && humanDecisionQualityIssues(brief).length > 0;
  return (
    <section aria-label="Decision brief" className="mt-3 space-y-2 rounded-lg border border-border p-3 text-sm">
      <p className="font-medium text-foreground">{brief.subject}</p>
      {brief.mainSummary && <p>{brief.mainSummary}</p>}
      {legacy && <p role="status" className="text-xs text-muted-foreground">Der Kurztext dieser alten Karte ist unvollständig. Fehlende Angaben intern klären; keine zusätzliche Freigabe ableiten.</p>}
      {brief.scope && <p>Umfang: {brief.scope}</p>}
      {brief.excludedScope && <p>Nicht erlaubt: {brief.excludedScope}</p>}
      {brief.risks && <p>Risiken und Folgen: {brief.risks}</p>}
      {brief.preconditions && <p>Voraussetzungen: {brief.preconditions.length ? brief.preconditions.join("; ") : "Keine angegeben."}</p>}
      <ul className="space-y-1 text-xs text-foreground">
        {brief.selectionConsequences.map((entry) => <li key={entry.optionId}>{entry.label ?? entry.optionId}: {entry.consequence}</li>)}
      </ul>
      {brief.recommendationOptionId && <p className="text-xs text-muted-foreground">Empfehlung: {optionLabel(brief.recommendationOptionId)} — {brief.recommendationReason}</p>}
      <p className="text-xs text-muted-foreground">Ohne Antwort: {brief.safeDefault}</p>
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer font-medium">Details und Nachweise</summary>
        <div className="mt-2 space-y-2">
          <p>Zuständig: {brief.resolverTarget.type === "human" ? "Mensch / Board" : `Agent ${brief.resolverTarget.agentId}`} · {brief.resolverTarget.reason}</p>
          {brief.evidenceRefs.map((ref, index) => <p key={index}>{ref.source} · {ref.revision}</p>)}
          {brief.reason && <p>{brief.reason}</p>}
        </div>
      </details>
    </section>
  );
}
