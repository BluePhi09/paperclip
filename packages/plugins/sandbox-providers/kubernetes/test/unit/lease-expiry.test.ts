import { describe, it, expect } from "vitest";
import {
  computeBoundedLeaseDeadline,
  MIN_ACTIVE_DEADLINE_SEC,
  MAX_ACTIVE_DEADLINE_SEC,
} from "../../src/lease-expiry.js";

const NOW_MS = Date.UTC(2026, 0, 1, 0, 0, 0);

describe("computeBoundedLeaseDeadline", () => {
  it("bounds the deadline to the caller's requested expiry, rounding down", () => {
    const requested = new Date(NOW_MS + 90_500).toISOString(); // 90.5s out
    const result = computeBoundedLeaseDeadline(requested, 3600, NOW_MS);
    // Rounds DOWN so the pod deadline never lands after the requested time.
    expect(result.activeDeadlineSec).toBe(90);
    expect(result.expiresAt).toBe(new Date(NOW_MS + 90_000).toISOString());
  });

  it("falls back to the configured default when no deadline is requested", () => {
    const result = computeBoundedLeaseDeadline(null, 1800, NOW_MS);
    expect(result.activeDeadlineSec).toBe(1800);
    expect(result.expiresAt).toBe(new Date(NOW_MS + 1_800_000).toISOString());
  });

  it("falls back to the configured default when requestedExpiresAt is undefined", () => {
    const result = computeBoundedLeaseDeadline(undefined, 900, NOW_MS);
    expect(result.activeDeadlineSec).toBe(900);
  });

  it("fails closed on an invalid requestedExpiresAt instead of silently falling back to the default", () => {
    expect(() => computeBoundedLeaseDeadline("not-a-date", 600, NOW_MS)).toThrow(/valid/i);
  });

  it("fails closed (throws) when the requested deadline is already in the past", () => {
    const requested = new Date(NOW_MS - 5_000).toISOString();
    expect(() => computeBoundedLeaseDeadline(requested, 3600, NOW_MS)).toThrow(
      /already past or too close/,
    );
  });

  it("fails closed when the requested deadline is exactly now", () => {
    const requested = new Date(NOW_MS).toISOString();
    expect(() => computeBoundedLeaseDeadline(requested, 3600, NOW_MS)).toThrow(
      /already past or too close/,
    );
  });

  it("fails closed when the requested deadline is within MIN_ACTIVE_DEADLINE_SEC but not yet past", () => {
    const requested = new Date(NOW_MS + (MIN_ACTIVE_DEADLINE_SEC - 1) * 1000).toISOString();
    expect(() => computeBoundedLeaseDeadline(requested, 3600, NOW_MS)).toThrow(
      /already past or too close/,
    );
  });

  it("accepts a deadline exactly at MIN_ACTIVE_DEADLINE_SEC", () => {
    const requested = new Date(NOW_MS + MIN_ACTIVE_DEADLINE_SEC * 1000).toISOString();
    const result = computeBoundedLeaseDeadline(requested, 3600, NOW_MS);
    expect(result.activeDeadlineSec).toBe(MIN_ACTIVE_DEADLINE_SEC);
  });

  it("does NOT silently clamp a past/imminent deadline up to a 1-second lease", () => {
    // Regression test for the reviewed defect: the original implementation
    // used Math.max(1, ...), silently granting a 1-second lease instead of
    // refusing. This must now throw instead.
    const requested = new Date(NOW_MS - 1).toISOString();
    expect(() => computeBoundedLeaseDeadline(requested, 3600, NOW_MS)).toThrow();
  });

  it("clamps a caller-requested deadline far in the future to MAX_ACTIVE_DEADLINE_SEC", () => {
    const farFuture = new Date(NOW_MS + (MAX_ACTIVE_DEADLINE_SEC + 1000) * 1000).toISOString();
    const result = computeBoundedLeaseDeadline(farFuture, 3600, NOW_MS);
    expect(result.activeDeadlineSec).toBe(MAX_ACTIVE_DEADLINE_SEC);
  });

  it("clamps the configured default to MAX_ACTIVE_DEADLINE_SEC when it exceeds the 24h ceiling", () => {
    const result = computeBoundedLeaseDeadline(null, MAX_ACTIVE_DEADLINE_SEC + 1000, NOW_MS);
    expect(result.activeDeadlineSec).toBe(MAX_ACTIVE_DEADLINE_SEC);
  });

  it("fails closed when the configured default itself is invalid (NaN, negative, or too small)", () => {
    expect(() => computeBoundedLeaseDeadline(null, Number.NaN, NOW_MS)).toThrow(/default/i);
    expect(() => computeBoundedLeaseDeadline(null, -1, NOW_MS)).toThrow(/default/i);
    expect(() => computeBoundedLeaseDeadline(null, MIN_ACTIVE_DEADLINE_SEC - 1, NOW_MS)).toThrow(/default/i);
  });
});
