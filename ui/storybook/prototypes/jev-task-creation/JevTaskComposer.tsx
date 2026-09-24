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
  JEV_CONFIDENCE_THRESHOLD,
  JEV_MIN_PROMPT_LENGTH,
  JEV_MODEL,
  JEV_NAME,
  JEV_NO_PROJECT,
  JEV_PROJECTS,
  JEV_TASK_TYPES,
  buildJevDecisionRequest,
  draftTaskTitle,
  routeTaskWithJev,
  type JevField,
  type JevRouting,
  type JevTaskType,
} from "./jev-classifier";

export type JevTaskComposerProps = {
  /**
   * `suggest-first`: Jev routes and a title is drafted while you type; you review and create.
   * `instant`: like starting a Claude Code session. Create right away; the task opens as
   * "Untitled" and is named and routed a moment later.
   */
  flow?: "suggest-first" | "instant";
  initialPrompt?: string;
  /** Simulated Jev decision latency. Jev is a fast decision model. */
  latencyMs?: number;
  /** Simulated latency of the separate text model that drafts the title. */
  titleLatencyMs?: number;
  /** Simulate Jev being unavailable; routing falls back to manual fields. */
  jevUnavailable?: boolean;
  /** Pre-set the assignee as if the user already chose it. Jev never overwrites it. */
  presetAssigneeId?: string;
  /** Types `initialPrompt` in character by character to show suggestions arriving. */
  typeOnMount?: boolean;
  mobile?: boolean;
};

type Overrides = Partial<{ title: string; type: JevTaskType; assignee: string; project: string | null; workMode: IssueWorkMode }>;
type OverrideField = keyof Overrides;
type Status = "idle" | "thinking" | "ready" | "error";

const TYPING_DEBOUNCE_MS = 650;

const percent = (value: number | undefined) => (value === undefined ? "" : `${Math.round(value * 100)}%`);

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
  latencyMs = 350,
  titleLatencyMs = 1200,
  jevUnavailable = false,
  presetAssigneeId,
  typeOnMount = false,
  mobile = false,
}: JevTaskComposerProps) {
  const [prompt, setPrompt] = useState(typeOnMount ? "" : initialPrompt);
  const [routingStatus, setRoutingStatus] = useState<Status>("idle");
  const [routing, setRouting] = useState<JevRouting | null>(null);
  const [titleStatus, setTitleStatus] = useState<Status>("idle");
  const [suggestedTitle, setSuggestedTitle] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<Overrides>(presetAssigneeId ? { assignee: presetAssigneeId } : {});
  const [editingTitle, setEditingTitle] = useState(false);
  const [createdIdentifier, setCreatedIdentifier] = useState<string | null>(null);
  const [createdPrompt, setCreatedPrompt] = useState("");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const lastRequestedRef = useRef("");

  // Autoplay: type the scenario prompt so reviewers see suggestions react mid-sentence.
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

  const suggest = useCallback((text: string) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    lastRequestedRef.current = text;
    const ignoreAbort = (error: unknown) => error instanceof DOMException && error.name === "AbortError";

    setRoutingStatus("thinking");
    routeTaskWithJev(text, { latencyMs, fail: jevUnavailable, signal: controller.signal })
      .then((result) => { setRouting(result); setRoutingStatus("ready"); })
      .catch((error: unknown) => { if (!ignoreAbort(error)) setRoutingStatus("error"); });

    setTitleStatus("thinking");
    draftTaskTitle(text, { latencyMs: titleLatencyMs, signal: controller.signal })
      .then((title) => { setSuggestedTitle(title); setTitleStatus("ready"); })
      .catch((error: unknown) => { if (!ignoreAbort(error)) setTitleStatus("error"); });
  }, [latencyMs, titleLatencyMs, jevUnavailable]);

  // Suggest-first: re-run after the user pauses typing.
  useEffect(() => {
    if (flow !== "suggest-first" || createdIdentifier) return;
    const text = prompt.trim();
    if (text.length < JEV_MIN_PROMPT_LENGTH) {
      abortRef.current?.abort();
      lastRequestedRef.current = "";
      setRoutingStatus("idle");
      setTitleStatus("idle");
      setRouting(null);
      setSuggestedTitle(null);
      return;
    }
    if (text === lastRequestedRef.current) return;
    const timer = window.setTimeout(() => suggest(text), TYPING_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [prompt, flow, createdIdentifier, suggest]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const effective = useMemo(() => ({
    title: overrides.title ?? suggestedTitle ?? "",
    type: overrides.type ?? routing?.type ?? null,
    assignee: overrides.assignee ?? routing?.assigneeId ?? null,
    project: overrides.project !== undefined ? overrides.project : routing?.projectId ?? null,
    workMode: overrides.workMode ?? routing?.workMode ?? "standard",
  }), [overrides, routing, suggestedTitle]);

  const fromJev = (field: Exclude<OverrideField, "title">) => routing !== null && overrides[field] === undefined;
  const setField = <K extends OverrideField>(field: K, value: Overrides[K]) =>
    setOverrides((current) => ({ ...current, [field]: value }));
  const resetField = (field: OverrideField) =>
    setOverrides((current) => {
      const next = { ...current };
      delete next[field];
      return next;
    });

  const canCreate = prompt.trim().length > 0;
  const create = () => {
    if (!canCreate) return;
    const text = prompt.trim();
    setCreatedIdentifier("PAP-412");
    setCreatedPrompt(text);
    // Creating never waits. Anything not yet suggested for this exact prompt runs now.
    if (lastRequestedRef.current !== text || routingStatus === "idle") suggest(text);
  };
  const startOver = () => {
    abortRef.current?.abort();
    lastRequestedRef.current = "";
    setPrompt("");
    setRouting(null);
    setSuggestedTitle(null);
    setOverrides({});
    setRoutingStatus("idle");
    setTitleStatus("idle");
    setCreatedIdentifier(null);
    setDetailsOpen(false);
  };

  const titleSuggested = suggestedTitle !== null && overrides.title === undefined;
  const animatedTitle = useTypewriter(titleSuggested ? suggestedTitle : null);
  const created = createdIdentifier !== null;
  const busy = routingStatus === "thinking" || titleStatus === "thinking";

  return (
    <div className={cn("flex min-h-screen w-full items-start justify-center bg-background p-4 sm:p-10", mobile && "p-0 sm:p-0")}>
      <div
        className={cn(
          "flex w-full flex-col overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-lg",
          mobile ? "min-h-screen max-w-sm rounded-none border-0" : "max-w-2xl",
        )}
      >
        <ComposerHeader
          identifier={createdIdentifier ?? undefined}
          title={titleSuggested ? animatedTitle : effective.title}
          thinking={titleStatus === "thinking" && !effective.title}
          suggested={titleSuggested}
          editing={editingTitle}
          onEdit={() => setEditingTitle(true)}
          onCommit={(value) => {
            setEditingTitle(false);
            if (value.trim() && value.trim() !== effective.title) setField("title", value.trim());
          }}
          onReset={overrides.title !== undefined && suggestedTitle ? () => resetField("title") : undefined}
        />

        {created ? (
          <div className="flex flex-col gap-3 px-4 pt-4 pb-2">
            <p className="self-end whitespace-pre-wrap rounded-xl bg-muted px-4 py-3 text-sm">{createdPrompt}</p>
          </div>
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
                ? "What should get done? It gets a title and an owner once you start."
                : "What should get done? A title, type, and owner are suggested as you write."}
              className="min-h-36 resize-none border-0 bg-transparent px-0 text-base shadow-none focus-visible:ring-0 dark:bg-transparent"
            />
          </div>
        )}

        <RoutingPanel
          flow={flow}
          created={created}
          status={routingStatus}
          promptLength={prompt.trim().length}
          prompt={createdPrompt || prompt.trim()}
          routing={routing}
          effective={effective}
          fromJev={fromJev}
          setField={setField}
          resetField={resetField}
          detailsOpen={detailsOpen}
          onToggleDetails={() => setDetailsOpen((open) => !open)}
          onRetry={() => suggest(prompt.trim() || createdPrompt)}
        />

        <div className="mt-auto flex items-center justify-between gap-3 border-t border-border px-4 py-3">
          {created ? (
            <>
              <Button variant="ghost" size="sm" onClick={startOver}>
                <RotateCcw /> New task
              </Button>
              <span className="text-xs text-muted-foreground">
                {busy ? "Naming and routing this task…" : routingStatus === "ready" ? "Task created and assigned." : "Task created."}
              </span>
            </>
          ) : (
            <>
              <Button variant="ghost" size="sm" onClick={startOver} disabled={!prompt}>
                Cancel
              </Button>
              <div className="flex items-center gap-3">
                {flow === "suggest-first" && busy ? (
                  <span className="hidden text-xs text-muted-foreground sm:inline">You can create now; suggestions finish after.</span>
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

function JevMark({ thinking = false }: { thinking?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary",
        thinking && "animate-pulse",
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
          title={suggested ? "Suggested title. Click to edit." : "Click to edit"}
        >
          {suggested ? <Sparkles aria-label="Suggested" className="size-3.5 shrink-0 text-primary" /> : null}
          <span className="truncate">{title}</span>
          <Pencil aria-hidden className="size-3 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100" />
        </button>
      ) : thinking ? (
        <span className="flex items-center gap-2 text-muted-foreground">
          <span className="h-3 w-40 animate-pulse rounded bg-muted" />
          <span className="sr-only">Naming this task</span>
        </span>
      ) : (
        <span className="text-muted-foreground">{identifier ? "Untitled task" : "New task"}</span>
      )}
      {onReset && !editing ? (
        <Button variant="ghost" size="icon-xs" className="text-muted-foreground" onClick={onReset} title="Use the suggested title">
          <Undo2 />
        </Button>
      ) : null}
    </div>
  );
}

type Effective = {
  title: string;
  type: JevTaskType | null;
  assignee: string | null;
  project: string | null;
  workMode: IssueWorkMode;
};

function RoutingPanel({
  flow,
  created,
  status,
  promptLength,
  prompt,
  routing,
  effective,
  fromJev,
  setField,
  resetField,
  detailsOpen,
  onToggleDetails,
  onRetry,
}: {
  flow: "suggest-first" | "instant";
  created: boolean;
  status: Status;
  promptLength: number;
  prompt: string;
  routing: JevRouting | null;
  effective: Effective;
  fromJev: (field: Exclude<OverrideField, "title">) => boolean;
  setField: <K extends OverrideField>(field: K, value: Overrides[K]) => void;
  resetField: (field: OverrideField) => void;
  detailsOpen: boolean;
  onToggleDetails: () => void;
  onRetry: () => void;
}) {
  const unsureOwner = routing !== null && fromJev("assignee") && routing.confidence.assignee < JEV_CONFIDENCE_THRESHOLD;

  const statusLine = (() => {
    if (status === "thinking" && !routing) return created ? `${JEV_NAME} is routing this task…` : `${JEV_NAME} is reading your request…`;
    if (unsureOwner) return `${JEV_NAME} is ${percent(routing!.confidence.assignee)} sure about the owner. Pick one:`;
    if (status === "idle" && flow === "instant" && !created) return `${JEV_NAME} picks the type and owner after you start. You can change anything later.`;
    if (status === "idle" && promptLength > 0 && promptLength < JEV_MIN_PROMPT_LENGTH) return "Keep going. Suggestions start once there's a bit more to go on.";
    return null;
  })();

  const showChips = status !== "idle" || flow === "suggest-first";
  const loading = status === "thinking" && !routing;
  const probabilities = routing?.probabilities;
  const assignee = JEV_AGENTS.find((agent) => agent.id === effective.assignee) ?? null;
  const alternates = (routing?.alternateAssigneeIds ?? [])
    .map((id) => JEV_AGENTS.find((agent) => agent.id === id))
    .filter((agent): agent is (typeof JEV_AGENTS)[number] => agent !== undefined && agent.id !== effective.assignee);
  const resetFor = (field: Exclude<OverrideField, "title">) => (routing && !fromJev(field) ? () => resetField(field) : undefined);

  return (
    <div className="flex flex-col gap-2 px-4 pb-3">
      {status === "error" ? (
        <div role="status" className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <AlertTriangle aria-hidden className="size-3.5 shrink-0" />
          <span className="flex-1">{JEV_NAME} couldn't route this. Set the owner yourself, or try again.</span>
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
            suggested={fromJev("type")}
            onReset={resetFor("type")}
            display={<><Tag aria-hidden className="size-3.5" />{JEV_TASK_TYPES.find((option) => option.value === effective.type)?.label ?? "Type"}</>}
          >
            {(close) => JEV_TASK_TYPES.map((option) => (
              <MenuItem
                key={option.value}
                selected={option.value === effective.type}
                probability={probabilities?.type[option.value]}
                onClick={() => { setField("type", option.value); close(); }}
              >
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
            suggested={fromJev("assignee")}
            onReset={resetFor("assignee")}
            display={assignee ? <><AgentAvatar agent={assignee} size={16} />{assignee.name}</> : <span>Assignee</span>}
          >
            {(close) => JEV_AGENTS.map((agent) => (
              <MenuItem
                key={agent.id}
                selected={agent.id === effective.assignee}
                probability={probabilities?.assignee[agent.id]}
                onClick={() => { setField("assignee", agent.id); close(); }}
              >
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
            suggested={fromJev("project") && effective.project !== null}
            onReset={resetFor("project")}
            display={<><FolderKanban aria-hidden className="size-3.5" />{JEV_PROJECTS.find((project) => project.id === effective.project)?.name ?? "No project"}</>}
          >
            {(close) => [
              ...JEV_PROJECTS.map((project) => (
                <MenuItem
                  key={project.id}
                  selected={project.id === effective.project}
                  probability={probabilities?.project[project.id]}
                  onClick={() => { setField("project", project.id); close(); }}
                >
                  {project.name}
                </MenuItem>
              )),
              <MenuItem
                key="none"
                selected={effective.project === null}
                probability={probabilities?.project[JEV_NO_PROJECT]}
                onClick={() => { setField("project", null); close(); }}
              >
                No project
              </MenuItem>,
            ]}
          </PropertyChip>

          <WorkModeChip
            loading={loading}
            mode={effective.workMode}
            suggested={fromJev("workMode") && effective.workMode !== "standard"}
            probabilities={probabilities?.workMode}
            onChange={(mode) => setField("workMode", mode)}
          />
        </div>
      ) : null}

      {unsureOwner && alternates.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-foreground">Or:</span>
          {alternates.map((agent) => (
            <Button key={agent.id} variant="outline" size="xs" onClick={() => setField("assignee", agent.id)}>
              <AgentAvatar agent={agent} size={16} />{agent.name}
              <span className="text-muted-foreground">{percent(probabilities?.assignee[agent.id])}</span>
            </Button>
          ))}
        </div>
      ) : null}

      {routing ? (
        <div className="text-xs text-muted-foreground">
          <button type="button" onClick={onToggleDetails} aria-expanded={detailsOpen} className="inline-flex items-center gap-1 hover:text-foreground">
            <ChevronDown aria-hidden className={cn("size-3 transition-transform", !detailsOpen && "-rotate-90")} />
            How sure {JEV_NAME} is
          </button>
          {detailsOpen ? <ConfidenceDetails routing={routing} prompt={prompt} /> : null}
        </div>
      ) : null}
    </div>
  );
}

const FIELD_LABELS: Record<JevField, string> = { type: "Type", assignee: "Assignee", project: "Project", workMode: "Mode" };

function choiceLabel(field: JevField, routing: JevRouting): string {
  if (field === "type") return JEV_TASK_TYPES.find((option) => option.value === routing.type)?.label ?? routing.type;
  if (field === "assignee") return JEV_AGENTS.find((agent) => agent.id === routing.assigneeId)?.name ?? routing.assigneeId;
  if (field === "project") return JEV_PROJECTS.find((project) => project.id === routing.projectId)?.name ?? "No project";
  return workModeMetaFor(routing.workMode).label;
}

function ConfidenceDetails({ routing, prompt }: { routing: JevRouting; prompt: string }) {
  const fields: JevField[] = ["type", "assignee", "project", "workMode"];
  return (
    <div className="mt-2 flex flex-col gap-2 pl-4">
      <dl className="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-1.5">
        {fields.map((field) => {
          const confidence = routing.confidence[field];
          return (
            <div key={field} className="contents">
              <dt>{FIELD_LABELS[field]}</dt>
              <dd className="flex items-center gap-2 text-foreground">
                <span className="truncate">{choiceLabel(field, routing)}</span>
                <span className="h-1 w-16 shrink-0 overflow-hidden rounded-full bg-muted" aria-hidden>
                  <span
                    className={cn("block h-full rounded-full", confidence < JEV_CONFIDENCE_THRESHOLD ? "bg-muted-foreground" : "bg-primary")}
                    style={{ width: percent(confidence) }}
                  />
                </span>
              </dd>
              <dd className="tabular-nums">{percent(confidence)}</dd>
            </div>
          );
        })}
      </dl>
      <p>
        {JEV_MODEL} returns a choice and probabilities, not reasons. Open a chip to see every option's probability.
        Anything you change stays as you set it.
      </p>
      <p className="tabular-nums">
        {routing.usage.input_tokens} input tokens · ${routing.usage.cost.toFixed(6)} · output tokens are free
      </p>
      <details>
        <summary className="cursor-pointer hover:text-foreground">Request sent to {JEV_NAME}</summary>
        <pre className="mt-1 max-h-64 overflow-auto rounded-md bg-muted p-2 font-mono text-xs text-foreground">
          {`POST https://openrouter.ai/api/alpha/decisions\n${JSON.stringify(buildJevDecisionRequest(prompt), null, 2)}`}
        </pre>
      </details>
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
              "inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-sm text-foreground transition-colors hover:bg-accent",
              suggested ? "border-primary/40 bg-primary/5" : "border-border",
            )}
          >
            {suggested ? <Sparkles aria-hidden className="size-3 text-primary" /> : null}
            {display}
            <ChevronDown aria-hidden className="size-3 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 p-1">
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

function MenuItem({
  selected,
  probability,
  onClick,
  children,
}: {
  selected: boolean;
  probability?: number;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn("flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent", selected && "bg-accent")}
    >
      {children}
      <span className="ml-auto flex shrink-0 items-center gap-2">
        {probability !== undefined ? <span className="text-xs tabular-nums text-muted-foreground">{percent(probability)}</span> : null}
        {selected ? <Check aria-hidden className="size-3.5" /> : <span className="size-3.5" />}
      </span>
    </button>
  );
}

function WorkModeChip({
  mode,
  loading,
  suggested,
  probabilities,
  onChange,
}: {
  mode: IssueWorkMode;
  loading: boolean;
  suggested: boolean;
  probabilities?: Record<string, number>;
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
      <PopoverContent align="start" className="w-56 p-1">
        {workModeMetaList().map((option) => {
          const OptionIcon = option.icon;
          return (
            <MenuItem
              key={option.value}
              selected={option.value === mode}
              probability={probabilities?.[option.value]}
              onClick={() => { onChange(option.value); setOpen(false); }}
            >
              <OptionIcon aria-hidden className={cn("size-3.5", option.classes.menuItem)} />
              {option.label}
            </MenuItem>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}
