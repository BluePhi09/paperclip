import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { authApi } from "@/api/auth";
import { chatEndpointsApi } from "@/api/chatEndpoints";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { queryKeys } from "@/lib/queryKeys";

type Draft = { body: string; clientRequestId: string };
export function SlackReplyComposer({ companyId, issueId, endpointId, conversationId, issueCacheRefs = [], sharedThread = false }: {
  companyId: string; issueId: string; endpointId: string; conversationId: string; issueCacheRefs?: string[]; sharedThread?: boolean;
}) {
  const client = useQueryClient();
  const session = useQuery({ queryKey: queryKeys.auth.session, queryFn: authApi.getSession });
  const userId = session.data?.user.id;
  const key = userId ? `paperclip:slack-reply:v1:${companyId}:${userId}:${issueId}:${endpointId}:${conversationId}` : null;
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [saved, setSaved] = useState<Draft | null>(null);
  const [storageError, setStorageError] = useState(false);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setReady(false); setSaved(null); setBody(""); setOpen(false); setStorageError(false);
    if (!key) return;
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const draft = JSON.parse(raw) as Draft;
        if (typeof draft.body !== "string" || typeof draft.clientRequestId !== "string") throw new Error("Invalid draft");
        setSaved(draft); setBody(draft.body); setOpen(true);
      }
      setReady(true);
    } catch { setStorageError(true); }
  }, [key]);
  const send = useMutation({
    mutationFn: async () => {
      if (!key || !ready) throw new Error("Sign in and allow browser storage before sending.");
      const draft = saved ?? { body: body.trim(), clientRequestId: crypto.randomUUID() };
      // Persist before sending: a lost response or browser reload retries the
      // same server receipt rather than starting a second agent run.
      localStorage.setItem(key, JSON.stringify(draft)); setSaved(draft);
      const result = await chatEndpointsApi.requestSlackReply(endpointId, conversationId, draft.body, draft.clientRequestId);
      localStorage.removeItem(key);
      return result;
    },
    onSuccess: () => {
      setSaved(null); setBody("");
      for (const ref of new Set([issueId, ...issueCacheRefs])) {
        void client.invalidateQueries({ queryKey: queryKeys.issues.comments(ref) });
        void client.invalidateQueries({ queryKey: queryKeys.issues.detail(ref) });
      }
    },
  });
  return <div className="space-y-3">
    <Button size="sm" variant="outline" onClick={() => setOpen(value => !value)}>Reply via Slack</Button>
    {open && <div className="space-y-3 border-t border-border pt-3">
      <label htmlFor="slack-agent-reply" className="text-sm font-medium">Ask the agent to reply in your linked Slack {sharedThread ? "thread" : "DM"}</label>
      <p className="text-xs text-muted-foreground">{sharedThread
        ? "Your request and the agent’s answer are shared in the linked Slack thread. The agent starts after your request is delivered."
        : "Only the agent’s answer to this request is sent to Slack. Your request is saved in Paperclip. Ordinary task messages stay internal."}</p>
      <Textarea id="slack-agent-reply" value={body} onChange={event => setBody(event.target.value)}
        disabled={send.isPending || Boolean(saved)} maxLength={8000} placeholder="What should the agent answer in Slack?" />
      {storageError && <p role="alert" className="text-sm text-destructive">The saved request could not be read. Restore browser storage before sending.</p>}
      {send.isError && <p role="alert" className="text-sm text-destructive">{send.error instanceof Error ? send.error.message : "The request could not be confirmed. Retry this same request."}</p>}
      {send.isSuccess && <p role="status" className="text-sm text-muted-foreground">{send.data.status === "failed"
        ? "This request was not started. Check the connection and task before submitting a new request."
        : "Request saved. This is not a delivery receipt; the agent’s answer will appear in the task and, if delivery succeeds, Slack."}</p>}
      <div className="flex items-center justify-between gap-3">
        <Button variant="ghost" onClick={() => setOpen(false)}>Close</Button>
        <Button disabled={!ready || storageError || !body.trim() || send.isPending} onClick={() => send.mutate()}>
          {send.isPending ? "Saving request…" : saved ? "Retry same request" : "Ask and reply via Slack"}
        </Button>
      </div>
    </div>}
  </div>;
}
