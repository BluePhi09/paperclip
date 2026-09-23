import { useState } from "react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { internalNotesApi } from "@/api/internalNotes";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

/** Separate editor and query cache: private drafts never enter the task
 * composer, its localStorage, transcript, copy/export or agent history. */
export function TaskInternalNotes({ issueId, companyId, userId }: { issueId: string; companyId: string; userId: string }) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [pending, setPending] = useState<{ body: string; id: string } | null>(null);
  const client = useQueryClient();
  const key = ["human-internal-notes", companyId, userId, issueId];
  const notes = useInfiniteQuery({ queryKey: key, enabled: open, gcTime: 0,
    queryFn: ({ pageParam }) => internalNotesApi.list(issueId, pageParam ?? undefined),
    initialPageParam: null as string | null, getNextPageParam: page => page.nextCursor ?? undefined });
  const save = useMutation({
    mutationFn: async () => {
      const request = pending ?? { body: body.trim(), id: crypto.randomUUID() };
      setPending(request);
      const saved = await internalNotesApi.create(issueId, request.body, request.id);
      if (!saved?.id || saved.issueId !== issueId || saved.body !== request.body) throw new Error("Could not confirm the saved note. Retry this same note.");
      return saved;
    },
    onSuccess: () => { setBody(""); setPending(null); void client.invalidateQueries({ queryKey: key }); },
  });
  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogTrigger asChild><Button size="sm" variant="ghost">Internal notes</Button></DialogTrigger>
    <DialogContent>
      <DialogHeader><DialogTitle>Internal notes</DialogTitle><DialogDescription>
        For signed-in people in this company only. Not sent to Slack or included in agent context. Text only; unsaved notes are lost if you leave this task.
      </DialogDescription></DialogHeader>
      <div className="max-h-64 overflow-y-auto space-y-3">
        {notes.isPending && <p className="text-sm text-muted-foreground">Loading notes…</p>}
        {notes.isError && <p role="alert" className="text-sm text-destructive">Could not load notes. <Button variant="link" onClick={() => void notes.refetch()}>Retry</Button></p>}
        {notes.data?.pages.flatMap(page => page.notes).map(note => <div key={note.id} className="space-y-1">
          <p className="text-xs text-muted-foreground">{note.authorUserId === userId ? "You" : "Team member"} · {new Date(note.createdAt).toLocaleString()}</p>
          <p className="whitespace-pre-wrap break-words text-sm">{note.body}</p>
        </div>)}
        {notes.data?.pages[0]?.notes.length === 0 && <p className="text-sm text-muted-foreground">No Internal notes yet.</p>}
        {notes.hasNextPage && <Button variant="ghost" disabled={notes.isFetchingNextPage} onClick={() => void notes.fetchNextPage()}>Older notes</Button>}
      </div>
      <label htmlFor="task-internal-note" className="text-sm">New Internal note</label>
      <Textarea id="task-internal-note" value={body} maxLength={8000} disabled={save.isPending || Boolean(pending)} onChange={event => { setBody(event.target.value); save.reset(); }} />
      {save.isError && <p role="alert" className="text-sm text-destructive">Could not confirm the save. Retry the same note; it will not create a duplicate.</p>}
      {save.isSuccess && <p role="status" className="text-sm text-muted-foreground">Note saved for people only. The CEO was not notified.</p>}
      <div className="flex items-center justify-between gap-3">
        <Button variant="ghost" onClick={() => setOpen(false)}>Close</Button>
        <Button disabled={!body.trim() || save.isPending} onClick={() => save.mutate()}>{save.isPending ? "Saving…" : pending ? "Retry same note" : "Save Internal note"}</Button>
      </div>
    </DialogContent>
  </Dialog>;
}
