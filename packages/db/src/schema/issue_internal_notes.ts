import { foreignKey, index, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

// Separate from issue_comments: never fed into agent context, search,
// references, activity bodies, wakes or external chat publications.
export const issueInternalNotes = pgTable("issue_internal_notes", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  issueId: uuid("issue_id").notNull(),
  authorUserId: text("author_user_id").notNull(),
  clientRequestId: uuid("client_request_id").notNull(),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  issueCompanyFk: foreignKey({ columns: [table.companyId, table.issueId], foreignColumns: [issues.companyId, issues.id], name: "issue_internal_notes_issue_company_fk" }).onDelete("cascade"),
  requestUq: unique("issue_internal_notes_request_uq").on(table.issueId, table.authorUserId, table.clientRequestId),
  issueIdx: index("issue_internal_notes_issue_idx").on(table.companyId, table.issueId, table.createdAt, table.id),
}));
