import { useQuery, useQueryClient } from "@tanstack/react-query";
import { aiRoutingModel, type AiConnectionBinding, type AiProviderRouting } from "@paperclipai/shared";
import { aiConnectionsApi } from "@/api/ai-connections";
import { agentsApi } from "@/api/agents";
import { queryKeys } from "@/lib/queryKeys";

export function useConnectionModels(
  companyId: string | null | undefined,
  binding: AiConnectionBinding | undefined,
  harness: string,
) {
  const queryClient = useQueryClient();
  const accounts = useQuery({
    queryKey: ["ai-connections", companyId],
    queryFn: () => aiConnectionsApi.list(companyId!),
    enabled: Boolean(companyId && binding),
  });
  const connection = accounts.data?.connections.find((c) =>
    binding?.mode === "responsible_user"
      ? c.provider === binding.provider && c.isDefault && c.ownerUserId === accounts.data?.currentUserId && c.ownership === "personal"
      : c.id === binding?.connectionId && c.grantId === binding?.grantId,
  );
  const routing = connection?.routing;
  const openRouter = routing?.kind === "openrouter" || (!routing && binding?.provider === "openrouter");
  const discover = openRouter && !routing?.models.length;
  // Reuse the existing public catalog and its query cache. It returns OpenCode IDs;
  // strip only that transport prefix for other harnesses (openrouter/auto is
  // itself a valid upstream model ID).
  const catalog = useQuery({
    queryKey: queryKeys.agents.adapterModels(companyId ?? "none", "opencode_local", null, "openrouter"),
    queryFn: () => agentsApi.adapterModels(companyId!, "opencode_local", { provider: "openrouter" }),
    enabled: Boolean(companyId && discover),
    staleTime: 60_000,
    retry: false,
  });
  const discoverCustom = Boolean(connection && connection.status === "connected" &&
    (routing?.kind === "gateway" || routing?.kind === "local") && !routing.models.length);
  const customKey = ["ai-connection-models", companyId, accounts.data?.currentUserId, connection?.id, connection?.grantId, routing];
  const customCatalog = useQuery({
    queryKey: customKey,
    queryFn: () => aiConnectionsApi.models(companyId!, connection!.id, connection!.grantId),
    enabled: Boolean(companyId && discoverCustom),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const discovery = discoverCustom ? customCatalog : catalog;
  const effectiveRouting: AiProviderRouting | undefined = routing ?? (openRouter
    ? { kind: "openrouter", protocol: "chat", auth: "bearer", models: [] }
    : undefined);
  const modelOptions = discover
    ? (catalog.data ?? []).map((m) => ({ ...m, id: harness === "opencode_local" ? m.id : m.id.replace(/^openrouter\//, "") }))
    : discoverCustom ? (customCatalog.isError ? [] : customCatalog.data?.models ?? []).map(m => ({ id: m.id, label: m.id }))
    : routing?.models ?? [];
  return effectiveRouting
    ? {
        models: modelOptions.map((m) => ({
          id: aiRoutingModel(effectiveRouting, harness, m.id),
          label: m.label ?? m.id,
        })),
        isLoading: (discover || discoverCustom) && discovery.isLoading,
        error: (discover || discoverCustom) ? discovery.error : null,
        refreshing: (discover || discoverCustom) && discovery.isFetching,
        refreshModels: discoverCustom ? async () => {
          // Keep the same observer/error state, but explicitly bypass the server TTL.
          await queryClient.fetchQuery({ queryKey: customKey, staleTime: 0,
            queryFn: () => aiConnectionsApi.models(companyId!, connection!.id, connection!.grantId, true),
          }).catch(() => {}); // The query's error is rendered beside the model picker.
        } : discover ? async () => { await catalog.refetch(); } : undefined,
        resolveModel: (model: string) =>
          aiRoutingModel(effectiveRouting, harness, model),
      }
    : undefined;
}
