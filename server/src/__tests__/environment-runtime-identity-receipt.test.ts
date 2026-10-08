import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, afterEach, it, expect, vi } from "vitest";
import { sql } from "drizzle-orm";
import { companies, agents, environments, heartbeatRuns, plugins, environmentLeases, createDb } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("runtime-identity-receipt-"); db = createDb(database.connectionString); }, 120000);
afterEach(async () => { await db.transaction(async tx => { await tx.execute(sql`set local client_min_messages = warning`); await tx.execute(sql`truncate companies, plugins, environments cascade`); }); });
afterAll(async () => { await database?.cleanup(); });
it.each([['sandbox', true, false], ['sandbox', false, false], ['plugin', true, false], ['plugin', false, false], ['sandbox', true, true], ['plugin', true, true]] as const)("records requested/default/provider identity distinctly in actual %s acquire RPC (attested=%s, measured=%s)", async (driver, attested, measured) => {
  const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID(), environmentId = randomUUID(), pluginId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Synthetic metadata", issuePrefix: `M${companyId.slice(0,6)}` });
  await db.insert(agents).values({ id: agentId, companyId, name: "Synthetic", role: "engineer", adapterType: "codex_local" });
  await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", controllerBootId: randomUUID(), controllerLeaseExpiresAt: new Date(Date.now() + 60000) });
  const providerConfig = { adapterType: "claude_local" };
  const containerIdentity = measured ? { status: "measured", source: "kubernetes.containerStatuses.imageID", providerLeaseId: "synthetic-lease", backend: "sandbox-cr", namespace: "fixture", workloadUid: "workload-uid", podName: "pod", podUid: "pod-uid", containerName: "agent", imageID: "containerd://sha256:fixture-measured", observedAt: "2026-10-07T00:00:00.000Z" } : { status: "unknown", reason: "container_image_id_unavailable" };
  const observation = { containerIdentity, imageID: measured ? "containerd://sha256:fixture-measured" : null, podUid: "pod-uid", workloadUid: "workload-uid", namespace: "fixture", podName: "pod", containerName: "agent" };
  const [environment] = await db.insert(environments).values({ id: environmentId, name: "Synthetic", driver,
    config: driver === "sandbox" ? { provider: "fixture-provider", ...providerConfig } : { pluginKey: "fixture.plugin", driverKey: "fixture-provider", driverConfig: providerConfig } }).returning();
  await db.insert(plugins).values({ id: pluginId, pluginKey: "fixture.plugin", packageName: "fixture-plugin", version: "1", apiVersion: 1,
    categories: ["automation"], status: "ready", manifestJson: { id: "fixture.plugin", apiVersion: 1, version: "1", displayName: "Fixture", description: "Synthetic", author: "Synthetic", categories: ["automation"], capabilities: ["environment.drivers.register"], entrypoints: { worker: "unused" }, environmentDrivers: [{ driverKey: "fixture-provider", kind: "sandbox_provider", displayName: "Fixture", configSchema: { type: "object" } }] } });
  const call = vi.fn(async (_pluginId: string, method: string, input: { adapterType?: string }) => {
    expect(method).toBe("environmentAcquireLease"); expect(input.adapterType).toBe("codex_local");
    return { providerLeaseId: "synthetic-lease", metadata: attested ? { configuredAdapterType: "forged", requestedAdapterType: "forged", effectiveAdapterType: "codex_local", imageRef: "synthetic/codex:tag", ...observation } : { adapterType: "claude_local" } };
  });
  const runtime = environmentRuntimeService(db, { pluginWorkerManager: { isRunning: () => true, call, getWorker: () => ({ supportedMethods: [] }) } as unknown as PluginWorkerManager });
  const result = await runtime.acquireRunLease({ companyId, agentId, heartbeatRunId: runId, issueId: null, persistedExecutionWorkspace: null, adapterType: "codex_local", environment: { ...environment!, driver, status: "active", envVars: {} } });
  expect(call).toHaveBeenCalledOnce();
  expect(result.lease.metadata).toMatchObject({ configuredAdapterType: "claude_local", environmentDefaultAdapterType: "claude_local",
    requestedAdapterType: "codex_local", effectiveAdapterType: attested ? "codex_local" : null, imageRef: attested ? "synthetic/codex:tag" : null, imageID: measured ? observation.imageID : null });
  if (attested) {
    // Generic plugin drivers retain the full provider binding under providerMetadata;
    // sandbox providers retain it at the lease root. Both persist the same evidence.
    const expected = driver === "plugin" ? { providerMetadata: observation } : observation;
    expect(result.lease.metadata).toMatchObject(expected);
    const [stored] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, result.lease.id));
    expect(stored.metadata).toMatchObject(expected);
  }
});
