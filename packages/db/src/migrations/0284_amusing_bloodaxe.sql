ALTER TABLE "chat_conversations" ADD COLUMN "binding_mode" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD COLUMN "origin_principal_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD COLUMN "origin_user_id" text;--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_origin_principal_fk" FOREIGN KEY ("company_id","origin_principal_id") REFERENCES "public"."chat_external_principals"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_binding_mode_check" CHECK ("chat_conversations"."binding_mode" in ('legacy', 'slack_dm_thread_v2'));--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_slack_thread_binding_check" CHECK ("chat_conversations"."binding_mode" = 'legacy' or (
      "chat_conversations"."is_direct_message" and "chat_conversations"."session_generation" = 1
      and "chat_conversations"."origin_principal_id" is not null and "chat_conversations"."origin_user_id" is not null
      and "chat_conversations"."external_conversation_id" ~ '^D[A-Z0-9]+$'
      and "chat_conversations"."external_thread_id" ~ '^slack:D[A-Z0-9]+:[0-9]{1,12}[.][0-9]{1,6}$'
      and split_part("chat_conversations"."external_thread_id", ':', 2) = "chat_conversations"."external_conversation_id"));