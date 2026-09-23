import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { chatActions, chatEndpoints, issueComments, type Db } from "@paperclipai/db";
import { forbidden } from "../errors.js";

/** Conservative reservation: provider retries consume the same slot, failures
 * never restore it. A new human turn starts a fresh bounded scan, not a new run
 * or OAuth continuation. All read paths share this transactional budget. */
export async function reserveSlackReadBudget(db: Db, input: {
  companyId: string; issueId: string; endpointId: string; conversationId: string;
  generation: number; invocationId: string; toolName: string; limit: number;
}) {
  return db.transaction(async tx => {
    await tx.select({ id: chatEndpoints.id }).from(chatEndpoints).where(and(
      eq(chatEndpoints.id, input.endpointId), eq(chatEndpoints.companyId, input.companyId))).for("update");
    const [origin] = await tx.select({ id: issueComments.id }).from(issueComments).where(and(
      eq(issueComments.companyId, input.companyId), eq(issueComments.issueId, input.issueId), isNull(issueComments.deletedAt),
      eq(issueComments.authorType, "user"), isNull(issueComments.authorAgentId)))
      .orderBy(desc(issueComments.createdAt)).limit(1);
    if (!origin) throw forbidden("Slack discovery requires an existing human request");
    const scan = `${input.issueId}:${input.generation}:${origin.id}`;
    const key = `slack-read:${input.invocationId}`;
    const [existing] = await tx.select().from(chatActions).where(and(eq(chatActions.companyId, input.companyId), eq(chatActions.endpointId, input.endpointId), eq(chatActions.providerActionId, key)));
    if (existing) {
      if (existing.payload.scan !== scan || existing.payload.limit !== input.limit || existing.payload.toolName !== input.toolName) throw forbidden("Slack read retry changed its reservation");
      return;
    }
    const [used] = await tx.execute<{ messages: number; threads: number }>(sql`select
      coalesce(sum((payload->>'limit')::int), 0)::int as messages,
      count(*) filter (where payload->>'toolName' = 'slack_read_thread')::int as threads
      from chat_actions where company_id = ${input.companyId} and endpoint_id = ${input.endpointId}
      and kind = 'slack_read_budget' and payload->>'scan' = ${scan}`);
    if (used.messages + input.limit > 200 || (input.toolName === "slack_read_thread" && used.threads >= 30)) {
      throw forbidden("The scan budget is exhausted. Report partial coverage; do not start a new request or widen the scan.");
    }
    await tx.insert(chatActions).values({ companyId: input.companyId, endpointId: input.endpointId,
      conversationId: input.conversationId, kind: "slack_read_budget", providerActionId: key, status: "reserved",
      payload: { scan, toolName: input.toolName, limit: input.limit } });
  });
}
