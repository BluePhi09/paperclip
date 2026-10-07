import { afterEach, describe, expect, it, vi } from "vitest";
import { createAiModelCatalog } from "./ai-connection-models.js";
import { guardedRemoteHttpFetch } from "./remote-http-fetch.js";
import type { AiProviderRouting } from "@paperclipai/shared";

const routing: AiProviderRouting = { kind: "gateway", protocol: "responses", auth: "bearer", baseUrl: "https://gateway.example/v1", models: [] };
const context = { companyId: "company", connectionId: "connection", grantId: "grant", userId: "alice", routing, credential: "fixture-secret" };

afterEach(() => vi.unstubAllEnvs());

describe("authenticated gateway model catalog", () => {
  it.each(["http://localhost/v1", "https://user:pass@gateway.example/v1", "https://gateway.example/v1?key=value", "https://gateway.example/v1#fragment"])("rejects unsafe saved URLs before egress: %s", async baseUrl => {
    const request = vi.fn();
    await expect(createAiModelCatalog(request)({ ...context, routing: { ...routing, baseUrl } })).rejects.toMatchObject({ status: 422 });
    expect(request).not.toHaveBeenCalled();
  });
  it.each([301, 302, 307, 401, 403, 500])("does not follow or expose upstream status %s bodies", async status => {
    const request = vi.fn().mockResolvedValue(new Response("fixture-secret", { status, headers: { Location: "https://evil.example" } }));
    await expect(createAiModelCatalog(request)(context)).rejects.toThrow("Could not load models");
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("rejects oversized streamed bodies and cancels the stream", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1_048_577)); }, cancel });
    await expect(createAiModelCatalog(vi.fn().mockResolvedValue(new Response(body)))(context)).rejects.toThrow("Could not load models");
    expect(cancel).toHaveBeenCalled();
  });
  it.each([{ invalid: [] }, { data: [{ id: 42 }] }, { data: [{ id: "\ninvalid" }] }, { data: Array.from({ length: 5001 }, () => ({ id: "m" })) }])("rejects malformed catalogs without exposing their contents", async body => {
    await expect(createAiModelCatalog(vi.fn().mockResolvedValue(Response.json(body)))(context)).rejects.toThrow("Could not load models");
  });
  it("uses only exact operator-allowlisted HTTPS origins for private ingress", async () => {
    vi.stubEnv("PAPERCLIP_AI_MODEL_PRIVATE_ENDPOINT_ALLOWLIST", "https://gateway.example,https://other.example/path,https://invalid.example?x=y");
    const request = vi.fn().mockImplementation(async () => Response.json({ data: [] }));
    const catalog = createAiModelCatalog(request);
    await catalog(context);
    expect(request.mock.calls[0][2].allowPrivateNetwork).toBe(true);
    await catalog({ ...context, routing: { ...routing, baseUrl: "https://gateway.example.evil/v1" } });
    expect(request.mock.calls[1][2].allowPrivateNetwork).toBe(false);
  });
  it.each(["bearer", "api_key", "none"] as const)("respects saved %s authentication and base URL prefix", async auth => {
    const request = vi.fn().mockResolvedValue(Response.json({ data: [] }));
    await createAiModelCatalog(request)({ ...context, routing: { ...routing, protocol: "messages", auth, baseUrl: "https://gateway.example/proxy/" } });
    expect(request.mock.calls[0][0].toString()).toBe("https://gateway.example/proxy/v1/models");
    expect(request.mock.calls[0][1].headers).toEqual({ Accept: "application/json", ...(auth === "api_key" ? { "x-api-key": "fixture-secret", "anthropic-version": "2023-06-01" } : auth === "bearer" ? { Authorization: "Bearer fixture-secret" } : {}) });
  });
  it("caches by credential, company, connection, grant, caller and routing; refresh bypasses cache", async () => {
    const request = vi.fn().mockImplementation(async () => Response.json({ data: [{ id: "model" }] }));
    const catalog = createAiModelCatalog(request);
    await catalog(context);
    await catalog(context);
    expect(request).toHaveBeenCalledTimes(1);
    for (const change of [
      { credential: "rotated-secret" }, { companyId: "other" }, { connectionId: "other" }, { grantId: "other" }, { userId: "bob" },
      { routing: { ...routing, baseUrl: "https://other.example/v1" } }, { refresh: true },
    ]) await catalog({ ...context, ...change });
    expect(request).toHaveBeenCalledTimes(8);
  });
  it("expires cache entries and never caches failures", async () => {
    let now = 0;
    const request = vi.fn().mockImplementation(async () => Response.json({ data: [] }));
    const catalog = createAiModelCatalog(request, () => now);
    await catalog(context);
    now = 60_001;
    await catalog(context);
    expect(request).toHaveBeenCalledTimes(2);
    request.mockRejectedValueOnce(new Error("secret-bearing error"));
    await expect(catalog({ ...context, refresh: true })).rejects.toThrow("Could not load models");
    await catalog(context);
    expect(request).toHaveBeenCalledTimes(4);
  });
  it.each([{ id: "fixture-secret" }, { id: "model", owned_by: "echo-fixture-secret" }])("does not reflect a credential echoed into model metadata", async model => {
    await expect(createAiModelCatalog(vi.fn().mockResolvedValue(Response.json({ data: [model] })))(context)).rejects.toThrow("Could not load models");
  });
  it.each(["127.0.0.1", "10.0.0.1", "169.254.169.254", "[::ffff:a9fe:a9fe]", "[fe80::1]"])("blocks unsafe IP destinations using the real network guard: %s", async host => {
    const unpinnedFetch = vi.fn();
    const transport: typeof guardedRemoteHttpFetch = (url, init, options) => guardedRemoteHttpFetch(url, init, { ...options, unpinnedFetch });
    await expect(createAiModelCatalog(transport)({ ...context, routing: { ...routing, baseUrl: `https://${host}/v1` } })).rejects.toThrow("Could not load models");
    expect(unpinnedFetch).not.toHaveBeenCalled();
  });
  it("keeps metadata blocked even for an allowlisted hostname resolving to link-local", async () => {
    vi.stubEnv("PAPERCLIP_AI_MODEL_PRIVATE_ENDPOINT_ALLOWLIST", "https://gateway.example");
    const socketFactory = vi.fn();
    const transport: typeof guardedRemoteHttpFetch = (url, init, options) => guardedRemoteHttpFetch(url, init, {
      ...options, lookup: async () => [{ address: "169.254.169.254", family: 4 }], socketFactory,
    });
    await expect(createAiModelCatalog(transport)(context)).rejects.toThrow("Could not load models");
    expect(socketFactory).not.toHaveBeenCalled();
  });
  it("bounds the total request and body lifetime with an abort signal", async () => {
    const request = vi.fn().mockImplementation(async (_url, init) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(init.signal.aborted).toBe(false);
      throw new DOMException("fixture-secret", "TimeoutError");
    });
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      await expect(createAiModelCatalog(request)(context)).rejects.toThrow("Could not load models");
      expect(timeout).toHaveBeenCalledWith(15_000);
    } finally { timeout.mockRestore(); }
  });
  it("permits an explicitly allowlisted private HTTPS ingress through the real guard", async () => {
    vi.stubEnv("PAPERCLIP_AI_MODEL_PRIVATE_ENDPOINT_ALLOWLIST", "https://10.0.0.1");
    const unpinnedFetch = vi.fn().mockResolvedValue(Response.json({ data: [{ id: "private/model" }] }));
    const transport: typeof guardedRemoteHttpFetch = (url, init, options) => guardedRemoteHttpFetch(url, init, { ...options, unpinnedFetch });
    expect(await createAiModelCatalog(transport)({ ...context, routing: { ...routing, baseUrl: "https://10.0.0.1/v1" } })).toEqual({ models: [{ id: "private/model" }] });
    expect(unpinnedFetch).toHaveBeenCalledWith("https://10.0.0.1/v1/models", expect.objectContaining({ redirect: "manual" }));
  });
  it("bounds cached catalog contexts", async () => {
    const request = vi.fn().mockImplementation(async () => Response.json({ data: [] }));
    const catalog = createAiModelCatalog(request);
    for (let i = 0; i <= 100; i++) await catalog({ ...context, grantId: String(i) });
    await catalog({ ...context, grantId: "100" });
    expect(request).toHaveBeenCalledTimes(101);
    await catalog({ ...context, grantId: "0" });
    expect(request).toHaveBeenCalledTimes(102);
  });
  it("uses the saved endpoint and credential and returns only model identity, not inferred capabilities", async () => {
    const request = vi.fn().mockResolvedValue(Response.json({ data: [
      { id: "vendor/model", owned_by: "vendor", capabilities: ["anything"], secret: "private" },
      { id: "vendor/model" }, { id: "another" },
    ] }));
    const catalog = createAiModelCatalog(request);
    expect(await catalog(context)).toEqual({ models: [{ id: "vendor/model", ownedBy: "vendor" }, { id: "another" }] });
    expect(request).toHaveBeenCalledWith(new URL("https://gateway.example/v1/models"), expect.objectContaining({
      redirect: "error", headers: { Authorization: "Bearer fixture-secret", Accept: "application/json" }, signal: expect.any(AbortSignal),
    }), expect.objectContaining({ allowPrivateNetwork: false }));
  });
});
