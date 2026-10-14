import { AGENT_DEFAULT_MAX_CONCURRENT_RUNS } from "@paperclipai/shared";
import { asNumber } from "../adapters/utils.js";

// Bounds for an agent's `runtimeConfig.heartbeat.maxConcurrentRuns`.
export const HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT = AGENT_DEFAULT_MAX_CONCURRENT_RUNS;
export const HEARTBEAT_MAX_CONCURRENT_RUNS_MIN = 1;
export const HEARTBEAT_MAX_CONCURRENT_RUNS_MAX = 50;

export interface HeartbeatConcurrencyLimits {
  /**
   * `PAPERCLIP_MAX_CONCURRENT_RUNS_PER_AGENT`: upper bound applied to every
   * agent's effective `maxConcurrentRuns`, including the built-in default.
   * `null` when unset.
   */
  perAgentCeiling: number | null;
  /**
   * `PAPERCLIP_MAX_CONCURRENT_RUNS_TOTAL`: instance-wide ceiling on heartbeat
   * runs in `running` state across all agents and companies. `null` when unset.
   */
  total: number | null;
}

// Unset, empty, non-numeric, zero, or negative values mean "no limit", so the
// default deployment keeps its current behavior.
function readPositiveInteger(raw: string | undefined): number | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const parsed = Math.floor(Number(trimmed));
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

export function readHeartbeatConcurrencyLimits(
  env: Record<string, string | undefined> = process.env,
): HeartbeatConcurrencyLimits {
  const perAgent = readPositiveInteger(env.PAPERCLIP_MAX_CONCURRENT_RUNS_PER_AGENT);
  return {
    perAgentCeiling:
      perAgent === null ? null : Math.min(HEARTBEAT_MAX_CONCURRENT_RUNS_MAX, perAgent),
    total: readPositiveInteger(env.PAPERCLIP_MAX_CONCURRENT_RUNS_TOTAL),
  };
}

export function normalizeMaxConcurrentRuns(
  value: unknown,
  perAgentCeiling: number | null = null,
) {
  const parsed = Math.floor(asNumber(value, HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT));
  const bounded = Number.isFinite(parsed)
    ? Math.max(
        HEARTBEAT_MAX_CONCURRENT_RUNS_MIN,
        Math.min(HEARTBEAT_MAX_CONCURRENT_RUNS_MAX, parsed),
      )
    : HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT;
  return perAgentCeiling === null ? bounded : Math.min(bounded, perAgentCeiling);
}

/**
 * Slots one agent may start now: its own free slots, further bounded by the
 * instance-wide free slots when a total cap is configured. `totalInUse` counts
 * running runs plus slots other agents have reserved but not yet claimed.
 */
export function computeAvailableRunSlots(input: {
  agentLimit: number;
  agentRunning: number;
  totalLimit: number | null;
  totalInUse: number;
}) {
  const agentSlots = Math.max(0, input.agentLimit - input.agentRunning);
  if (input.totalLimit === null) return agentSlots;
  return Math.max(0, Math.min(agentSlots, input.totalLimit - input.totalInUse));
}
