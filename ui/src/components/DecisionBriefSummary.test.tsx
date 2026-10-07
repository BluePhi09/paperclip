// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { DecisionBriefSummary } from "./DecisionBriefSummary";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("Decision brief essential disclosure", () => {
  it("shows scope, exclusions, risks and prerequisites without opening evidence", async () => {
    const host = document.createElement("div");
    const root = createRoot(host);
    const brief = {
      version: 1, decisionClass: "human_risk_decision", purpose: "execution_authorization",
      subject: "Öffentlichen Zugang über eine separate DMZ-VM freigeben?",
      resolverTarget: { type: "human", reason: "Du entscheidest über den öffentlichen Zugang." },
      evidenceRefs: [{ source: "Geprüfter Plan", revision: "5" }],
      selectionConsequences: [
        { optionId: "accept", consequence: "Nur diese Portfreigabe erlauben." },
        { optionId: "reject", consequence: "Alternative planen, keinen Umbau ausführen." },
      ],
      safeDefault: "Keine Portweiterleitung einrichten.",
      reason: "Jellyfin von außen erreichen.",
      scope: "TCP 443 auf 192.168.50.2, eine vom Cluster getrennte VM.",
      excludedScope: "Andere Portweiterleitungen und UPnP bleiben verboten.",
      risks: "Deine öffentliche IP wird sichtbar.",
      preconditions: ["Die Voraussetzungen des geprüften Plans müssen vor Umsetzung erfüllt sein."],
      recommendationOptionId: "accept", recommendationReason: "Die separate VM begrenzt den Schaden am Cluster.",
    };
    try {
      await act(async () => root.render(<DecisionBriefSummary value={brief} />));
      const visible = host.cloneNode(true) as HTMLElement;
      visible.querySelectorAll("details").forEach((details) => details.remove());
      for (const text of [brief.scope, brief.excludedScope, brief.risks, ...brief.preconditions]) {
        expect(visible.textContent).toContain(text);
      }
      expect(host.querySelector("details")?.open).toBe(false);
      expect(host.querySelector("details")?.textContent).toContain("Geprüfter Plan");
    } finally {
      await act(async () => root.unmount());
    }
  });
});
