import { z } from "zod";

export const evidenceScopeSchema = z.object({
  action: z.string().min(1).max(120),
  target: z.string().min(1).max(500),
  exclusions: z.array(z.string().min(1).max(500)).max(50),
}).strict();

export const evidencePackBindingSchema = z.object({
  schemaVersion: z.literal(1),
  documentId: z.string().guid(),
  revisionId: z.string().guid(),
  scope: evidenceScopeSchema,
  receipts: z.array(z.string().guid()).min(1).max(50),
}).strict();
export const evidenceDocumentRefSchema = z.object({
  issueId: z.string().guid(),
  key: z.string().min(1).max(120),
  documentId: z.string().guid(),
  revisionId: z.string().guid(),
}).strict();

/** Redacted native target-context document; no credentials or secret hashes. */
export const evidenceTargetContextSchema = z.object({
  target: z.string().min(1).max(500),
  adapterType: z.string().min(1).max(120),
  environmentId: z.string().guid().nullable(),
  environmentDriver: z.string().min(1).max(120),
  executionWorkspaceId: z.string().guid().nullable(),
}).strict().refine((context) => context.environmentDriver === "local" || context.environmentId !== null,
  "Remote evidence must identify the exact environment");
export const evidencePackSchema = z.object({
  schemaVersion: z.literal(1),
  subjectIssueId: z.string().guid(),
  purpose: z.literal("execution_authorization"),
  scope: evidenceScopeSchema,
  policySource: evidenceDocumentRefSchema,
  artifacts: z.array(evidenceDocumentRefSchema).min(1).max(50),
  requiredReviewerAgentIds: z.array(z.string().guid()).min(1).max(20)
    .refine((ids) => new Set(ids).size === ids.length, "Reviewers must be distinct"),
  prerequisiteIssueIds: z.array(z.string().guid()).max(50),
  freshness: z.object({
    context: evidenceDocumentRefSchema,
    expiresAt: z.string().datetime(),
  }).strict(),
  conditions: z.array(z.object({
    id: z.string().min(1).max(120),
    proof: evidenceDocumentRefSchema,
    reviewerAgentId: z.string().guid(),
    receiptId: z.string().guid(),
  }).strict()).max(50).refine((conditions) => new Set(conditions.map((c) => c.id)).size === conditions.length, "Condition IDs must be distinct"),
}).strict();
export type EvidencePack = z.infer<typeof evidencePackSchema>;
export type EvidenceDocumentRef = z.infer<typeof evidenceDocumentRefSchema>;
export type EvidencePackBinding = z.infer<typeof evidencePackBindingSchema>;
