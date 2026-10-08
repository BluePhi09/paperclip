import { z } from "zod";
const uuid = z.string().uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const opaque = z.string().regex(/^[A-Za-z0-9._-]{1,80}$/);
export const governanceOperationSchema = z.object({
  version: z.literal(1), companyId: uuid, nasTarget: opaque,
  agentId: uuid, issueId: uuid, runId: uuid, requesterAgentId: uuid,
  // Bounded NE-only slice: never infer Routine-R or downgrade a caller's effects.
  effectClass: z.literal("NE"), entryId: opaque, api: opaque, method: opaque,
  apiVersion: z.number().int().positive(), paramsDigest: digest,
  targetIds: z.array(opaque).min(1).max(20), registerDocumentId: uuid,
  registerRevision: uuid, preconditionDigest: digest,
}).strict();
export type GovernanceOperation = z.infer<typeof governanceOperationSchema>;

/**
 * Versioned register body. Deny by default: an operation is authorized only when
 * an entry matches its entry id, effect class, API, method, API version and every
 * target id exactly. Any parse failure, unknown field or empty target list denies.
 */
export const governanceRegisterSchema = z.object({
  version: z.literal(1),
  entries: z.array(z.object({
    entryId: opaque, effectClass: z.literal("NE"), api: opaque, method: opaque,
    apiVersion: z.number().int().positive(), targetIds: z.array(opaque).min(1).max(100),
  }).strict()).max(500),
}).strict();
export type GovernanceRegister = z.infer<typeof governanceRegisterSchema>;
export function governanceRegisterAuthorizes(body: string, operation: GovernanceOperation): boolean {
  let json: unknown;
  try { json = JSON.parse(body); } catch { return false; }
  const register = governanceRegisterSchema.safeParse(json);
  if (!register.success) return false;
  return register.data.entries.some(e => e.entryId === operation.entryId && e.effectClass === operation.effectClass
    && e.api === operation.api && e.method === operation.method && e.apiVersion === operation.apiVersion
    && operation.targetIds.every(t => e.targetIds.includes(t)));
}
export const governanceVerifySchema = z.object({ invocationId: uuid, opHash: digest,
  idempotencyKey: z.string().regex(/^[A-Za-z0-9._-]{1,80}$/) }).strict();
export const governanceConsumeSchema = governanceVerifySchema.omit({ invocationId: true });
export const governanceInvocationSchema = z.object({ serviceId: uuid, issuer: z.literal("paperclip-gateway"),
  operation: governanceOperationSchema, operationDocumentId: uuid, operationRevisionId: uuid,
  reviewIssueId: uuid, reviewerAgentId: uuid, fpInteractionId: uuid, humanInteractionId: uuid }).strict();
export type GovernanceInvocationInput = z.infer<typeof governanceInvocationSchema>;

// Machine reports are bounded claims, not human approvals or proof of NAS effects.
export const governanceEventSchema = z.object({
  type: z.enum(["succeeded", "failed", "unknown"]),
  reasonCode: z.enum(["none", "provider_failed", "outcome_unknown"]),
  idempotencyKey: opaque,
  artifactDigest: digest.optional(),
}).strict().refine(event =>
  (event.type === "succeeded" && event.reasonCode === "none") ||
  (event.type === "failed" && event.reasonCode === "provider_failed") ||
  (event.type === "unknown" && event.reasonCode === "outcome_unknown"),
);
