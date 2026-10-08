// @vitest-environment jsdom
import { act } from "react";
import type React from "react";
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

  async function renderInto(node: React.ReactElement) {
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => root.render(node));
    return { host, unmount: () => act(async () => root.unmount()) };
  }

  it("shows a static English hint for legacy cards, and none when the caller suppresses it", async () => {
    const shown = await renderInto(<DecisionBriefSummary value={undefined} />);
    expect(shown.host.textContent).toContain("No short summary was provided");
    expect(shown.host.querySelector('[role="status"]')).toBeNull();
    await shown.unmount();
    const hidden = await renderInto(<DecisionBriefSummary value={undefined} hintWhenMissing={false} />);
    expect(hidden.host.textContent).toBe("");
    await hidden.unmount();
  });

  it("renders a free-text fact brief without consequences or empty detail rows", async () => {
    const brief = {
      version: 1, decisionClass: "personal_fact", purpose: "fact",
      subject: "Which audience is the launch note for?",
      mainSummary: "I am drafting the launch note and need to know who reads it.",
      resolverTarget: { type: "human", reason: "Only you know the readers." },
      evidenceRefs: [{ source: "task description", revision: "1" }],
      selectionConsequences: [], safeDefault: "I keep waiting.",
    };
    const view = await renderInto(<DecisionBriefSummary value={brief} />);
    expect(view.host.textContent).toContain("I am drafting the launch note");
    expect(view.host.querySelector("ul")).toBeNull();
    expect(view.host.textContent).not.toContain("Scope:");
    expect(view.host.textContent).toContain("If unanswered: I keep waiting.");
    await view.unmount();
  });
});
