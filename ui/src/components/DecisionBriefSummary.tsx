import { decisionBriefSchema } from "@paperclipai/shared";

/** Optional versioned explanation, never an authorization or a replacement resolver. */
export function DecisionBriefSummary({ value }: { value: unknown }) {
  if (value === undefined) return null;
  const parsed = decisionBriefSchema.safeParse(value);
  if (!parsed.success) return <p role="status" className="mt-3 text-xs text-destructive">Decision brief unavailable: invalid or unsupported version. Use the original details; no authorization is inferred.</p>;
  const brief = parsed.data;
  return (
    <section aria-label="Decision brief" className="mt-3 space-y-2 rounded-lg border border-border p-3 text-sm">
      <p className="font-medium text-foreground">{brief.subject}</p>
      <p className="text-xs text-muted-foreground">Resolver: {brief.resolverTarget.type === "human" ? "Human / Board" : `Agent ${brief.resolverTarget.agentId}`} · {brief.resolverTarget.reason}</p>
      {brief.purpose && <p className="text-xs text-muted-foreground">Purpose: {brief.purpose.replaceAll("_", " ")}</p>}
      <p className="text-xs text-muted-foreground">{brief.recommendationOptionId ? `Recommendation: ${brief.recommendationOptionId} — ${brief.recommendationReason ?? ""}` : "No recommended answer"}</p>
      <ul className="space-y-1 text-xs text-foreground">
        {brief.selectionConsequences.map((entry) => <li key={entry.optionId}>{entry.optionId}: {entry.consequence}</li>)}
      </ul>
      <p className="text-xs text-muted-foreground">Without selection: {brief.safeDefault}</p>
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer font-medium">Evidence and scope</summary>
        <div className="mt-2 space-y-2">
          {brief.evidenceRefs.map((ref, index) => <p key={index}>{ref.source} · {ref.revision}</p>)}
          {brief.reason && <p>Rationale: {brief.reason}</p>}
          {brief.scope && <p>Scope: {brief.scope}</p>}
          {brief.excludedScope && <p>Excluded: {brief.excludedScope}</p>}
          {brief.risks && <p>Risks: {brief.risks}</p>}
          {brief.preconditions && <p>Prerequisites: {brief.preconditions.length ? brief.preconditions.join("; ") : "None declared"}</p>}
        </div>
      </details>
    </section>
  );
}
