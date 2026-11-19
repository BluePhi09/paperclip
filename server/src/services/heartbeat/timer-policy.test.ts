import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { maxConcurrentRunsSql, parseHeartbeatPolicy } from "./timer-policy.js";

// Fork (#33): the per-agent ceiling must reach every caller of the shared policy.
describe("PAPERCLIP_MAX_CONCURRENT_RUNS_PER_AGENT", () => {
  afterEach(() => vi.unstubAllEnvs());
  const agent = { adapterType: "claude_local", adapterConfig: {}, runtimeConfig: { heartbeat: { maxConcurrentRuns: 10 } } } as never;

  it("caps parseHeartbeatPolicy and the SQL limit", () => {
    expect(parseHeartbeatPolicy(agent).maxConcurrentRuns).toBe(10);
    const render = () => new PgDialect().sqlToQuery(maxConcurrentRunsSql());
    expect(render().sql).not.toContain("least((case");
    vi.stubEnv("PAPERCLIP_MAX_CONCURRENT_RUNS_PER_AGENT", "2");
    expect(parseHeartbeatPolicy(agent).maxConcurrentRuns).toBe(2);
    expect(render()).toMatchObject({ sql: expect.stringContaining("least((case"), params: expect.arrayContaining([2]) });
  });
});
