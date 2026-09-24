import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { IssueWorkMode } from "@paperclipai/shared";
import { AlertTriangle, Check, ChevronDown, FolderKanban, Pencil, RotateCcw, Sparkles, Tag, Undo2 } from "lucide-react";
import { AgentAvatar } from "@/components/AgentAvatar";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { workModeMetaFor, workModeMetaList } from "@/lib/work-mode-meta";
import {
  JEV_AGENTS,
  JEV_MIN_PROMPT_LENGTH,
  JEV_NAME,
  JEV_PROJECTS,
  JEV_TASK_TYPES,
  classifyTaskPrompt,
  type JevSuggestion,
  type JevTaskType,
} from "./jev-classifier";

export type JevTaskComposerProps = {
  /**
   * `suggest-first`: Jev fills title and properties while you type; you review and create.
   * `instant`: like starting a Claude Code session. Create right away; the task opens as
   * "Untitled" and Jev names, classifies, and assigns it a moment later.
   */
  flow?: "suggest-first" | "instant";
  initialPrompt?: string;
  /** Simulated Jev latency in milliseconds. */
  latencyMs?: number;
  /** Simulate Jev being unavailable; the composer falls back to manual fields. */
  jevUnavailable?: boolean;
  /** Pre-set fields as if the user already chose them. Jev never overwrites these. */
  presetAssigneeId?: string;
  /** Types `initialPrompt` in character by character to show suggestions arriving. */
  typeOnMount?: boolean;
  mobile?: boolean;
};

type Field = "title" | "type" | "assigneeId" | "projectId" | "workMode";
type Overrides = Partial<{ title: string; type: JevTaskType; assigneeId: string; projectId: string | null; workMode: IssueWorkMode }>;
type JevStatus = "idle" | "thinking" | "ready" | "error";
type CreatedTask = { identifier: string; prompt: string };

const TYPING_DEBOUNCE_MS = 650;

/** Types a newly suggested title in, like a session title arriving. Unchanged titles don't retype. */
function useTypewriter(target: string | null) {
  const [shown, setShown] = useState("");
  const previousRef = useRef<string | null>(null);
  useEffect(() => {
    const previous = previousRef.current;
    previousRef.current = target;
    if (!target) return setShown("");
    if (target === previous) return setShown(target);
    setShown("");
    let index = 0;
    const timer = window.setInterval(() => {
      index += 1;
      setShown(target.slice(0, index));
      if (index >= target.length) window.clearInterval(timer);
    }, 22);
    return () => window.clearInterval(timer);
  }, [target]);
  return shown;
}

export function JevTaskComposer({
  flow = "suggest-first",
  initialPrompt = "",
  latencyMs = 900,
  jevUnavailable = false,
  presetAssigneeId,
  typeOnMount = false,
  mobile = false,
}: JevTaskComposerProps) {
  const [prompt, setPrompt] = useState(typeOnMount ? "" : initialPrompt);
  const [status, setStatus] = useState<JevStatus>("idle");
  const [suggestion, setSuggestion] = useState<JevSuggestion | null>(null);
  const [overrides, setOverrides] = useState<Overrides>(presetAssigneeId ? { assigneeId: presetAssigneeId } : {});
  const [editingTitle, setEditingTitle] = useState(false);
  const [created, setCreated] = useState<CreatedTask | null>(null);
  const [whyOpen, setWhyOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const lastClassifiedRef = useRef("");

  // Autoplay: type the scenario prompt so reviewers see Jev react mid-sentence.
  useEffect(() => {
    if (!typeOnMount || !initialPrompt) return;
    let index = 0;
    const timer = window.setInterval(() => {
      index += 2;
      setPrompt(initialPrompt.slice(0, index));
      if (index >= initialPrompt.length) window.clearInterval(timer);
    }, 40);
    return () => window.clearInterval(timer);
  }, [typeOnMount, initialPrompt]);

  const runJev = useCallback((text: string) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    lastClassifiedRef.current = text;
    setStatus("thinking");
    classifyTaskPrompt(text, { latencyMs, fail: jevUnavailable, signal: controller.signal })
      .then((result) => {
        setSuggestion(result);
        setStatus("ready");
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setStatus("error");
      });
  }, [latencyMs, jevUnavailable]);

  // Suggest-first: re-classify after the user pauses typing.
  useEffect(() => {
    if (flow !== "suggest-first" || created) return;
    const text = prompt.trim();
    if (text.length < JEV_MIN_PROMPT_LENGTH) {
      abortRef.current?.abort();
      setStatus("idle");
      setSuggestion(null);
      return;
    }
    if (text === lastClassifiedRef.current) return;
    const timer = window.setTimeout(() => runJev(text), TYPING_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [prompt, flow, created, runJev]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const effective = useMemo(() => ({
    title: overrides.title ?? suggestion?.title ?? "",
    type: overrides.type ?? suggestion?.type ?? null,
    assigneeId: overrides.assigneeId ?? suggestion?.assigneeId ?? null,
    projectId: overrides.projectId !== undefined ? overrides.projectId : suggestion?.projectId ?? null,
    workMode: overrides.workMode ?? suggestion?.workMode ?? "standard",
  }), [overrides, suggestion]);

  const isSuggested = (field: Field) => suggestion !== null && overrides[field] === undefined;
  const setField = <K extends keyof Overrides>(field: K, value: Overrides[K]) =>
    setOverrides((current) => ({ ...current, [field]: value }));
  const resetField = (field: Field) =>
    setOverrides((current) => {
      const next = { ...current };
      delete next[field];
      return next;
    });

  const canCreate = prompt.trim().length > 0;
  const create = () => {
    if (!canCreate) return;
    setCreated({ identifier: "PAP-412", prompt: prompt.trim() });
    // Instant flow: Jev runs after creation, like a session title arriving.
    if (flow === "instant" || status === "idle" || status === "thinking") runJev(prompt.trim());
  };
  const startOver = () => {
    abortRef.current?.abort();
    lastClassifiedRef.current = "";
    setPrompt("");
    setSuggestion(null);
    setOverrides({});
    setStatus("idle");
    setCreated(null);
    setWhyOpen(false);
  };

  const animatedTitle = useTypewriter(isSuggested("title") ? effective.title : null);
  const headerTitle = isSuggested("title") ? animatedTitle : effective.title;

  return (
    <div className={cn("flex min-h-screen w-full items-start justify-center bg-background p-4 sm:p-10", mobile && "p-0 sm:p-0")}>
      <div
        className={cn(
          "flex w-full flex-col overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-lg",
          mobile ? "min-h-screen max-w-sm rounded-none border-0" : "max-w-2xl",
        )}
      >
        <ComposerHeader
          identifier={created?.identifier}
          title={headerTitle}
          thinking={status === "thinking" && !effective.title}
          suggested={isSuggested("title")}
          editing={editingTitle}
          onEdit={() => setEditingTitle(true)}
          onCommit={(value) => {
            setEditingTitle(false);
            if (value.trim() && value.trim() !== effective.title) setField("title", value.trim());
          }}
          onReset={overrides.title !== undefined && suggestion ? () => resetField("title") : undefined}
        />

        {created ? (
          <CreatedBody prompt={created.prompt} />
        ) : (
          <div className="flex flex-col gap-3 px-4 pt-4 pb-2">
            <Textarea
              autoFocus
              aria-label="Describe the task"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  create();
                }
              }}
              placeholder={flow === "instant"
                ? `What should get done? ${JEV_NAME} will name it and route it once you start.`
                : `What should get done? ${JEV_NAME} will suggest a title, type, and owner as you write.`}
              className="min-h-36 resize-none border-0 bg-transparent px-0 text-base shadow-none focus-visible:ring-0 dark:bg-transparent"
            />
          </div>
        )}

        <JevPanel
          flow={flow}
          created={created !== null}
          status={status}
          promptLength={prompt.trim().length}
          suggestion={suggestion}
          effective={effective}
          isSuggested={isSuggested}
          setField={setField}
          resetField={resetField}
          whyOpen={whyOpen}
          onToggleWhy={() => setWhyOpen((open) => !open)}
          onRetry={() => runJev(prompt.trim())}
        />

        <div className="mt-auto flex items-center justify-between gap-3 border-t border-border px-4 py-3">
          {created ? (
            <>
              <Button variant="ghost" size="sm" onClick={startOver}>
                <RotateCcw /> New task
              </Button>
              <span className="text-xs text-muted-foreground">
                {status === "thinking" ? `${JEV_NAME} is routing this task…` : status === "ready" ? "Task created and assigned." : "Task created."}
              </span>
            </>
          ) : (
            <>
              <Button variant="ghost" size="sm" onClick={startOver} disabled={!prompt}>
                Cancel
              </Button>
              <div className="flex items-center gap-3">
                {flow === "suggest-first" && status === "thinking" ? (
                  <span className="hidden text-xs text-muted-foreground sm:inline">You can create now; {JEV_NAME} will finish after.</span>
                ) : null}
                <Button size="sm" onClick={create} disabled={!canCreate}>
                  {flow === "instant" ? "Start task" : "Create task"}
                  <kbd className="ml-1 hidden text-xs opacity-60 sm:inline">⌘↵</kbd>
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function JevMark({ thinking = false, className }: { thinking?: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary",
        thinking && "animate-pulse",
        className,
      )}
    >
      <Sparkles className="size-3" />
    </span>
  );
}

function ComposerHeader({
  identifier,
  title,
  thinking,
  suggested,
  editing,
  onEdit,
  onCommit,
  onReset,
}: {
  identifier?: string;
  title: string;
  thinking: boolean;
  suggested: boolean;
  editing: boolean;
  onEdit: () => void;
  onCommit: (value: string) => void;
  onReset?: () => void;
}) {
  const [draft, setDraft] = useState(title);
  useEffect(() => { if (editing) setDraft(title); }, [editing, title]);

  return (
    <div className="flex min-h-12 items-center gap-2 border-b border-border px-4 py-2 text-sm">
      <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-semibold">{identifier ?? "PAP"}</span>
      <span className="text-muted-foreground/60">&rsaquo;</span>
      {editing ? (
        <input
          autoFocus
          aria-label="Task title"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => onCommit(draft)}
          onKeyDown={(event) => {
            if (event.key === "Enter") onCommit(draft);
            if (event.key === "Escape") onCommit(title);
          }}
          className="min-w-0 flex-1 rounded border border-border bg-transparent px-1.5 py-0.5 font-medium outline-none focus:border-ring"
        />
      ) : title ? (
        <button
          type="button"
          onClick={onEdit}
          className="group flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-left font-medium hover:bg-accent"
          title={suggested ? `Title suggested by ${JEV_NAME}. Click to edit.` : "Click to edit"}
        >
          {suggested ? <Sparkles aria-label={`Suggested by ${JEV_NAME}`} className="size-3.5 shrink-0 text-primary" /> : null}
          <span className="truncate">{title}</span>
          <Pencil aria-hidden className="size-3 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100" />
        </button>
      ) : thinking ? (
        <span className="flex items-center gap-2 text-muted-foreground">
          <span className="h-3 w-40 animate-pulse rounded bg-muted" />
          <span className="sr-only">{JEV_NAME} is naming this task</span>
        </span>
      ) : (
        <span className="text-muted-foreground">{identifier ? "Untitled task" : "New task"}</span>
      )}
      {onReset && !editing ? (
        <Button variant="ghost" size="icon-xs" className="text-muted-foreground" onClick={onReset} title={`Use ${JEV_NAME}'s title`}>
          <Undo2 />
        </Button>
      ) : null}
    </div>
  );
}

function CreatedBody({ prompt }: { prompt: string }) {
  return (
    <div className="flex flex-col gap-3 px-4 pt-4 pb-2">
      <p className="self-end whitespace-pre-wrap rounded-xl bg-muted px-4 py-3 text-sm">{prompt}</p>
    </div>
  );
}

type Effective = {
  title: string;
  type: JevTaskType | null;
  assigneeId: string | null;
  projectId: string | null;
  workMode: IssueWorkMode;
};

function JevPanel({
  flow,
  created,
  status,
  promptLength,
  suggestion,
  effective,
  isSuggested,
  setField,
  resetField,
  whyOpen,
  onToggleWhy,
  onRetry,
}: {
  flow: "suggest-first" | "instant";
  created: boolean;
  status: JevStatus;
  promptLength: number;
  suggestion: JevSuggestion | null;
  effective: Effective;
  isSuggested: (field: Field) => boolean;
  setField: <K extends keyof Overrides>(field: K, value: Overrides[K]) => void;
  resetField: (field: Field) => void;
  whyOpen: boolean;
  onToggleWhy: () => void;
  onRetry: () => void;
}) {
  const statusLine = (() => {
    if (status === "error") return null;
    if (status === "thinking") return created ? `${JEV_NAME} is naming and routing this task…` : `${JEV_NAME} is reading your request…`;
    if (status === "ready" && suggestion) {
      return suggestion.confidence === "low" ? `${JEV_NAME} isn't sure who should own this. Pick one:` : null;
    }
    if (flow === "instant" && !created) return `${JEV_NAME} picks a title, type, and owner after you start. You can change anything later.`;
    if (promptLength > 0 && promptLength < JEV_MIN_PROMPT_LENGTH) return `Keep going. ${JEV_NAME} suggests details once there's a bit more to go on.`;
    return null;
  })();

  const showChips = status !== "idle" || flow === "suggest-first";
  const loading = status === "thinking" && !suggestion;
  const assignee = JEV_AGENTS.find((agent) => agent.id === effective.assigneeId) ?? null;
  const alternates = (suggestion?.alternateAssigneeIds ?? [])
    .map((id) => JEV_AGENTS.find((agent) => agent.id === id))
    .filter((agent): agent is (typeof JEV_AGENTS)[number] => Boolean(agent) && agent!.id !== effective.assigneeId);

  return (
    <div className="flex flex-col gap-2 px-4 pb-3">
      {status === "error" ? (
        <div role="status" className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <AlertTriangle aria-hidden className="size-3.5 shrink-0" />
          <span className="flex-1">{JEV_NAME} couldn't classify this. Set the owner yourself, or try again.</span>
          <Button variant="ghost" size="xs" onClick={onRetry}>Try again</Button>
        </div>
      ) : statusLine ? (
        <div role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
          <JevMark thinking={status === "thinking"} />
          <span>{statusLine}</span>
        </div>
      ) : null}

      {showChips ? (
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <PropertyChip
            label="Type"
            loading={loading}
            suggested={isSuggested("type")}
            onReset={suggestion && !isSuggested("type") ? () => resetField("type") : undefined}
            display={effective.type ? (
              <><Tag aria-hidden className="size-3.5" />{JEV_TASK_TYPES.find((option) => option.value === effective.type)?.label}</>
            ) : <><Tag aria-hidden className="size-3.5" />Type</>}
          >
            {(close) => JEV_TASK_TYPES.map((option) => (
              <MenuItem key={option.value} selected={option.value === effective.type} onClick={() => { setField("type", option.value); close(); }}>
                <span className="flex flex-col">
                  <span>{option.label}</span>
                  <span className="text-xs text-muted-foreground">{option.hint}</span>
                </span>
              </MenuItem>
            ))}
          </PropertyChip>

          <PropertyChip
            label="Assignee"
            loading={loading}
            suggested={isSuggested("assigneeId")}
            onReset={suggestion && !isSuggested("assigneeId") ? () => resetField("assigneeId") : undefined}
            display={assignee ? (
              <><AgentAvatar agent={assignee} size={16} />{assignee.name}</>
            ) : <span>Assignee</span>}
          >
            {(close) => JEV_AGENTS.map((agent) => (
              <MenuItem key={agent.id} selected={agent.id === effective.assigneeId} onClick={() => { setField("assigneeId", agent.id); close(); }}>
                <AgentAvatar agent={agent} size={20} />
                <span className="flex flex-col">
                  <span>{agent.name}</span>
                  <span className="text-xs text-muted-foreground">{agent.title}</span>
                </span>
              </MenuItem>
            ))}
          </PropertyChip>

          <PropertyChip
            label="Project"
            loading={loading}
            suggested={isSuggested("projectId") && effective.projectId !== null}
            onReset={suggestion && !isSuggested("projectId") ? () => resetField("projectId") : undefined}
            display={<><FolderKanban aria-hidden className="size-3.5" />{JEV_PROJECTS.find((project) => project.id === effective.projectId)?.name ?? "No project"}</>}
          >
            {(close) => [
              <MenuItem key="none" selected={effective.projectId === null} onClick={() => { setField("projectId", null); close(); }}>No project</MenuItem>,
              ...JEV_PROJECTS.map((project) => (
                <MenuItem key={project.id} selected={project.id === effective.projectId} onClick={() => { setField("projectId", project.id); close(); }}>
                  {project.name}
                </MenuItem>
              )),
            ]}
          </PropertyChip>

          <WorkModeChip
            loading={loading}
            mode={effective.workMode}
            suggested={isSuggested("workMode") && effective.workMode !== "standard"}
            onChange={(mode) => setField("workMode", mode)}
          />
        </div>
      ) : null}

      {status === "ready" && suggestion?.confidence === "low" && alternates.length > 0 && isSuggested("assigneeId") ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-foreground">Or:</span>
          {alternates.map((agent) => (
            <Button key={agent.id} variant="outline" size="xs" onClick={() => setField("assigneeId", agent.id)}>
              <AgentAvatar agent={agent} size={16} />{agent.name}
            </Button>
          ))}
        </div>
      ) : null}

      {status === "ready" && suggestion ? (
        <div className="text-xs text-muted-foreground">
          <button type="button" onClick={onToggleWhy} aria-expanded={whyOpen} className="inline-flex items-center gap-1 hover:text-foreground">
            <ChevronDown aria-hidden className={cn("size-3 transition-transform", !whyOpen && "-rotate-90")} />
            Why {JEV_NAME} chose these
          </button>
          {whyOpen ? (
            <ul className="mt-1.5 flex flex-col gap-1 pl-4">
              {suggestion.reasons.map((reason) => <li key={reason.field}>{reason.text}</li>)}
              <li>Anything you change stays as you set it.</li>
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function PropertyChip({
  label,
  display,
  loading,
  suggested,
  onReset,
  children,
}: {
  label: string;
  display: ReactNode;
  loading: boolean;
  suggested: boolean;
  onReset?: () => void;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  if (loading) {
    return <span aria-label={`${label} loading`} className="h-7 w-24 animate-pulse rounded-md border border-border bg-muted/60" />;
  }
  return (
    <span className="inline-flex items-center">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`${label}${suggested ? ` (suggested by ${JEV_NAME})` : ""}`}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-sm transition-colors hover:bg-accent hover:text-foreground",
              suggested ? "border-primary/40 bg-primary/5 text-foreground" : "border-border text-foreground",
            )}
          >
            {suggested ? <Sparkles aria-hidden className="size-3 text-primary" /> : null}
            {display}
            <ChevronDown aria-hidden className="size-3 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 p-1">
          {children(() => setOpen(false))}
        </PopoverContent>
      </Popover>
      {onReset ? (
        <Button variant="ghost" size="icon-xs" className="text-muted-foreground" onClick={onReset} title={`Use ${JEV_NAME}'s suggestion`}>
          <Undo2 />
        </Button>
      ) : null}
    </span>
  );
}

function MenuItem({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn("flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent", selected && "bg-accent")}
    >
      {children}
      {selected ? <Check aria-hidden className="ml-auto size-3.5 shrink-0" /> : null}
    </button>
  );
}

function WorkModeChip({
  mode,
  loading,
  suggested,
  onChange,
}: {
  mode: IssueWorkMode;
  loading: boolean;
  suggested: boolean;
  onChange: (mode: IssueWorkMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const meta = workModeMetaFor(mode);
  const Icon = meta.icon;
  if (loading) return <span aria-label="Mode loading" className="h-7 w-20 animate-pulse rounded-md border border-border bg-muted/60" />;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Mode${suggested ? ` (suggested by ${JEV_NAME})` : ""}`}
          className={cn("inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-sm transition-colors", meta.classes.chip)}
        >
          {suggested ? <Sparkles aria-hidden className="size-3" /> : null}
          <Icon aria-hidden className="size-3.5" />
          {meta.label}
          <ChevronDown aria-hidden className="size-3 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-48 p-1">
        {workModeMetaList().map((option) => {
          const OptionIcon = option.icon;
          return (
            <MenuItem key={option.value} selected={option.value === mode} onClick={() => { onChange(option.value); setOpen(false); }}>
              <OptionIcon aria-hidden className={cn("size-3.5", option.classes.menuItem)} />
              {option.label}
            </MenuItem>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}

