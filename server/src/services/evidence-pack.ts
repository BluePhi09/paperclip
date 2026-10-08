import { createHash } from "node:crypto";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import { activityLog, documents, issueDocuments, documentRevisions, issueThreadInteractions, heartbeatRuns, issues, agents, type Db } from "@paperclipai/db";
import { evidencePackBindingSchema, evidencePackSchema, evidenceTargetContextSchema, type EvidenceDocumentRef } from "@paperclipai/shared/evidence-pack";
import { getNativeReviewAssignment } from "./native-runtime/native-review-participant.js";
import { forbidden, unprocessable } from "../errors.js";

/** Server actor attribution only; called with the current issue locked in its write transaction. */
export async function authorizeEvidencePolicyChange(tx: Db,
  issue: { id: string; companyId: string; executionPolicy: unknown },
  nextPolicy: unknown, actor: { agentId?: string | null; userId?: string | null }) {
  if (nextPolicy === undefined) return;
  const before = (issue.executionPolicy as { evidencePack?: unknown } | null)?.evidencePack;
  const after = (nextPolicy as { evidencePack?: unknown } | null)?.evidencePack;
  if (isDeepStrictEqual(before, after)) return;
  // All binding changes are governance, not ordinary assignee editing. No
  // responsible-user delegation or caller-provided flag grants board authority.
  if (actor.agentId || !actor.userId) throw forbidden("Evidence policy changes require board governance", {
    code: "evidence_pack_governance_required",
  });
  await tx.insert(activityLog).values({
    companyId: issue.companyId, actorType: "user", actorId: actor.userId,
    action: "issue.evidence_policy_changed", entityType: "issue", entityId: issue.id,
    details: { previous: before ?? null, next: after ?? null },
  });
}


function denied(code: string): never {
  // Do not include document bodies, run contexts, logs, or foreign-company IDs.
  throw unprocessable("Evidence pack blocks execution", { code });
}

type Receipt = typeof issueThreadInteractions.$inferSelect;
async function acceptedReview(tx: Db, companyId: string, receipt: Receipt, reviewerAgentId: string,
  target: EvidenceDocumentRef, excludedAgentIds: Set<string>, excludedRunIds: Set<string>) {
  const actualTarget = (receipt.payload as { target?: Partial<EvidenceDocumentRef> & { type?: string } }).target;
  if (receipt.companyId !== companyId || receipt.issueId !== target.issueId ||
    receipt.kind !== "request_confirmation" || receipt.status !== "accepted" || receipt.result?.outcome !== "accepted" ||
    !receipt.resolvedAt || receipt.resolvedByAgentId !== reviewerAgentId || receipt.resolvedByUserId ||
    !receipt.resolvedByRunId || excludedAgentIds.has(reviewerAgentId) ||
    receipt.createdByAgentId === reviewerAgentId || receipt.sourceRunId === receipt.resolvedByRunId ||
    excludedRunIds.has(receipt.resolvedByRunId) || receipt.effectiveResolverPolicy === "human_only" ||
    actualTarget?.type !== "issue_document" || actualTarget.issueId !== target.issueId ||
    actualTarget.key !== target.key || actualTarget.documentId !== target.documentId || actualTarget.revisionId !== target.revisionId) return false;
  const [run] = await tx.select({ agentId: heartbeatRuns.agentId, issueId: heartbeatRuns.nativeIssueId,
    contextSnapshot: heartbeatRuns.contextSnapshot, status: heartbeatRuns.status }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.id, receipt.resolvedByRunId), eq(heartbeatRuns.companyId, companyId)));
  const runIssueId = run?.issueId ?? (run?.contextSnapshot as { issueId?: string } | null)?.issueId;
  return Boolean(run && run.agentId === reviewerAgentId && runIssueId === receipt.issueId &&
    ["running", "succeeded"].includes(run.status));
}

/**
 * Lock order: the caller holds the subject issue row (then its own run).
 * Only rows scoped to that subject issue may be share-locked afterwards. Rows
 * of other issues, other runs and agents are read as a current committed
 * snapshot without row locks: a writer may hold one of them and then lock the
 * subject issue (e.g. blocker sync, run finalization), which would otherwise
 * form a cycle. The admission is still a point-in-time check of committed data.
 */

/** Current native document + immutable revision; share-locked only within the subject issue. */
async function currentDocument(tx: Db, companyId: string, ref: EvidenceDocumentRef, subjectIssueId: string) {
  const subjectScope = ref.issueId === subjectIssueId;
  const headQuery = tx.select({ revisionId: documents.latestRevisionId }).from(issueDocuments)
    .innerJoin(documents, eq(documents.id, issueDocuments.documentId))
    .where(and(eq(issueDocuments.companyId, companyId), eq(documents.companyId, companyId),
      eq(issueDocuments.issueId, ref.issueId), eq(issueDocuments.key, ref.key), eq(documents.id, ref.documentId)));
  const [head] = subjectScope ? await headQuery.for("share") : await headQuery;
  if (!head || head.revisionId !== ref.revisionId) denied("evidence_pack_stale");
  const revisionQuery = tx.select().from(documentRevisions).where(and(
    eq(documentRevisions.id, ref.revisionId), eq(documentRevisions.documentId, ref.documentId),
    eq(documentRevisions.companyId, companyId)));
  const [revision] = subjectScope ? await revisionQuery.for("share") : await revisionQuery;
  if (!revision) denied("evidence_pack_stale");
  return revision;
}

/** Called inside the execution write transaction, after locking its issue. */
export async function assertIssueEvidencePack(tx: Db, issue: {
  id: string; companyId: string; executionPolicy: unknown;
}, executorAgentId: string | null) {
  const raw = (issue.executionPolicy as { evidencePack?: unknown } | null)?.evidencePack;
  if (raw === undefined) return;
  const parsed = evidencePackBindingSchema.safeParse(raw);
  if (!parsed.success) denied("evidence_pack_invalid");
  const binding = parsed.data;
  const target = { issueId: issue.id, key: "evidence-pack", documentId: binding.documentId, revisionId: binding.revisionId };
  const revision = await currentDocument(tx, issue.companyId, target, issue.id);
  let body: unknown;
  try { body = JSON.parse(revision?.body ?? ""); } catch { body = null; }
  const pack = evidencePackSchema.safeParse(body);
  if (!pack.success) denied("evidence_pack_invalid");
  if (pack.data.subjectIssueId !== issue.id || pack.data.scope.action !== binding.scope.action ||
      pack.data.scope.target !== binding.scope.target || JSON.stringify(pack.data.scope.exclusions) !== JSON.stringify(binding.scope.exclusions)) denied("evidence_pack_scope_mismatch");
  const contextRevision = await currentDocument(tx, issue.companyId, pack.data.freshness.context, issue.id);
  let contextBody: unknown;
  try { contextBody = JSON.parse(contextRevision.body); } catch { contextBody = null; }
  const targetContext = evidenceTargetContextSchema.safeParse(contextBody);
  if (!targetContext.success || targetContext.data.target !== binding.scope.target) denied("evidence_pack_context_invalid");
  const excludedAgents = new Set([executorAgentId, revision.createdByAgentId].filter((id): id is string => Boolean(id)));
  const excludedRuns = new Set([revision.createdByRunId].filter((id): id is string => Boolean(id)));
  for (const ref of [pack.data.policySource, pack.data.freshness.context, ...pack.data.artifacts].sort((a, b) => a.documentId.localeCompare(b.documentId))) {
    const artifactRevision = await currentDocument(tx, issue.companyId, ref, issue.id);
    if (artifactRevision.createdByAgentId) excludedAgents.add(artifactRevision.createdByAgentId);
    if (artifactRevision.createdByRunId) excludedRuns.add(artifactRevision.createdByRunId);
  }
  for (const prerequisiteId of [...pack.data.prerequisiteIssueIds].sort()) {
    // Foreign issue: committed snapshot, never a row lock (see lock order above).
    const [prerequisite] = await tx.select({ status: issues.status }).from(issues)
      .where(and(eq(issues.id, prerequisiteId), eq(issues.companyId, issue.companyId)));
    if (prerequisite?.status !== "done") denied("evidence_pack_prerequisite_open");
    // Done records disposition, not a verdict. The condition path validates
    // the separate task's native document-bound, independent acceptance.
    if (!pack.data.conditions.some((c) => c.proof.issueId === prerequisiteId)) denied("evidence_pack_prerequisite_review_missing");
  }
  const conditionProofs = [];
  for (const condition of [...pack.data.conditions].sort((a, b) => a.proof.documentId.localeCompare(b.proof.documentId))) {
    conditionProofs.push({ condition, proof: await currentDocument(tx, issue.companyId, condition.proof, issue.id) });
  }
  const receiptIds = [...binding.receipts, ...pack.data.conditions.map((c) => c.receiptId)];
  const receiptScope = (subject: boolean) => and(eq(issueThreadInteractions.companyId, issue.companyId),
    inArray(issueThreadInteractions.id, receiptIds),
    subject ? eq(issueThreadInteractions.issueId, issue.id) : ne(issueThreadInteractions.issueId, issue.id));
  const receipts = [
    ...await tx.select().from(issueThreadInteractions).where(receiptScope(true)).orderBy(asc(issueThreadInteractions.id)).for("share"),
    ...await tx.select().from(issueThreadInteractions).where(receiptScope(false)).orderBy(asc(issueThreadInteractions.id)),
  ];
  for (const reviewerAgentId of pack.data.requiredReviewerAgentIds) {
    let accepted = false;
    for (const receipt of receipts.filter((r) => r.resolvedByAgentId === reviewerAgentId)) {
      if (await acceptedReview(tx, issue.companyId, receipt, reviewerAgentId, target, excludedAgents, excludedRuns)) accepted = true;
    }
    if (!accepted) denied("evidence_pack_review_missing");
  }
  for (const { condition, proof } of conditionProofs) {
    const receipt = receipts.find((r) => r.id === condition.receiptId);
    const conditionExcludedAgents = new Set(excludedAgents);
    const conditionExcludedRuns = new Set(excludedRuns);
    if (proof.createdByAgentId) conditionExcludedAgents.add(proof.createdByAgentId);
    if (proof.createdByRunId) conditionExcludedRuns.add(proof.createdByRunId);
    if (!receipt || !await acceptedReview(tx, issue.companyId, receipt, condition.reviewerAgentId,
      condition.proof, conditionExcludedAgents, conditionExcludedRuns)) denied("evidence_pack_condition_open");
  }
  // Fresh database clock after every lock wait, not the request's pre-lock time.
  const [clock] = await tx.execute(sql`select clock_timestamp() as now`);
  if (Date.parse(pack.data.freshness.expiresAt) <= new Date(clock.now as string).getTime()) denied("evidence_pack_expired");
  return { ...binding, freshness: pack.data.freshness, targetContext: targetContext.data };
}

/** Revalidate a server-bound execution after asynchronous native preparation.
 * The transaction commits before returning; no provider RPC runs under DB locks.
 */
export async function revalidateEvidenceOperation(db: Db, binding: {
  companyId: string; issueId: string; agentId: string; runId: string;
}) {
  await db.transaction(async (tx) => {
    const [hint] = await tx.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, binding.runId), eq(heartbeatRuns.companyId, binding.companyId)));
    if (!hint || hint.agentId !== binding.agentId ||
      (hint.nativeIssueId ?? (hint.contextSnapshot as { issueId?: string } | null)?.issueId) !== binding.issueId) {
      denied("evidence_pack_run_mismatch");
    }
    await admitEvidencePackRun(tx, hint, true, true);
  });
}

/** Native heartbeat sidecar, not a second artifact store. Issue -> run lock order. */
export async function admitEvidencePackRun(tx: Db, hint: typeof heartbeatRuns.$inferSelect, dispatch = false, operation = false) {
  const context = hint.contextSnapshot as { issueId?: string } | null;
  const issueId = hint.nativeIssueId ?? context?.issueId;
  if (!issueId) return;
  const [issue] = await tx.select().from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, hint.companyId))).for("update");
  if (!issue) denied("evidence_pack_issue_missing");
  const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, hint.id), eq(heartbeatRuns.companyId, hint.companyId))).for("update");
  if (!run || run.agentId !== hint.agentId || (run.nativeIssueId ?? (run.contextSnapshot as { issueId?: string } | null)?.issueId) !== issueId) denied("evidence_pack_run_mismatch");
  if (operation && (run.status !== "running" || issue.executionRunId !== run.id)) denied("evidence_pack_run_mismatch");
  const profile = run.runnerProfileJson ?? {};
  const previous = profile.evidenceAdmission;
  // Review participation is a different admission purpose, never an executor
  // grant. Context IDs alone cannot grant it: resolve the native assignment
  // against the current issue, applied decision, source run and addressee.
  const review = await getNativeReviewAssignment(tx, {
    companyId: run.companyId, issueId, agentId: run.agentId, contextSnapshot: run.contextSnapshot,
  });
  if (review && ["queued", "running"].includes(run.status)) {
    if (previous) denied("evidence_pack_admission_changed");
    if (dispatch && issue.executionRunId !== run.id) denied("evidence_pack_run_mismatch");
    const reviewerAdmission = { issueId, reviewerAgentId: run.agentId,
      interactionId: review.interaction.id, decisionId: review.sourceDecision.id };
    if (profile.evidenceReviewerAdmission && !isDeepStrictEqual(profile.evidenceReviewerAdmission, reviewerAdmission)) denied("evidence_pack_admission_changed");
    if (!profile.evidenceReviewerAdmission) await tx.update(heartbeatRuns).set({
      runnerProfileJson: { ...profile, evidenceReviewerAdmission: reviewerAdmission },
    }).where(eq(heartbeatRuns.id, run.id));
    return;
  }
  if (profile.evidenceReviewerAdmission) denied("evidence_pack_reviewer_assignment_changed");
  const binding = await assertIssueEvidencePack(tx, issue, run.agentId);
  if (!binding) {
    if (previous) denied("evidence_pack_admission_changed");
    return;
  }
  if (issue.assigneeAgentId !== run.agentId) denied("evidence_pack_executor_changed");
  if (dispatch) {
    // Agent rows are not subject-scoped: read without a row lock (lock order above).
    const [agent] = await tx.select({ adapterType: agents.adapterType }).from(agents)
      .where(and(eq(agents.id, run.agentId), eq(agents.companyId, run.companyId)));
    const environment = (run.contextSnapshot as { paperclipEnvironment?: { id?: string; driver?: string } } | null)?.paperclipEnvironment;
    const expected = binding.targetContext;
    const dispatchedAdapter = (profile.adapterDispatch as { adapterType?: unknown } | undefined)?.adapterType;
    if (!agent || agent.adapterType !== expected.adapterType || dispatchedAdapter !== expected.adapterType || !environment ||
      environment.driver !== expected.environmentDriver ||
      (expected.environmentId !== null && environment.id !== expected.environmentId) ||
      issue.executionWorkspaceId !== expected.executionWorkspaceId) denied("evidence_pack_context_mismatch");
    const [clock] = await tx.execute(sql`select clock_timestamp() as now`);
    if (Date.parse(binding.freshness.expiresAt) <= new Date(clock.now as string).getTime()) denied("evidence_pack_expired");
  }
  const admission = { issueId, executorAgentId: run.agentId, ...binding,
    fingerprint: createHash("sha256").update(JSON.stringify({ issueId, executorAgentId: run.agentId, binding })).digest("hex") };
  if (previous && (previous as { fingerprint?: unknown }).fingerprint !== admission.fingerprint) denied("evidence_pack_admission_changed");
  if (!previous) await tx.update(heartbeatRuns).set({ runnerProfileJson: { ...profile, evidenceAdmission: admission } }).where(eq(heartbeatRuns.id, run.id));
  return admission;
}
