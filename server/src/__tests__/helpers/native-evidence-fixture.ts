import { randomUUID } from "node:crypto";
import { agents, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { documentService } from "../../services/documents.js";
import { issueThreadInteractionService } from "../../services/issue-thread-interactions.js";

/** Historical native review receipts for a fresh productive run; isolated DB only. */
export async function nativeEvidenceFixture(db: Db, f: { companyId: string; issueId: string; agentId: string }, expiresAt?: string) {
  const reviewer = randomUUID(), reviewRun = randomUUID();
  await db.insert(agents).values({ id: reviewer, companyId: f.companyId, name: "Historical independent reviewer", role: "engineer", status: "idle", adapterType: "process" });
  await db.insert(heartbeatRuns).values({ id: reviewRun, companyId: f.companyId, agentId: reviewer, status: "running", runtimeMode: "native", nativeIssueId: f.issueId });
  const doc = async (key: string, body: string) => {
    const { document } = await documentService(db).upsertIssueDocument({ issueId: f.issueId, key, format: "markdown", body, createdByAgentId: f.agentId });
    return { issueId: f.issueId, key, documentId: document.id, revisionId: document.latestRevisionId! };
  };
  const scope = { action: "implement", target: "a1", exclusions: ["deploy"] };
  const context = await doc("target-context", JSON.stringify({ target: "a1", adapterType: "paperclip_runner", environmentDriver: "local", environmentId: null, executionWorkspaceId: null }));
  const artifact = await doc("plan", "Implementation, no deployment");
  const pack = { schemaVersion: 1, subjectIssueId: f.issueId, purpose: "execution_authorization", scope,
    policySource: await doc("review-policy", "Independent review required"), artifacts: [artifact], requiredReviewerAgentIds: [reviewer], prerequisiteIssueIds: [], conditions: [],
    freshness: { context, expiresAt: expiresAt ?? new Date(Date.now() + 3600000).toISOString() } };
  const target = await doc("evidence-pack", JSON.stringify(pack));
  const service = issueThreadInteractionService(db);
  const card = await service.create({ id: f.issueId, companyId: f.companyId }, { kind: "request_confirmation", resolverPolicy: "not_creator", addresseeAgentId: reviewer,
    payload: { version: 1, prompt: "Accept exact evidence?", target: { type: "issue_document", ...target } } }, { agentId: f.agentId });
  await service.acceptInteraction({ id: f.issueId, companyId: f.companyId, projectId: null, goalId: null, status: "in_progress" }, card.id, {}, { agentId: reviewer, runId: reviewRun });
  await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, reviewRun));
  const binding = { schemaVersion: 1, documentId: target.documentId, revisionId: target.revisionId, scope, receipts: [card.id] };
  await db.update(issues).set({ executionPolicy: { evidencePack: binding } }).where(eq(issues.id, f.issueId));
  return { context, artifact, binding, expiresAt: pack.freshness.expiresAt };
}
