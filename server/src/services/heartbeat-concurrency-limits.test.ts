import { describe, expect, it } from "vitest";
import {
  computeAvailableRunSlots,
  normalizeMaxConcurrentRuns,
  readHeartbeatConcurrencyLimits,
} from "./heartbeat-concurrency-limits.js";

describe("readHeartbeatConcurrencyLimits", () => {
  it("leaves both caps off when the variables are unset or not positive integers", () => {
    expect(readHeartbeatConcurrencyLimits({})).toEqual({ perAgentCeiling: null, total: null });
    for (const raw of ["", "  ", "0", "-2", "soon", "0.5"]) {
      expect(
        readHeartbeatConcurrencyLimits({
          PAPERCLIP_MAX_CONCURRENT_RUNS_PER_AGENT: raw,
          PAPERCLIP_MAX_CONCURRENT_RUNS_TOTAL: raw,
        }),
      ).toEqual({ perAgentCeiling: null, total: null });
    }
  });

  it("reads positive integers and bounds the per-agent ceiling to the scheduler maximum", () => {
    expect(
      readHeartbeatConcurrencyLimits({
        PAPERCLIP_MAX_CONCURRENT_RUNS_PER_AGENT: " 2 ",
        PAPERCLIP_MAX_CONCURRENT_RUNS_TOTAL: "8.9",
      }),
    ).toEqual({ perAgentCeiling: 2, total: 8 });
    expect(
      readHeartbeatConcurrencyLimits({
        PAPERCLIP_MAX_CONCURRENT_RUNS_PER_AGENT: "500",
        PAPERCLIP_MAX_CONCURRENT_RUNS_TOTAL: "500",
      }),
    ).toEqual({ perAgentCeiling: 50, total: 500 });
  });
});

describe("normalizeMaxConcurrentRuns", () => {
  it("keeps the existing default and 1..50 clamp without an operator ceiling", () => {
    expect(normalizeMaxConcurrentRuns(undefined)).toBe(20);
    expect(normalizeMaxConcurrentRuns(0)).toBe(1);
    expect(normalizeMaxConcurrentRuns(99)).toBe(50);
    expect(normalizeMaxConcurrentRuns(3.7)).toBe(3);
  });

  it("clamps the stored value and the built-in default to the per-agent ceiling", () => {
    // An imported agent stores maxConcurrentRuns=20; the operator ceiling wins.
    expect(normalizeMaxConcurrentRuns(20, 2)).toBe(2);
    // An agent without a stored value falls back to the default of 20, then the ceiling.
    expect(normalizeMaxConcurrentRuns(undefined, 2)).toBe(2);
    // A lower per-agent value is kept.
    expect(normalizeMaxConcurrentRuns(1, 2)).toBe(1);
  });
});

describe("computeAvailableRunSlots", () => {
  it("uses only the agent's free slots when no total cap is set", () => {
    expect(
      computeAvailableRunSlots({ agentLimit: 5, agentRunning: 2, totalLimit: null, totalInUse: 100 }),
    ).toBe(3);
  });

  it("bounds the agent's free slots by the instance-wide free slots", () => {
    expect(
      computeAvailableRunSlots({ agentLimit: 5, agentRunning: 0, totalLimit: 8, totalInUse: 6 }),
    ).toBe(2);
    expect(
      computeAvailableRunSlots({ agentLimit: 5, agentRunning: 0, totalLimit: 8, totalInUse: 8 }),
    ).toBe(0);
    // Already over the cap (e.g. the cap was lowered at runtime): never negative.
    expect(
      computeAvailableRunSlots({ agentLimit: 5, agentRunning: 0, totalLimit: 8, totalInUse: 12 }),
    ).toBe(0);
  });
});
