import { api } from "./client";

export type InternalNote = { id: string; companyId: string; issueId: string; authorUserId: string; body: string; createdAt: string };
export const internalNotesApi = {
  list: (issueId: string, before?: string) => api.get<{ notes: InternalNote[]; nextCursor: string | null }>(
    `/issues/${issueId}/internal-notes${before ? `?before=${encodeURIComponent(before)}` : ""}`),
  create: (issueId: string, body: string, clientRequestId: string) => api.post<InternalNote>(
    `/issues/${issueId}/internal-notes`, { body, clientRequestId }),
};
