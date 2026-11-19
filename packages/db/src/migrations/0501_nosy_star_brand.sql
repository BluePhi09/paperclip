CREATE TABLE "governance_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"verification_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"dispatch_id" uuid NOT NULL,
	"type" text NOT NULL,
	"reason_code" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"artifact_digest" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "governance_invocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"issuer" text NOT NULL,
	"operation" jsonb NOT NULL,
	"op_hash" text NOT NULL,
	"operation_document_id" uuid NOT NULL,
	"operation_revision_id" uuid NOT NULL,
	"review_issue_id" uuid NOT NULL,
	"reviewer_agent_id" uuid NOT NULL,
	"fp_interaction_id" uuid NOT NULL,
	"human_interaction_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "governance_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invocation_id" uuid NOT NULL,
	"credential_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"dispatch_id" uuid,
	"consume_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "governance_audit_events" ADD CONSTRAINT "governance_audit_events_verification_id_governance_verifications_id_fk" FOREIGN KEY ("verification_id") REFERENCES "public"."governance_verifications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_audit_events" ADD CONSTRAINT "governance_audit_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_invocations" ADD CONSTRAINT "governance_invocations_service_id_governance_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."governance_services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_invocations" ADD CONSTRAINT "governance_invocations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_verifications" ADD CONSTRAINT "governance_verifications_invocation_id_governance_invocations_id_fk" FOREIGN KEY ("invocation_id") REFERENCES "public"."governance_invocations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_verifications" ADD CONSTRAINT "governance_verifications_credential_id_governance_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."governance_credentials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "governance_audit_events_key_uq" ON "governance_audit_events" USING btree ("dispatch_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "governance_audit_events_company_idx" ON "governance_audit_events" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "governance_invocations_op_uq" ON "governance_invocations" USING btree ("company_id","op_hash");--> statement-breakpoint
CREATE INDEX "governance_invocations_review_idx" ON "governance_invocations" USING btree ("company_id","reviewer_agent_id","review_issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "governance_verifications_invocation_uq" ON "governance_verifications" USING btree ("invocation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "governance_verifications_key_uq" ON "governance_verifications" USING btree ("credential_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "governance_verifications_dispatch_uq" ON "governance_verifications" USING btree ("dispatch_id");
--> statement-breakpoint
-- Audit rows are immutable, including when a service or company is retired.
CREATE FUNCTION governance_audit_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Governance audit is append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER governance_audit_append_only
BEFORE UPDATE OR DELETE OR TRUNCATE ON governance_audit_events
FOR EACH STATEMENT EXECUTE FUNCTION governance_audit_append_only();