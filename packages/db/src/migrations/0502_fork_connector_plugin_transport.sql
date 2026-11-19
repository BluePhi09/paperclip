-- paperclip:migration-compat online_compatible: fork patch; the transport check only widens to keep upstream's 'plugin' and the fork's 'connector', re-added NOT VALID so no table scan runs.
-- Upstream 0491 re-creates the check without 'connector'; fork 0499 (formerly 0335) re-creates it without 'plugin'.
ALTER TABLE "tool_connections" DROP CONSTRAINT IF EXISTS "tool_connections_transport_check";--> statement-breakpoint
ALTER TABLE "tool_connections" ADD CONSTRAINT "tool_connections_transport_check" CHECK ("tool_connections"."transport" in ('mcp_remote', 'connector', 'rest_api', 'local_stdio', 'chat_sdk', 'voice', 'runtime_auth', 'plugin')) NOT VALID;
