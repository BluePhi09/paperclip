CREATE TABLE "issue_internal_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"author_user_id" text NOT NULL,
	"client_request_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_internal_notes_request_uq" UNIQUE("issue_id","author_user_id","client_request_id")
);
--> statement-breakpoint
ALTER TABLE "issue_internal_notes" ADD CONSTRAINT "issue_internal_notes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_internal_notes" ADD CONSTRAINT "issue_internal_notes_issue_company_fk" FOREIGN KEY ("company_id","issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issue_internal_notes_issue_idx" ON "issue_internal_notes" USING btree ("company_id","issue_id","created_at","id");