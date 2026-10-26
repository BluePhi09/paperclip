// Fork: outbound MCP connector (`transport: "connector"`, packages/mcp-connector).
import type { Db } from "@paperclipai/db";
import type { toolConnections } from "@paperclipai/db";
import type { McpConnectionCredentialRef, ToolConnectionTransport } from "@paperclipai/shared";
import { badRequest, HttpError } from "../../errors.js";
import {
  connectorTarget,
  mcpConnectorHub,
  McpConnectorRelayError,
  type McpConnectorHub,
} from "../mcp-connector-hub.js";
import { mcpConnectorService } from "../mcp-connectors.js";

export function isRemoteMcpTransport(transport: ToolConnectionTransport | string) {
  return transport === "mcp_remote" || transport === "connector";
}

export function createConnectorTransport(db: Db, hub: McpConnectorHub = mcpConnectorHub) {
  const mcpConnectors = mcpConnectorService(db, { hub });

  /**
   * Byte transport for `transport: "connector"`. The request goes to the
   * connector session by upstream NAME; this server never dials the upstream,
   * so the SSRF guard stays the only way `mcp_remote` reaches a network.
   */
  function connectorRequest(connection: typeof toolConnections.$inferSelect) {
    return async (init: RequestInit): Promise<Response> => {
      try {
        return await hub.request({
          companyId: connection.companyId,
          ...connectorTarget(connection.config),
          init,
        });
      } catch (error) {
        if (error instanceof McpConnectorRelayError) {
          throw new HttpError(error.status, error.message, { code: error.code });
        }
        throw error;
      }
    };
  }

  async function assertConnectorConnectionConfig(
    companyId: string,
    config: Record<string, unknown>,
    credentialRefs: McpConnectionCredentialRef[] = [],
  ) {
    if (credentialRefs.some((ref) => ref.placement !== "header")) {
      throw badRequest("Connector connections accept header credentials only", { code: "connector_credential_placement" });
    }
    for (const key of ["url", "endpoint", "remoteUrl"]) {
      if (config[key] !== undefined) {
        // The upstream URL lives only in the connector's local config.
        throw badRequest("Connector connections address an upstream by name, not by URL", { code: "connector_url_not_allowed" });
      }
    }
    try {
      connectorTarget(config);
    } catch (error) {
      if (error instanceof McpConnectorRelayError) {
        throw badRequest("Connector connections need a connectorId and an upstream name", { code: error.code });
      }
      throw error;
    }
    await mcpConnectors.assertConnectionTarget(companyId, config);
  }

  return { connectorRequest, assertConnectorConnectionConfig };
}

export type ConnectorTransport = ReturnType<typeof createConnectorTransport>;
