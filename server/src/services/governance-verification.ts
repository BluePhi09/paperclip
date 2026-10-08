import { createHash, randomBytes, randomUUID } from "node:crypto";
import { governanceEventSchema, governanceInvocationSchema, governanceVerifySchema, governanceConsumeSchema, governanceRegisterAuthorizes, type GovernanceInvocationInput, type GovernanceOperation } from "@paperclipai/shared";
import { type Db, governanceServices, governanceCredentials, governanceInvocations, governanceVerifications, governanceAuditEvents,
  companyMemberships, issues, heartbeatRuns, agentWakeupRequests, documents, documentRevisions, issueDocuments, issueThreadInteractions, activityLog } from "@paperclipai/db";
import { and, eq, sql, inArray } from "drizzle-orm";
import { forbidden, unauthorized, unprocessable, conflict, notFound } from "../errors.js";

export interface GovernancePrincipal {
  serviceId: string; credentialId: string; companyId: string; nasTarget: string;
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export function canonicalGovernanceOperation(operation: GovernanceOperation) {
  return JSON.stringify(Object.fromEntries(Object.entries(operation).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
}
export function hashGovernanceOperation(operation: GovernanceOperation) {
  return hash(`paperclip.governance.dsm.v1\n${canonicalGovernanceOperation(operation)}`);
}
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Invocation = typeof governanceInvocations.$inferSelect;
async function clock(tx: Tx) {
  const rows = await tx.execute(sql`select clock_timestamp() as now`);
  return new Date(rows[0]!.now as string);
}
function parsed<T>(schema: { safeParse(v: unknown): { success: boolean; data?: T } }, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw unprocessable("Invalid governance request");
  return result.data!;
}
async function ownerAuthority(tx: Tx, companyId: string, ownerUserId: string) {
  const [membership] = await tx.select().from(companyMemberships).where(and(
    eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalType, "user"),
    eq(companyMemberships.principalId, ownerUserId),
  )).for("share");
  if (!membership || membership.status !== "active" || membership.membershipRole !== "owner") throw forbidden("Current company owner required");
}
async function lifecycle(tx: Tx, service: typeof governanceServices.$inferSelect, action: string, credentialId?: string) {
  await tx.insert(activityLog).values({ companyId: service.companyId, actorType: "user", actorId: service.ownerUserId,
    action, entityType: "governance_service", entityId: service.id, details: credentialId ? { credentialId } : {} });
}
async function principalLock(tx: Tx, principal: GovernancePrincipal) {
  const [service] = await tx.select().from(governanceServices).where(eq(governanceServices.id, principal.serviceId)).for("update");
  const [credential] = await tx.select().from(governanceCredentials).where(eq(governanceCredentials.id, principal.credentialId)).for("update");
  const now = await clock(tx);
  if (!service || !credential || service.revokedAt || credential.revokedAt || credential.expiresAt <= now
    || credential.serviceId !== service.id || service.companyId !== principal.companyId || service.nasTarget !== principal.nasTarget) throw unauthorized();
  const [membership] = await tx.select().from(companyMemberships).where(and(
    eq(companyMemberships.companyId, service.companyId), eq(companyMemberships.principalType, "user"),
    eq(companyMemberships.principalId, service.ownerUserId),
  )).for("share");
  if (!membership || membership.status !== "active" || membership.membershipRole !== "owner") throw unauthorized();
  return { service, now };
}
async function invocationLock(tx: Tx, principal: GovernancePrincipal, id: string) {
  const [invocation] = await tx.select().from(governanceInvocations).where(and(eq(governanceInvocations.id, id),
    eq(governanceInvocations.serviceId, principal.serviceId), eq(governanceInvocations.companyId, principal.companyId))).for("update");
  if (!invocation) throw notFound("Governance evidence not found");
  return invocation;
}
async function checkEvidence(tx: Tx, invocation: Invocation, ownerUserId: string, now: Date): Promise<string | null> {
  const op = invocation.operation;
  if (invocation.revokedAt || invocation.expiresAt <= now || invocation.issuer !== "paperclip-gateway"
    || hashGovernanceOperation(op) !== invocation.opHash) return "invocation_invalid";
  const taskRows = await tx.select().from(issues).where(and(eq(issues.companyId, invocation.companyId),
    inArray(issues.id, [op.issueId, invocation.reviewIssueId]))).orderBy(issues.id).for("no key update");
  const issue = taskRows.find(r => r.id === op.issueId);
  const reviewIssue = taskRows.find(r => r.id === invocation.reviewIssueId);
  if (!issue || !reviewIssue || issue.hiddenAt || issue.status !== "in_progress" || issue.assigneeAgentId !== op.agentId
    || !issue.executionRunId) return "issue_binding_invalid";
  const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, issue.executionRunId), eq(heartbeatRuns.companyId, invocation.companyId))).for("no key update");
  const runIssueId = run?.nativeIssueId ?? run?.contextSnapshot?.issueId;
  if (!run || run.agentId !== op.agentId || runIssueId !== op.issueId || run.status !== "running" || !run.startedAt || run.finishedAt) return "run_binding_invalid";
  const isContinuation = run.id !== op.runId;
  if (isContinuation) {
    // Preserve the approved bytes/hash. Only the exact native human acceptance
    // wake may carry that operation from its finished source into a new run.
    // Same agent/task, mutable run context, or a manual wake alone is not proof.
    const [source] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, op.runId), eq(heartbeatRuns.companyId, invocation.companyId))).for("share");
    const [wake] = run.wakeupRequestId ? await tx.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.id, run.wakeupRequestId), eq(agentWakeupRequests.companyId, invocation.companyId),
    )).for("share") : [];
    const context = run.contextSnapshot;
    const payload = wake?.payload;
    if (!source || source.agentId !== op.agentId || (source.nativeIssueId ?? source.contextSnapshot?.issueId) !== op.issueId
      || source.status !== "succeeded" || !source.startedAt || !source.finishedAt || source.finishedAt > run.startedAt
      || !wake || wake.agentId !== op.agentId || wake.runId !== run.id || wake.source !== "automation"
      || wake.reason !== "issue_commented" || wake.requestedByActorType !== "user" || wake.requestedByActorId !== ownerUserId
      || wake.idempotencyKey !== `interaction:${invocation.humanInteractionId}:accepted`
      || payload?.issueId !== op.issueId || payload?.interactionId !== invocation.humanInteractionId
      || payload?.interactionStatus !== "accepted" || payload?.sourceRunId !== op.runId
      || context?.issueId !== op.issueId || context?.interactionId !== invocation.humanInteractionId
      || context?.interactionStatus !== "accepted" || context?.sourceRunId !== op.runId) return "run_binding_invalid";
  }
  const docRows = await tx.select().from(documents).where(and(eq(documents.companyId, invocation.companyId),
    inArray(documents.id, [invocation.operationDocumentId, op.registerDocumentId]))).orderBy(documents.id).for("share");
  const operationDoc = docRows.find(r => r.id === invocation.operationDocumentId);
  const registerDoc = docRows.find(r => r.id === op.registerDocumentId);
  if (!operationDoc || !registerDoc || !operationDoc.lockedAt || !registerDoc.lockedAt
    || operationDoc.latestRevisionId !== invocation.operationRevisionId || registerDoc.latestRevisionId !== op.registerRevision
    || operationDoc.latestBody !== canonicalGovernanceOperation(op)) return "revision_stale";
  const [revision] = await tx.select().from(documentRevisions).where(and(eq(documentRevisions.companyId, invocation.companyId),
    eq(documentRevisions.documentId, operationDoc.id), eq(documentRevisions.id, invocation.operationRevisionId))).for("share");
  if (!revision || revision.body !== operationDoc.latestBody) return "revision_stale";
  const [registerRevisionRow] = await tx.select().from(documentRevisions).where(and(eq(documentRevisions.companyId, invocation.companyId),
    eq(documentRevisions.documentId, registerDoc.id), eq(documentRevisions.id, op.registerRevision))).for("share");
  const [registerLink] = await tx.select().from(issueDocuments).where(and(eq(issueDocuments.companyId, invocation.companyId),
    eq(issueDocuments.issueId, op.issueId), eq(issueDocuments.documentId, registerDoc.id), eq(issueDocuments.key, "dsm-register"))).for("share");
  if (!registerRevisionRow || registerRevisionRow.body !== registerDoc.latestBody || !registerLink) return "register_invalid";
  if (!governanceRegisterAuthorizes(registerRevisionRow.body, op)) return "register_unauthorized";
  const [link] = await tx.select().from(issueDocuments).where(and(eq(issueDocuments.companyId, invocation.companyId),
    eq(issueDocuments.issueId, op.issueId), eq(issueDocuments.documentId, operationDoc.id), eq(issueDocuments.key, "dsm-operation"))).for("share");
  if (!link) return "revision_stale";
  const interactions = await tx.select().from(issueThreadInteractions).where(and(eq(issueThreadInteractions.companyId, invocation.companyId),
    inArray(issueThreadInteractions.id, [invocation.fpInteractionId, invocation.humanInteractionId]))).orderBy(issueThreadInteractions.id).for("share");
  for (const [id, human] of [[invocation.fpInteractionId, false], [invocation.humanInteractionId, true]] as const) {
    const interaction = interactions.find(r => r.id === id);
    if (!interaction || interaction.kind !== "request_confirmation" || interaction.status !== "accepted" || !interaction.resolvedAt
      || interaction.resolvedAt > now || now.getTime() - interaction.resolvedAt.getTime() >= 86_400_000
      || !("outcome" in (interaction.result ?? {})) || (interaction.result as { outcome?: string }).outcome !== "accepted") return "approval_invalid";
    const payload = interaction.payload as { target?: { type?: string; issueId?: string | null; documentId?: string | null; key?: string; revisionId?: string } };
    if (payload.target?.type !== "issue_document" || payload.target.issueId !== op.issueId || payload.target.documentId !== operationDoc.id
      || payload.target.key !== "dsm-operation" || payload.target.revisionId !== invocation.operationRevisionId) return "approval_binding_invalid";
    if (human) {
      if (isContinuation && (interaction.sourceRunId !== op.runId || interaction.createdByAgentId !== op.requesterAgentId
        || interaction.resolvedAt > run.startedAt
        || !["wake_assignee", "wake_assignee_on_accept"].includes(interaction.continuationPolicy))) return "run_binding_invalid";
      if (interaction.issueId !== op.issueId || interaction.requestedResolverPolicy !== "human_only" || interaction.effectiveResolverPolicy !== "human_only"
        || interaction.addresseeUserId !== ownerUserId || interaction.resolvedByUserId !== ownerUserId || interaction.resolvedByAgentId || interaction.resolvedByRunId) return "human_receipt_invalid";
    } else {
      if (reviewIssue.id === issue.id || reviewIssue.hiddenAt || reviewIssue.status !== "done" || reviewIssue.assigneeAgentId !== invocation.reviewerAgentId
        || invocation.reviewerAgentId === op.agentId || invocation.reviewerAgentId === op.requesterAgentId
        || interaction.issueId !== reviewIssue.id || interaction.effectiveResolverPolicy !== "not_creator"
        || interaction.addresseeAgentId !== invocation.reviewerAgentId || interaction.resolvedByAgentId !== invocation.reviewerAgentId
        || interaction.resolvedByUserId || !interaction.resolvedByRunId || interaction.resolvedByAgentId === interaction.createdByAgentId
        || interaction.resolvedByRunId === interaction.sourceRunId) return "review_receipt_invalid";
      const [reviewRun] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, interaction.resolvedByRunId),
        eq(heartbeatRuns.companyId, invocation.companyId))).for("share");
      if (!reviewRun || reviewRun.agentId !== invocation.reviewerAgentId || reviewRun.nativeIssueId !== reviewIssue.id
        || reviewRun.status !== "succeeded" || !reviewRun.startedAt || !reviewRun.finishedAt) return "review_receipt_invalid";
    }
    const [receipt] = await tx.select({ id: activityLog.id }).from(activityLog).where(and(eq(activityLog.companyId, invocation.companyId),
      eq(activityLog.action, "issue.thread_interaction_accepted"), eq(activityLog.entityType, "issue"), eq(activityLog.entityId, interaction.issueId),
      eq(activityLog.actorType, human ? "user" : "agent"), eq(activityLog.actorId, human ? ownerUserId : invocation.reviewerAgentId),
      human ? sql`${activityLog.runId} is null` : eq(activityLog.runId, interaction.resolvedByRunId!),
      sql`${activityLog.details}->>'interactionId' = ${id}`, sql`${activityLog.details}->>'interactionStatus' = 'accepted'`,
      sql`${activityLog.details}->>'effectiveResolverPolicy' = ${human ? "human_only" : "not_creator"}`)).limit(1);
    if (!receipt) return "resolver_receipt_missing";
  }
  // All evidence locks are held now. Time sampled before those locks can be
  // arbitrarily stale under contention, even in a 30-second authorization window.
  const finalNow = await clock(tx);
  if (invocation.expiresAt <= finalNow) return "invocation_invalid";
  if (interactions.some(row => !row.resolvedAt || row.resolvedAt > finalNow
    || finalNow.getTime() - row.resolvedAt.getTime() >= 86_400_000)) return "approval_invalid";
  return null;
}
export function governanceService(db: Db) {
  async function owned(tx: Tx, serviceId: string, ownerUserId: string, allowRevoked = false) {
    const [service] = await tx.select().from(governanceServices).where(and(
      eq(governanceServices.id, serviceId), eq(governanceServices.ownerUserId, ownerUserId),
    )).for("update");
    if (!service || (!allowRevoked && service.revokedAt)) throw forbidden("Governance owner required");
    await ownerAuthority(tx, service.companyId, ownerUserId);
    return service;
  }
  return {
    /** Trusted in-process gateway boundary ONLY. Never expose this export to machine/agent HTTP. */
    async recordInvocation(input: GovernanceInvocationInput) {
      input = parsed(governanceInvocationSchema, input);
      return db.transaction(async tx => {
        const [service] = await tx.select().from(governanceServices).where(eq(governanceServices.id, input.serviceId)).for("update");
        if (!service || service.revokedAt || service.companyId !== input.operation.companyId || service.nasTarget !== input.operation.nasTarget) throw forbidden("Governance scope mismatch");
        await ownerAuthority(tx, service.companyId, service.ownerUserId);
        const opHash = hashGovernanceOperation(input.operation);
        // Serialize the company-wide operation key even across distinct services.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${service.companyId + ":" + opHash}, 0))`);
        const [existing] = await tx.select().from(governanceInvocations).where(and(
          eq(governanceInvocations.companyId, service.companyId), eq(governanceInvocations.opHash, opHash),
        )).for("update");
        const now = await clock(tx);
        if (existing) {
          const bindingKeys = ["serviceId", "issuer", "operationDocumentId", "operationRevisionId", "reviewIssueId", "reviewerAgentId", "fpInteractionId", "humanInteractionId"] as const;
          if (existing.revokedAt || bindingKeys.some(key => existing[key] !== input[key])) throw conflict("Invocation binding conflict");
          const [reservation] = await tx.select().from(governanceVerifications).where(eq(governanceVerifications.invocationId, existing.id)).for("update");
          if (reservation?.dispatchId) throw conflict("Operation already dispatched; no replay");
          if (existing.expiresAt > now) return existing;
          // No intent exists for an unused reservation. Delete its ID so a stale
          // verification can never acquire authority from a renewed invocation.
          if (reservation) await tx.delete(governanceVerifications).where(eq(governanceVerifications.id, reservation.id));
          const [renewed] = await tx.update(governanceInvocations).set({ expiresAt: new Date(now.getTime() + 30_000) })
            .where(eq(governanceInvocations.id, existing.id)).returning();
          return renewed!;
        }
        const [row] = await tx.insert(governanceInvocations).values({ ...input, companyId: service.companyId,
          opHash, expiresAt: new Date(now.getTime() + 30_000) }).returning();
        return row!;
      });
    },
    async verify(principal: GovernancePrincipal, input: unknown) {
      const request = parsed(governanceVerifySchema, input);
      return db.transaction(async tx => {
        const { service, now } = await principalLock(tx, principal);
        const invocation = await invocationLock(tx, principal, request.invocationId);
        if (request.opHash !== invocation.opHash) throw conflict("Operation hash mismatch");
        const reasonCode = await checkEvidence(tx, invocation, service.ownerUserId, now);
        if (reasonCode) return { decision: "deny" as const, reasonCode, checkedAt: now, expiresAt: now, verificationId: null };
        const { now: finalNow } = await principalLock(tx, principal);
        const [existing] = await tx.select().from(governanceVerifications).where(eq(governanceVerifications.invocationId, invocation.id)).for("update");
        if (existing && (existing.credentialId !== principal.credentialId || existing.idempotencyKey !== request.idempotencyKey || existing.dispatchId)) throw conflict("Verification already reserved or consumed");
        const verification = existing ?? (await tx.insert(governanceVerifications).values({ invocationId: invocation.id,
          credentialId: principal.credentialId, idempotencyKey: request.idempotencyKey,
          expiresAt: new Date(Math.min(now.getTime() + 30_000, invocation.expiresAt.getTime())) }).returning())[0]!;
        if (verification.expiresAt <= finalNow) throw conflict("Verification expired");
        return { decision: "allow" as const, reasonCode: "evidence_valid", checkedAt: finalNow,
          expiresAt: verification.expiresAt, verificationId: verification.id, opHash: invocation.opHash, contractRevision: 1 };
      });
    },
    async consume(principal: GovernancePrincipal, verificationId: string | null, input: unknown) {
      const request = parsed(governanceConsumeSchema, input);
      if (!verificationId) throw notFound("Governance evidence not found");
      return db.transaction(async tx => {
        const { service, now } = await principalLock(tx, principal);
        const [verification] = await tx.select().from(governanceVerifications).where(and(eq(governanceVerifications.id, verificationId),
          eq(governanceVerifications.credentialId, principal.credentialId))).for("update");
        if (!verification) throw notFound("Governance evidence not found");
        const invocation = await invocationLock(tx, principal, verification.invocationId);
        if (request.opHash !== invocation.opHash || (verification.consumeKey && verification.consumeKey !== request.idempotencyKey)) throw conflict("Consume replay mismatch");
        if (verification.dispatchId) return { dispatchId: verification.dispatchId, dispatchAllowed: false, noReplay: true, state: "claimed" };
        if (verification.expiresAt <= now) throw conflict("Verification expired");
        const reasonCode = await checkEvidence(tx, invocation, service.ownerUserId, now);
        if (reasonCode) throw conflict("Governance evidence changed", { code: reasonCode });
        const { now: finalNow } = await principalLock(tx, principal);
        if (verification.expiresAt <= finalNow || invocation.expiresAt <= finalNow) throw conflict("Verification expired");
        const dispatchId = randomUUID();
        // Intent and claim commit together. A failed sink rolls back the reservation mutation.
        await tx.insert(governanceAuditEvents).values({ companyId: principal.companyId, verificationId,
          dispatchId, type: "audit_intent", reasonCode: "none", idempotencyKey: "intent" });
        await tx.update(governanceVerifications).set({ dispatchId, consumeKey: request.idempotencyKey }).where(eq(governanceVerifications.id, verificationId));
        return { dispatchId, dispatchAllowed: true, noReplay: true, state: "claimed" };
      });
    },
    async appendEvent(principal: GovernancePrincipal, dispatchId: string, input: unknown) {
      const event = parsed(governanceEventSchema, input);
      return db.transaction(async tx => {
        // Completion is a claim about an already committed dispatch, never new
        // authority. Retired credentials retain only their own bounded receipt.
        const [service] = await tx.select().from(governanceServices).where(eq(governanceServices.id, principal.serviceId)).for("update");
        const [credential] = await tx.select().from(governanceCredentials).where(eq(governanceCredentials.id, principal.credentialId)).for("update");
        if (!service || !credential || credential.serviceId !== service.id
          || service.companyId !== principal.companyId || service.nasTarget !== principal.nasTarget) throw unauthorized();
        const [verification] = await tx.select().from(governanceVerifications).where(and(
          eq(governanceVerifications.dispatchId, dispatchId),
          eq(governanceVerifications.credentialId, principal.credentialId),
        )).for("update");
        if (!verification) throw notFound("Governance evidence not found");
        await invocationLock(tx, principal, verification.invocationId);
        const events = await tx.select().from(governanceAuditEvents).where(and(
          eq(governanceAuditEvents.companyId, principal.companyId),
          eq(governanceAuditEvents.dispatchId, dispatchId),
        ));
        const intent = events.find(row => row.type === "audit_intent");
        const now = await clock(tx);
        if (!intent || now.getTime() - intent.createdAt.getTime() >= 86_400_000 || intent.createdAt > now) throw forbidden("Dispatch outcome window closed");
        const existing = events.find(row => row.idempotencyKey === event.idempotencyKey);
        if (existing) {
          if (existing.type !== event.type || existing.reasonCode !== event.reasonCode
            || existing.artifactDigest !== (event.artifactDigest ?? null)) throw conflict("Audit replay mismatch");
          return { id: existing.id, noReplay: true as const };
        }
        if (!events.some(row => row.type === "audit_intent") || events.some(row => row.type !== "audit_intent")) {
          throw conflict("Dispatch outcome already reported or intent missing");
        }
        const [row] = await tx.insert(governanceAuditEvents).values({
          ...event, verificationId: verification.id, companyId: principal.companyId, dispatchId,
        }).returning({ id: governanceAuditEvents.id });
        return { id: row!.id, noReplay: true as const };
      });
    },
    async evidence(companyId: string, reviewerAgentId: string, runId: string, issueId: string) {
      const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, reviewerAgentId)));
      if (!run || run.status !== "running" || !run.startedAt || run.finishedAt || !run.nativeIssueId) throw forbidden("Reviewer run required");
      const [reviewIssue] = await db.select().from(issues).where(and(eq(issues.id, run.nativeIssueId), eq(issues.companyId, companyId), eq(issues.assigneeAgentId, reviewerAgentId)));
      if (!reviewIssue || reviewIssue.hiddenAt) throw forbidden("Assigned reviewer required");
      return db.select({ id: governanceAuditEvents.id, type: governanceAuditEvents.type, reasonCode: governanceAuditEvents.reasonCode,
        createdAt: governanceAuditEvents.createdAt, dispatchId: governanceAuditEvents.dispatchId, opHash: governanceInvocations.opHash })
        .from(governanceAuditEvents).innerJoin(governanceVerifications, eq(governanceVerifications.id, governanceAuditEvents.verificationId))
        .innerJoin(governanceInvocations, eq(governanceInvocations.id, governanceVerifications.invocationId))
        .where(and(eq(governanceAuditEvents.companyId, companyId), eq(governanceInvocations.companyId, companyId),
          eq(governanceInvocations.reviewerAgentId, reviewerAgentId), eq(governanceInvocations.reviewIssueId, run.nativeIssueId!),
          sql`${governanceInvocations.operation}->>'issueId' = ${issueId}`)).orderBy(governanceAuditEvents.createdAt).limit(100);
    },
    async createService(input: { companyId: string; ownerUserId: string; nasTarget: string }) {
      if (!/^[a-zA-Z0-9._-]{1,80}$/.test(input.nasTarget)) throw unprocessable("Invalid NAS target");
      return db.transaction(async tx => {
        await ownerAuthority(tx, input.companyId, input.ownerUserId);
        const [service] = await tx.insert(governanceServices).values(input).returning();
        await lifecycle(tx, service!, "governance.service_created");
        return service!;
      });
    },
    async revokeService(serviceId: string, ownerUserId: string) {
      await db.transaction(async tx => {
        const service = await owned(tx, serviceId, ownerUserId, true);
        if (service.revokedAt) return;
        await tx.update(governanceServices).set({ revokedAt: await clock(tx) }).where(eq(governanceServices.id, serviceId));
        await lifecycle(tx, service, "governance.service_revoked");
      });
    },
    async issueCredential(serviceId: string, ownerUserId: string, expiresAt: Date) {
      return db.transaction(async tx => {
        const service = await owned(tx, serviceId, ownerUserId);
        const now = await clock(tx);
        if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= now
          || expiresAt.getTime() > now.getTime() + 86_400_000) throw unprocessable("Credential TTL must be positive and at most 24h");
        const token = `pcgov_${randomBytes(32).toString("hex")}`;
        const [credential] = await tx.insert(governanceCredentials).values({ serviceId, tokenHash: hash(token), expiresAt }).returning();
        await lifecycle(tx, service, "governance.credential_issued", credential!.id);
        return { id: credential!.id, expiresAt, token };
      });
    },
    async listCredentials(serviceId: string, ownerUserId: string) {
      return db.transaction(async tx => {
        await owned(tx, serviceId, ownerUserId, true);
        return tx.select({ id: governanceCredentials.id, expiresAt: governanceCredentials.expiresAt,
          revokedAt: governanceCredentials.revokedAt, createdAt: governanceCredentials.createdAt })
          .from(governanceCredentials).where(eq(governanceCredentials.serviceId, serviceId));
      });
    },
    async revokeCredential(serviceId: string, credentialId: string, ownerUserId: string) {
      await db.transaction(async tx => {
        const service = await owned(tx, serviceId, ownerUserId, true);
        const [credential] = await tx.select().from(governanceCredentials).where(and(
          eq(governanceCredentials.id, credentialId), eq(governanceCredentials.serviceId, serviceId),
        )).for("update");
        if (!credential) throw notFound("Governance credential not found");
        if (credential.revokedAt) return;
        await tx.update(governanceCredentials).set({ revokedAt: await clock(tx) }).where(eq(governanceCredentials.id, credentialId));
        await lifecycle(tx, service, "governance.credential_revoked", credentialId);
      });
    },
    /** Authentication for outcome POST only; appendEvent binds the original
     * credential and immutable intent and applies a 24-hour completion window. */
    async authenticateOutcome(token: string): Promise<GovernancePrincipal> {
      if (!/^pcgov_[a-f0-9]{64}$/.test(token)) throw unauthorized();
      const [row] = await db.select({ credential: governanceCredentials, service: governanceServices })
        .from(governanceCredentials).innerJoin(governanceServices, eq(governanceServices.id, governanceCredentials.serviceId))
        .where(eq(governanceCredentials.tokenHash, hash(token)));
      if (!row) throw unauthorized();
      return { serviceId: row.service.id, credentialId: row.credential.id, companyId: row.service.companyId, nasTarget: row.service.nasTarget };
    },
    async authenticate(token: string): Promise<GovernancePrincipal> {
      if (!/^pcgov_[a-f0-9]{64}$/.test(token)) throw unauthorized();
      const [row] = await db.select({ credential: governanceCredentials, service: governanceServices })
        .from(governanceCredentials).innerJoin(governanceServices, eq(governanceServices.id, governanceCredentials.serviceId))
        .where(and(eq(governanceCredentials.tokenHash, hash(token)), sql`${governanceCredentials.revokedAt} is null`,
          sql`${governanceServices.revokedAt} is null`, sql`${governanceCredentials.expiresAt} > clock_timestamp()`));
      if (!row) throw unauthorized();
      return { serviceId: row.service.id, credentialId: row.credential.id, companyId: row.service.companyId, nasTarget: row.service.nasTarget };
    },
  };
}
