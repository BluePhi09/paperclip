import type { GovernanceOperation } from "@paperclipai/shared";
import { pgTable, uuid, text, timestamp, uniqueIndex, jsonb, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { authUsers } from "./auth.js";

export const governanceServices = pgTable("governance_services", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  ownerUserId: text("owner_user_id").notNull().references(() => authUsers.id),
  nasTarget: text("nas_target").notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export const governanceCredentials = pgTable("governance_credentials", {
  id: uuid("id").primaryKey().defaultRandom(),
  serviceId: uuid("service_id").notNull().references(() => governanceServices.id),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ hashUq: uniqueIndex("governance_credentials_hash_uq").on(t.tokenHash) }));

export const governanceInvocations = pgTable("governance_invocations", {
  id: uuid("id").primaryKey().defaultRandom(),
  serviceId: uuid("service_id").notNull().references(() => governanceServices.id),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  issuer: text("issuer").notNull(),
  operation: jsonb("operation").$type<GovernanceOperation>().notNull(),
  opHash: text("op_hash").notNull(),
  operationDocumentId: uuid("operation_document_id").notNull(),
  operationRevisionId: uuid("operation_revision_id").notNull(),
  reviewIssueId: uuid("review_issue_id").notNull(),
  reviewerAgentId: uuid("reviewer_agent_id").notNull(),
  fpInteractionId: uuid("fp_interaction_id").notNull(),
  humanInteractionId: uuid("human_interaction_id").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({ opUq: uniqueIndex("governance_invocations_op_uq").on(t.companyId, t.opHash),
  reviewIdx: index("governance_invocations_review_idx").on(t.companyId, t.reviewerAgentId, t.reviewIssueId) }));
export const governanceVerifications = pgTable("governance_verifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  invocationId: uuid("invocation_id").notNull().references(() => governanceInvocations.id),
  credentialId: uuid("credential_id").notNull().references(() => governanceCredentials.id),
  idempotencyKey: text("idempotency_key").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  dispatchId: uuid("dispatch_id"),
  consumeKey: text("consume_key"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({ invocationUq: uniqueIndex("governance_verifications_invocation_uq").on(t.invocationId),
  keyUq: uniqueIndex("governance_verifications_key_uq").on(t.credentialId, t.idempotencyKey),
  dispatchUq: uniqueIndex("governance_verifications_dispatch_uq").on(t.dispatchId) }));
export const governanceAuditEvents = pgTable("governance_audit_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  verificationId: uuid("verification_id").notNull().references(() => governanceVerifications.id),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  dispatchId: uuid("dispatch_id").notNull(),
  type: text("type").notNull(),
  reasonCode: text("reason_code").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  artifactDigest: text("artifact_digest"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({ keyUq: uniqueIndex("governance_audit_events_key_uq").on(t.dispatchId, t.idempotencyKey),
  companyIdx: index("governance_audit_events_company_idx").on(t.companyId, t.createdAt) }));
