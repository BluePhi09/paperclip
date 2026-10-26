import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { environmentRoutes } from "../routes/environments.js";
import { errorHandler } from "../middleware/index.js";

const mockIssueService = vi.hoisted(() => ({
  clearExecutionWorkspaceEnvironmentSelection: vi.fn(),
}));

const mockProjectService = vi.hoisted(() => ({
  clearExecutionWorkspaceEnvironmentSelection: vi.fn(),
}));

const mockInstanceSettingsService = vi.hoisted(() => ({
  listCompanyIds: vi.fn(),
  getExperimental: vi.fn(),
}));

const mockEnvironmentService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  hasUnresolvedPendingCleanupLeases: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  hasPermission: vi.fn(),
}));

const mockEnvironmentConfig = vi.hoisted(() => ({
  collectEnvironmentSecretRefs: vi.fn(),
  normalizeEnvironmentConfigForPersistence: vi.fn(),
}));

const mockEnvironmentCustomImageService = vi.hoisted(() => ({
  getOverview: vi.fn(),
  getActiveTemplate: vi.fn(),
  getSessionById: vi.fn(),
  startSetupSession: vi.fn(),
  refreshSetupSession: vi.fn(),
  finishSetupSession: vi.fn(),
  cancelSetupSession: vi.fn(),
  rollbackTemplate: vi.fn(),
  disableTemplate: vi.fn(),
  cleanupExpiredSetupSessions: vi.fn(),
}));

const mockExecutionWorkspaceService = vi.hoisted(() => ({
  clearEnvironmentSelection: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

const mockSecretService = vi.hoisted(() => ({
  create: vi.fn(),
  normalizeEnvBindingsForPersistence: vi.fn(),
  listBindingCompanyIdsForTarget: vi.fn(),
  resolveSecretValueForEphemeralAccess: vi.fn(),
  syncEnvBindingsForTarget: vi.fn(),
  syncSecretRefsForTarget: vi.fn(),
  replaceSecretRefsForInstanceTarget: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  issueService: () => mockIssueService,
  instanceSettingsService: () => mockInstanceSettingsService,
  environmentCustomImageService: () => mockEnvironmentCustomImageService,
  logActivity: mockLogActivity,
  projectService: () => mockProjectService,
}));

vi.mock("../services/access.js", () => ({
  accessService: () => mockAccessService,
}));

vi.mock("../services/environment-config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/environment-config.js")>()),
  collectEnvironmentSecretRefs: mockEnvironmentConfig.collectEnvironmentSecretRefs,
  normalizeEnvironmentConfigForPersistence: mockEnvironmentConfig.normalizeEnvironmentConfigForPersistence,
}));

vi.mock("../services/environments.js", () => ({
  environmentService: () => mockEnvironmentService,
}));

vi.mock("../services/execution-workspaces.js", () => ({
  executionWorkspaceService: () => mockExecutionWorkspaceService,
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => mockSecretService,
}));

vi.mock("../services/plugin-environment-driver.js", () => ({
  // The runtime reads this published constant at import time. Mirror the real
  // value so the mocked module keeps the same reusable-lease method contract.
  REUSABLE_LEASE_WORKER_METHODS: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"],
  listReadyPluginEnvironmentDrivers: vi.fn(async () => []),
  resolvePluginSandboxProviderDriverByKey: vi.fn(async () => null),
  resolvePluginSandboxProviderConfigSchema: vi.fn(async () => null),
  validatePluginEnvironmentDriverConfig: vi.fn(async ({ config }) => config),
  validatePluginSandboxProviderConfig: vi.fn(async ({ provider, config }) => ({
    normalizedConfig: config,
    pluginId: `plugin-${provider}`,
    pluginKey: `plugin.${provider}`,
    driver: {
      driverKey: provider,
      kind: "sandbox_provider",
      displayName: provider,
      configSchema: { type: "object" },
    },
  })),
  startPluginEnvironmentInteractiveSetup: vi.fn(),
  getPluginEnvironmentInteractiveSetup: vi.fn(),
  capturePluginEnvironmentTemplate: vi.fn(),
  cancelPluginEnvironmentInteractiveSetup: vi.fn(),
  deletePluginEnvironmentTemplate: vi.fn(),
}));

function createEnvironment(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-06-20T00:00:00.000Z");
  return {
    id: "env-1",
    name: "Local",
    description: "Default execution environment",
    driver: "local",
    status: "active" as const,
    config: {},
    envVars: {},
    metadata: { managedByPaperclip: true },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as typeof req & { actor: Record<string, unknown> }).actor = actor;
    next();
  });
  app.use("/api", environmentRoutes({
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
  } as never));
  app.use(errorHandler);
  return app;
}

describe("environment instance routes", () => {
  it.each(["post", "patch"])("rejects client-written sandbox platform evidence on %s", async method => {
    mockEnvironmentService.getById.mockResolvedValue(createEnvironment());
    const app = createApp({ type: "board", source: "local_implicit", isInstanceAdmin: true });
    const payload = { ...(method === "post" ? { name: "Fixture", driver: "local", config: {} } : {}), metadata: { paperclipSandboxPlatformProbes: { "company-1": { v: 1 } } } };
    const res = method === "post" ? await request(app).post("/api/companies/company-1/environments").send(payload)
      : await request(app).patch("/api/environments/env-1").send(payload);
    expect(res.status).toBe(422);
    expect(res.body.details?.code ?? res.body.code).toBe("environment_platform_probe_reserved");
    expect(mockEnvironmentService.create).not.toHaveBeenCalled();
  });
  it.each([null, { userNote: "replacement" }])("passes explicit user metadata replacement through without copying an old probe (%j)", async metadata => {
    const existing = createEnvironment({ metadata: { userNote: "old", paperclipSandboxPlatformProbes: { "company-1": { v: 1, marker: "stale" } } } });
    mockEnvironmentService.getById.mockResolvedValue(existing);
    mockEnvironmentService.update.mockResolvedValue({ ...existing, metadata });
    const app = createApp({ type: "board", source: "local_implicit", isInstanceAdmin: true });
    const res = await request(app).patch("/api/environments/env-1").send({ metadata });
    expect(res.status).toBe(200);
    expect(mockEnvironmentService.update).toHaveBeenCalledExactlyOnceWith("env-1", { metadata }, { db: expect.anything() });
    expect(res.body.metadata).toEqual(metadata);
  });
  beforeEach(() => {
    mockIssueService.clearExecutionWorkspaceEnvironmentSelection.mockReset();
    mockProjectService.clearExecutionWorkspaceEnvironmentSelection.mockReset();
    mockInstanceSettingsService.listCompanyIds.mockReset();
    mockInstanceSettingsService.getExperimental.mockReset();
    mockInstanceSettingsService.getExperimental.mockResolvedValue({ enableManagedSandboxOnly: false });
    mockEnvironmentService.list.mockReset();
    mockEnvironmentService.getById.mockReset();
    mockEnvironmentService.create.mockReset();
    mockEnvironmentService.update.mockReset();
    mockEnvironmentService.hasUnresolvedPendingCleanupLeases.mockReset();
    mockEnvironmentService.hasUnresolvedPendingCleanupLeases.mockResolvedValue(false);
    mockAccessService.hasPermission.mockReset();
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockEnvironmentConfig.collectEnvironmentSecretRefs.mockReset();
    mockEnvironmentConfig.collectEnvironmentSecretRefs.mockResolvedValue([]);
    mockEnvironmentConfig.normalizeEnvironmentConfigForPersistence.mockReset();
    mockEnvironmentConfig.normalizeEnvironmentConfigForPersistence.mockImplementation(async ({ config }) => config);
    Object.values(mockEnvironmentCustomImageService).forEach((mock) => mock.mockReset());
    mockEnvironmentCustomImageService.getOverview.mockResolvedValue({
      activeTemplate: null,
      activeSession: null,
      latestSession: null,
    });
    mockEnvironmentCustomImageService.getActiveTemplate.mockResolvedValue(null);
    mockEnvironmentCustomImageService.getSessionById.mockResolvedValue(null);
    mockExecutionWorkspaceService.clearEnvironmentSelection.mockReset();
    mockLogActivity.mockReset();
    mockSecretService.create.mockReset();
    mockSecretService.normalizeEnvBindingsForPersistence.mockReset();
    mockSecretService.listBindingCompanyIdsForTarget.mockReset();
    mockSecretService.resolveSecretValueForEphemeralAccess.mockReset();
    mockSecretService.syncEnvBindingsForTarget.mockReset();
    mockSecretService.syncSecretRefsForTarget.mockReset();
    mockSecretService.replaceSecretRefsForInstanceTarget.mockReset();
    mockSecretService.replaceSecretRefsForInstanceTarget.mockResolvedValue([]);

    mockInstanceSettingsService.listCompanyIds.mockResolvedValue(["company-1", "company-2"]);
    mockEnvironmentService.list.mockResolvedValue([]);
    mockEnvironmentService.create.mockResolvedValue(createEnvironment());
    mockSecretService.normalizeEnvBindingsForPersistence.mockImplementation(async (_companyId, env) => env ?? {});
    mockSecretService.listBindingCompanyIdsForTarget.mockResolvedValue([]);
    mockSecretService.syncEnvBindingsForTarget.mockResolvedValue([]);
    mockSecretService.syncSecretRefsForTarget.mockResolvedValue([]);
  });

  it("lists the instance environment catalog for a local board actor", async () => {
    mockEnvironmentService.list.mockResolvedValue([createEnvironment()]);
    const app = createApp({
      type: "board",
      userId: "board-1",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const res = await request(app).get("/api/companies/company-1/environments?driver=local");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(mockEnvironmentService.list).toHaveBeenCalledWith({
      status: undefined,
      driver: "local",
    });
  });

  it("allows non-admin board members with company access to read the shared environment catalog", async () => {
    mockEnvironmentService.list.mockResolvedValue([createEnvironment()]);
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", membershipRole: "member", status: "active" }],
      isInstanceAdmin: false,
    });

    const res = await request(app).get("/api/companies/company-1/environments");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(mockEnvironmentService.list).toHaveBeenCalledTimes(1);
  });

  it("rejects company agents from enumerating the shared environment catalog", async () => {
    const app = createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app).get("/api/companies/company-1/environments");

    expect(res.status).toBe(403);
    expect(mockEnvironmentService.list).not.toHaveBeenCalled();
  });

  it("rejects non-admin signed-in board members from mutating instance environments", async () => {
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      companyIds: ["company-1"],
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post("/api/companies/company-1/environments")
      .send({
        name: "Shared Local",
        driver: "local",
        config: {},
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Instance admin");
    expect(mockEnvironmentService.create).not.toHaveBeenCalled();
  });

  it("creates an instance-scoped environment and logs the mutation to every company", async () => {
    const app = createApp({
      type: "board",
      userId: "board-1",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const res = await request(app)
      .post("/api/companies/company-1/environments")
      .send({
        name: "Shared Local",
        driver: "local",
        config: {},
      });

    expect(res.status).toBe(201);
    expect(mockEnvironmentService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Shared Local",
        driver: "local",
        status: "active",
      }),
      undefined,
      { db: expect.anything() },
    );
    expect(mockSecretService.replaceSecretRefsForInstanceTarget).toHaveBeenCalledWith(
      { targetType: "environment", targetId: "env-1" },
      [],
      { db: expect.anything() },
    );
    expect(mockSecretService.syncEnvBindingsForTarget).toHaveBeenCalledWith(
      "company-1",
      { targetType: "environment", targetId: "env-1" },
      {},
      { db: expect.anything() },
    );
    expect(mockLogActivity).toHaveBeenCalledTimes(2);
    expect(mockLogActivity.mock.calls.map((call) => call[1].companyId)).toEqual(["company-1", "company-2"]);
  });

  it("normalizes and syncs environment envVars on create", async () => {
    const envVars = {
      ANTHROPIC_API_KEY: { type: "secret_ref", secretId: "11111111-1111-4111-8111-111111111111", version: "latest" },
    };
    mockSecretService.normalizeEnvBindingsForPersistence.mockResolvedValue(envVars);
    mockEnvironmentService.create.mockResolvedValue(createEnvironment({ envVars }));
    const app = createApp({
      type: "board",
      userId: "board-1",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const res = await request(app)
      .post("/api/companies/company-1/environments")
      .send({
        name: "Shared Local",
        driver: "local",
        config: {},
        envVars,
      });

    expect(res.status).toBe(201);
    expect(mockSecretService.normalizeEnvBindingsForPersistence).toHaveBeenCalledWith(
      "company-1",
      envVars,
      expect.objectContaining({ fieldPath: "envVars" }),
    );
    expect(mockEnvironmentService.create).toHaveBeenCalledWith(
      expect.objectContaining({ envVars }),
      undefined,
      { db: expect.anything() },
    );
    expect(mockSecretService.syncEnvBindingsForTarget).toHaveBeenCalledWith(
      "company-1",
      { targetType: "environment", targetId: "env-1" },
      envVars,
      { db: expect.anything() },
    );
  });

  it("returns full environment details for an instance admin", async () => {
    mockEnvironmentService.getById.mockResolvedValue(createEnvironment({ config: { shell: "zsh" } }));
    const app = createApp({
      type: "board",
      userId: "board-1",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const res = await request(app).get("/api/environments/env-1");

    expect(res.status).toBe(200);
    expect(res.body.config).toEqual({ shell: "zsh" });
  });

  describe("agents with environments:manage", () => {
    const agentActor = {
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    };
    const sandboxEnvironment = () => createEnvironment({
      driver: "sandbox",
      config: {
        provider: "kubernetes",
        apiToken: "should-not-leak",
        defaultResources: { memory: "4Gi" },
        ssh: { host: "sandbox.internal", privateKey: "should-not-leak" },
      },
      envVars: { FOO: "bar" },
      metadata: null,
    });

    beforeEach(() => {
      mockInstanceSettingsService.listCompanyIds.mockResolvedValue(["company-1"]);
    });

    function grant() {
      mockAccessService.hasPermission.mockImplementation(
        async (_companyId, _type, _id, key) => key === "environments:manage",
      );
    }

    it("still rejects agents without the grant", async () => {
      const app = createApp(agentActor);

      const list = await request(app).get("/api/companies/company-1/environments");
      const read = await request(app).get("/api/environments/env-1");
      const patch = await request(app).patch("/api/environments/env-1").send({ name: "x" });

      expect([list.status, read.status, patch.status]).toEqual([403, 403, 403]);
      expect(list.body.error).toContain("environments:manage");
      expect(mockAccessService.hasPermission).toHaveBeenCalledWith(
        "company-1",
        "agent",
        "agent-1",
        "environments:manage",
      );
      expect(mockEnvironmentService.list).not.toHaveBeenCalled();
      expect(mockEnvironmentService.update).not.toHaveBeenCalled();
    });

    it("rejects the grant on multi-company instances and for other companies", async () => {
      grant();
      const app = createApp(agentActor);

      const otherCompany = await request(app).get("/api/companies/company-2/environments");
      mockInstanceSettingsService.listCompanyIds.mockResolvedValue(["company-1", "company-2"]);
      const multiCompany = await request(app).get("/api/companies/company-1/environments");

      expect(otherCompany.status).toBe(403);
      expect(multiCompany.status).toBe(403);
      expect(multiCompany.body.error).toContain("single-company");
      expect(mockEnvironmentService.list).not.toHaveBeenCalled();
    });

    it("lists and reads environments without credential config or env vars", async () => {
      grant();
      mockEnvironmentService.list.mockResolvedValue([sandboxEnvironment()]);
      mockEnvironmentService.getById.mockResolvedValue(sandboxEnvironment());
      const app = createApp(agentActor);

      const list = await request(app).get("/api/companies/company-1/environments");
      const read = await request(app).get("/api/environments/env-1");

      expect(list.status).toBe(200);
      expect(read.status).toBe(200);
      for (const environment of [list.body[0], read.body]) {
        expect(environment.config).toEqual({
          provider: "kubernetes",
          defaultResources: { memory: "4Gi" },
          ssh: { host: "sandbox.internal" },
        });
        expect(environment.envVars).toEqual({});
      }
    });

    it("updates non-credential config and logs the agent as actor", async () => {
      grant();
      mockEnvironmentService.getById.mockResolvedValue(sandboxEnvironment());
      mockEnvironmentService.update.mockImplementation(async (_id, patch) => ({
        ...sandboxEnvironment(),
        config: patch.config,
      }));
      const app = createApp(agentActor);

      const res = await request(app)
        .patch("/api/environments/env-1")
        .send({ config: { defaultResources: { memory: "6Gi" } } });

      expect(res.status).toBe(200);
      expect(mockEnvironmentService.update).toHaveBeenCalledWith(
        "env-1",
        expect.objectContaining({
          config: expect.objectContaining({ provider: "kubernetes", defaultResources: { memory: "6Gi" } }),
        }),
        { db: expect.anything() },
      );
      expect(res.body.config.defaultResources).toEqual({ memory: "6Gi" });
      expect(res.body.config.apiToken).toBeUndefined();
      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ actorType: "agent", agentId: "agent-1", action: "environment.updated" }),
      );
    });

    it.each([
      [{ driver: "local" }, "driver"],
      [{ envVars: { FOO: "baz" } }, "envVars"],
      [{ metadata: {} }, "metadata"],
      [{ config: { apiToken: "x" } }, "config.apiToken"],
      [{ config: { auth: { privateKey: "x" } } }, "config.auth.privateKey"],
      [{ config: { ssh: { host: "other.internal" } } }, "config.ssh.privateKey"],
    ])("rejects agent patch %j", async (body, field) => {
      grant();
      mockEnvironmentService.getById.mockResolvedValue(sandboxEnvironment());
      const app = createApp(agentActor);

      const res = await request(app).patch("/api/environments/env-1").send(body);

      expect(res.status).toBe(403);
      expect(res.body.error).toContain(field);
      expect(mockEnvironmentService.update).not.toHaveBeenCalled();
    });

    it("rolls back agent config changes that add a secret reference", async () => {
      grant();
      mockEnvironmentService.getById.mockResolvedValue(sandboxEnvironment());
      mockEnvironmentService.update.mockImplementation(async (_id, patch) => ({
        ...sandboxEnvironment(),
        config: patch.config,
      }));
      mockEnvironmentConfig.collectEnvironmentSecretRefs.mockImplementation(async ({ environment }) =>
        environment.config?.kubeconfigRef
          ? [{ secretId: environment.config.kubeconfigRef, configPath: "kubeconfigRef" }]
          : [],
      );
      const app = createApp(agentActor);

      const res = await request(app)
        .patch("/api/environments/env-1")
        .send({ config: { kubeconfigRef: "11111111-1111-4111-8111-111111111111" } });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain("secret references");
      expect(mockSecretService.replaceSecretRefsForInstanceTarget).not.toHaveBeenCalled();
      expect(mockLogActivity).not.toHaveBeenCalled();
    });

    it("keeps other environment routes board-only for granted agents", async () => {
      grant();
      mockEnvironmentService.getById.mockResolvedValue(sandboxEnvironment());
      const app = createApp(agentActor);

      const responses = await Promise.all([
        request(app).post("/api/companies/company-1/environments").send({ name: "x", driver: "local", config: {} }),
        request(app).delete("/api/environments/env-1"),
        request(app).get("/api/environments/env-1/secret-refs"),
        request(app).get("/api/environments/env-1/leases"),
      ]);

      expect(responses.map((res) => res.status)).toEqual([403, 403, 403, 403]);
    });
  });
});
