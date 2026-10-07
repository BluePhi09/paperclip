import { createHash } from "node:crypto";
import { z } from "zod";
import { aiProviderRoutingSchema, aiRoutingBaseUrl, type AiConnectionModelCatalog, type AiProviderRouting } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";
import { httpAdapterPrivateEndpointAllowlist } from "../adapters/http/remote-fetch.js";
import { guardedRemoteHttpFetch } from "./remote-http-fetch.js";

const MAX_BYTES = 1_048_576;
const catalogSchema = z.object({ data: z.array(z.object({
  id: z.string().min(1).max(256).regex(/^[^\s\x00-\x1f\x7f]+$/),
  owned_by: z.string().max(160).regex(/^[^\x00-\x1f\x7f]*$/).optional(),
})).max(5000) });

function catalogError() {
  return unprocessable("Could not load models from this connection. Check its endpoint, network policy and credential, or enter a model ID manually.", { code: "ai_connection_models_unavailable" });
}

async function readCatalog(response: Response) {
  if (!response.ok || !response.body || Number(response.headers.get("content-length")) > MAX_BYTES) {
    await response.body?.cancel();
    throw catalogError();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw catalogError();
      chunks.push(value);
    }
    return catalogSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Only persisted routing reaches this function. Never accept a request URL/header override. */
export function createAiModelCatalog(request = guardedRemoteHttpFetch, now = Date.now) {
  const cache = new Map<string, { expires: number; result: AiConnectionModelCatalog }>();
  return async (input: { companyId: string; connectionId: string; grantId: string; userId: string; routing: AiProviderRouting; credential: string; refresh?: boolean }): Promise<AiConnectionModelCatalog> => {
    // Hash the full context; neither raw credentials nor tenant identifiers are cache keys.
    // Authorization and credential resolution happen on every call, before this cache.
    const key = createHash("sha256").update(JSON.stringify([
      input.companyId, input.connectionId, input.grantId, input.userId, input.routing, input.credential,
      process.env.PAPERCLIP_AI_MODEL_PRIVATE_ENDPOINT_ALLOWLIST ?? "",
    ])).digest("hex");
    const cached = cache.get(key);
    if (!input.refresh && cached && cached.expires > now()) return cached.result;
    cache.delete(key);
    try {
      const route = aiProviderRoutingSchema.parse(input.routing);
      if (route.kind !== "gateway" && route.kind !== "local") throw catalogError();
      const base = aiRoutingBaseUrl(route, "");
      const endpoint = new URL(`${base}${base.endsWith("/v1") ? "" : "/v1"}/models`);
      // A runner-local HTTP endpoint is not the control plane's localhost.
      if (endpoint.protocol !== "https:") throw catalogError();
      const headers: Record<string, string> = { Accept: "application/json" };
      if (route.auth === "bearer") headers.Authorization = `Bearer ${input.credential}`;
      if (route.auth === "api_key") {
        headers["x-api-key"] = input.credential;
        headers["anthropic-version"] = "2023-06-01";
      }
      const allowlist = httpAdapterPrivateEndpointAllowlist(process.env.PAPERCLIP_AI_MODEL_PRIVATE_ENDPOINT_ALLOWLIST ?? "");
      const response = await request(endpoint, {
        redirect: "error", signal: AbortSignal.timeout(15_000), headers,
      }, {
        // Exact operator opt-in, not deployment-wide private-network bypass.
        allowPrivateNetwork: allowlist.has(endpoint.origin.toLowerCase()),
        dnsTimeoutMs: 3000, connectTimeoutMs: 5000, responseTimeoutMs: 10_000,
        error: catalogError,
      });
      // The guarded transport returns redirects manually; none are followed here.
      const body = await readCatalog(response);
      const models = new Map<string, { id: string; ownedBy?: string }>();
      for (const model of body.data) {
        if (input.credential && (model.id.includes(input.credential) || model.owned_by?.includes(input.credential))) throw catalogError();
        if (!models.has(model.id)) models.set(model.id, { id: model.id, ...(model.owned_by ? { ownedBy: model.owned_by } : {}) });
      }
      const result = { models: [...models.values()] };
      for (const [entry, value] of cache) if (value.expires <= now()) cache.delete(entry);
      if (cache.size >= 100) cache.delete(cache.keys().next().value!);
      cache.set(key, { result, expires: now() + 60_000 });
      return result;
    } catch {
      // Never reflect upstream bodies, URLs, transport errors or credential values.
      throw catalogError();
    }
  };
}
