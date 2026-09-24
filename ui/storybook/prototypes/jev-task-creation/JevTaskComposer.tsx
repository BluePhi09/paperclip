import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { IssueWorkMode } from "@paperclipai/shared";
import { Check, ChevronDown, FolderKanban, Maximize2, Minimize2, Sparkles, Undo2, X } from "lucide-react";
import { AgentAvatar } from "@/components/AgentAvatar";
import { InlineBanner } from "@/components/InlineBanner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { workModeMetaFor, workModeMetaList } from "@/lib/work-mode-meta";
import {
  JEV_AGENTS,
  JEV_CONFIDENCE_THRESHOLD,
  JEV_MIN_PROMPT_LENGTH,
  JEV_MODEL,
  JEV_NAME,
  JEV_PROJECTS,
  TITLE_MODEL,
  agentContextCoverage,
  buildJevDecisionRequest,
  draftTaskTitle,
  routeTaskWithJev,
  stabilizeRouting,
  type JevAgent,
  type JevField,
  type JevRouting,
  type ModelUsage,
} from "./jev-classifier";

export type JevTaskComposerProps = {
  /**
   * Both flows update mode and owner live while you type. The title is drafted
   * once, when the task is started (Start task or Enter), like Claude Code
   * naming a session after the first message.
   * `suggest-first`: review the live suggestions, then create.
   * `instant`: start any time; whatever Jev has suggested so far is used, and
   * anything still pending finishes after.
   */
  flow?: "suggest-first" | "instant";
  /** `dialog` renders the real modal. `inline` renders the same surface in the page flow, for review pages. */
  presentation?: "dialog" | "inline";
  initialPrompt?: string;
  /** Simulated Jev decision latency. Jev is a fast decision model. */
  latencyMs?: number;
  /** Simulated latency of the separate text model that drafts the title. */
  titleLatencyMs?: number;
  /** Pause after a keystroke before Jev re-routes. Jev is cheap, so this can be short. */
  liveDebounceMs?: number;
  /** During continuous typing, re-route at least this often. */
  liveMaxWaitMs?: number;
  /** Simulate Jev being unavailable; routing falls back to manual fields. */
  jevUnavailable?: boolean;
  /** Pre-set the assignee as if the user already chose it. Jev never overwrites it. */
  presetAssigneeId?: string;
  /** Agents to treat as paused. Jev never routes to them and the fallback skips them. */
  pausedAgentIds?: string[];
  /** Types `initialPrompt` in character by character to show suggestions arriving. */
  typeOnMount?: boolean;
};

type Overrides = Partial<{ title: string; workMode: IssueWorkMode; assignee: string; project: string | null }>;
type OverrideField = keyof Overrides;
type RoutedField = Exclude<OverrideField, "title" | "project">;
type Status = "idle" | "thinking" | "ready" | "error";
type LiveStats = { calls: number; inputTokens: number; cost: number };

const EMPTY_STATS: LiveStats = { calls: 0, inputTokens: 0, cost: 0 };

const FLASH_MS = 900;
/** Explanatory notes (like the fallback owner) wait for a pause in typing, so they don't flicker mid-sentence. */
const SETTLE_MS = 1000;
const CREATED_IDENTIFIER = "PAP-412";

/** Shipped `NewIssueDialog` compact property control, so chips match the product exactly. */
const COMPACT_CONTROL =
  "inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 py-0 text-xs transition-colors sm:h-auto sm:px-2 sm:py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
/** A changed value briefly takes the accent fill; timing comes from the motion tokens. */
const CHANGE_TRANSITION = "duration-(--motion-duration-slow) ease-(--motion-ease-standard)";

/** Radix `DialogTitle` only works inside a `Dialog`; the inline presentation renders a plain heading instead. */
const InDialogContext = createContext(false);

const percent = (value: number | undefined) => (value === undefined ? "" : `${Math.round(value * 100)}%`);
const isAbort = (error: unknown) => error instanceof DOMException && error.name === "AbortError";

/** Debounce with a ceiling: wait for a pause, but never longer than `maxWaitMs` since the first pending change. */
function throttledDelay(pendingSince: { current: number | null }, debounceMs: number, maxWaitMs: number) {
  if (pendingSince.current === null) pendingSince.current = Date.now();
  return Math.max(0, Math.min(debounceMs, maxWaitMs - (Date.now() - pendingSince.current)));
}

function commonPrefixLength(a: string, b: string) {
  let index = 0;
  while (index < a.length && index < b.length && a[index] === b[index]) index += 1;
  return index;
}

/** Types a suggested title in, like a session title arriving. A redraft only retypes the part that changed. */
function useTypewriter(target: string | null) {
  const [shown, setShown] = useState("");
  const shownRef = useRef("");
  useEffect(() => {
    if (!target) {
      shownRef.current = "";
      return setShown("");
    }
    let index = commonPrefixLength(shownRef.current, target);
    const step = () => {
      shownRef.current = target.slice(0, index);
      setShown(shownRef.current);
    };
    step();
    if (index >= target.length) return;
    const timer = window.setInterval(() => {
      index += 1;
      step();
      if (index >= target.length) window.clearInterval(timer);
    }, 22);
    return () => window.clearInterval(timer);
  }, [target]);
  return shown;
}

export function JevTaskComposer({
  flow = "suggest-first",
  presentation = "dialog",
  initialPrompt = "",
  latencyMs = 350,
  titleLatencyMs = 1200,
  liveDebounceMs = 250,
  liveMaxWaitMs = 800,
  jevUnavailable = false,
  presetAssigneeId,
  pausedAgentIds,
  typeOnMount = false,
}: JevTaskComposerProps) {
  const pausedKey = (pausedAgentIds ?? []).join(",");
  const agents = useMemo(
    () => JEV_AGENTS.map((agent) => (pausedKey.split(",").includes(agent.id) ? { ...agent, paused: true } : agent)),
    [pausedKey],
  );
  const [prompt, setPrompt] = useState(typeOnMount ? "" : initialPrompt);
  const [routingStatus, setRoutingStatus] = useState<Status>("idle");
  const [routing, setRouting] = useState<JevRouting | null>(null);
  const [titleStatus, setTitleStatus] = useState<Status>("idle");
  const [suggestedTitle, setSuggestedTitle] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<Overrides>(presetAssigneeId ? { assignee: presetAssigneeId } : {});
  const [createdPrompt, setCreatedPrompt] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [flash, setFlash] = useState<Partial<Record<JevField, boolean>>>({});
  const [liveStats, setLiveStats] = useState<LiveStats>(EMPTY_STATS);
  const [titleUsage, setTitleUsage] = useState<ModelUsage | null>(null);
  const [settled, setSettled] = useState(true);
  const routingRef = useRef<JevRouting | null>(null);
  const routingAbortRef = useRef<AbortController | null>(null);
  const titleAbortRef = useRef<AbortController | null>(null);
  const lastRoutedRef = useRef("");
  const flashTimerRef = useRef<number | undefined>(undefined);
  const routingPendingSinceRef = useRef<number | null>(null);

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

  const runRouting = useCallback((text: string) => {
    routingAbortRef.current?.abort();
    const controller = new AbortController();
    routingAbortRef.current = controller;
    routingPendingSinceRef.current = null;
    lastRoutedRef.current = text;
    setRoutingStatus("thinking");
    routeTaskWithJev(text, { latencyMs, fail: jevUnavailable, signal: controller.signal, agents })
      .then((result) => {
        const previous = routingRef.current;
        const next = stabilizeRouting(previous, result);
        // Highlight only fields whose value actually changed, so the eye goes to what moved.
        const changed: Partial<Record<JevField, boolean>> = previous
          ? { workMode: previous.workMode !== next.workMode, assignee: previous.assigneeId !== next.assigneeId }
          : {};
        routingRef.current = next;
        setRouting(next);
        setRoutingStatus("ready");
        setLiveStats((stats) => ({
          calls: stats.calls + 1,
          inputTokens: stats.inputTokens + result.usage.input_tokens,
          cost: stats.cost + result.usage.cost,
        }));
        if (Object.values(changed).some(Boolean)) {
          setFlash(changed);
          window.clearTimeout(flashTimerRef.current);
          flashTimerRef.current = window.setTimeout(() => setFlash({}), FLASH_MS);
        }
      })
      .catch((error: unknown) => { if (!isAbort(error)) setRoutingStatus("error"); });
  }, [latencyMs, jevUnavailable, agents]);

  const runTitle = useCallback((text: string) => {
    titleAbortRef.current?.abort();
    const controller = new AbortController();
    titleAbortRef.current = controller;
    setTitleStatus("thinking");
    draftTaskTitle(text, { latencyMs: titleLatencyMs, signal: controller.signal })
      .then((draft) => { setSuggestedTitle(draft.title); setTitleUsage(draft.usage); setTitleStatus("ready"); })
      .catch((error: unknown) => { if (!isAbort(error)) setTitleStatus("error"); });
  }, [titleLatencyMs]);

  const resetSuggestions = useCallback(() => {
    routingAbortRef.current?.abort();
    titleAbortRef.current?.abort();
    lastRoutedRef.current = "";
    routingPendingSinceRef.current = null;
    routingRef.current = null;
    setRouting(null);
    setSuggestedTitle(null);
    setTitleUsage(null);
    setRoutingStatus("idle");
    setTitleStatus("idle");
    setFlash({});
  }, []);

  const created = createdPrompt !== null;

  // Live routing: re-run shortly after each pause in typing, until the task is created.
  useEffect(() => {
    if (created) return;
    const text = prompt.trim();
    if (text.length < JEV_MIN_PROMPT_LENGTH) {
      if (lastRoutedRef.current) resetSuggestions();
      return;
    }
    if (text === lastRoutedRef.current) return;
    const timer = window.setTimeout(() => runRouting(text), throttledDelay(routingPendingSinceRef, liveDebounceMs, liveMaxWaitMs));
    return () => window.clearTimeout(timer);
  }, [prompt, created, runRouting, resetSuggestions, liveDebounceMs, liveMaxWaitMs]);

  useEffect(() => {
    setSettled(false);
    const timer = window.setTimeout(() => setSettled(true), SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [prompt]);

  useEffect(() => () => {
    routingAbortRef.current?.abort();
    titleAbortRef.current?.abort();
    window.clearTimeout(flashTimerRef.current);
  }, []);

  const effective = useMemo(() => ({
    title: overrides.title ?? suggestedTitle ?? "",
    assignee: overrides.assignee ?? routing?.assigneeId ?? null,
    // Project is not predicted; it stays a manual choice.
    project: overrides.project ?? null,
    workMode: overrides.workMode ?? routing?.workMode ?? "standard",
  }), [overrides, routing, suggestedTitle]);

  const fromJev = (field: RoutedField) => routing !== null && overrides[field] === undefined;
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
    if (!canCreate || created) return;
    const text = prompt.trim();
    setCreatedPrompt(text);
    // Creating never waits: keep the routing that's shown, bring it up to date if
    // typing got ahead of it, and draft the title now that the prompt is final.
    if (lastRoutedRef.current !== text) runRouting(text);
    runTitle(text);
  };
  const startOver = () => {
    resetSuggestions();
    setPrompt("");
    setOverrides({});
    setCreatedPrompt(null);
    setLiveStats(EMPTY_STATS);
  };

  const titleSuggested = suggestedTitle !== null && overrides.title === undefined;
  const animatedTitle = useTypewriter(titleSuggested ? suggestedTitle : null);
  const routingPending = routingStatus === "thinking";

  const surface = (
    <>
      <ComposerHeader
        identifier={created ? CREATED_IDENTIFIER : null}
        title={titleSuggested ? animatedTitle : effective.title}
        titlePending={created && titleStatus === "thinking" && !effective.title}
        titleSuggested={titleSuggested}
        expanded={expanded}
        onToggleExpanded={() => setExpanded((value) => !value)}
        onRenameTitle={(value) => setField("title", value)}
        onResetTitle={overrides.title !== undefined && suggestedTitle ? () => resetField("title") : undefined}
        onClose={startOver}
      />

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pt-4 pb-3">
        {created ? (
          <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{createdPrompt}</p>
        ) : (
          <PromptField value={prompt} expanded={expanded} onChange={setPrompt} onSubmit={create} />
        )}

        <RoutingRow
          created={created}
          promptLength={prompt.trim().length}
          prompt={createdPrompt ?? prompt.trim()}
          agents={agents}
          status={routingStatus}
          routing={routing}
          effective={effective}
          fromJev={fromJev}
          flash={flash}
          settled={settled || created}
          liveStats={liveStats}
          setField={setField}
          resetField={resetField}
          onRetry={() => runRouting(createdPrompt ?? prompt.trim())}
        />

        {liveStats.calls > 0 || titleUsage ? (
          <TaskCostSummary jev={liveStats} title={titleUsage} titlePending={created && titleStatus === "thinking"} />
        ) : null}
      </div>

      <ComposerFooter
        flow={flow}
        created={created}
        canCreate={canCreate}
        routingPending={routingPending}
        titlePending={titleStatus === "thinking"}
        assigneeName={JEV_AGENTS.find((agent) => agent.id === effective.assignee)?.name ?? null}
        onCancel={startOver}
        onCreate={create}
        onCreateAnother={startOver}
      />
    </>
  );

  const surfaceClasses = cn(
    "flex flex-col gap-0 overflow-hidden p-0",
    expanded ? "sm:max-w-2xl" : "sm:max-w-lg",
  );

  if (presentation === "inline") {
    return (
      <div className={cn("mx-auto w-full rounded-lg border border-border bg-background shadow-lg", surfaceClasses)}>
        {surface}
      </div>
    );
  }
  return (
    <Dialog open onOpenChange={(open) => { if (!open) startOver(); }}>
      <DialogContent showCloseButton={false} aria-describedby={undefined} className={surfaceClasses}>
        <InDialogContext.Provider value>{surface}</InDialogContext.Provider>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Header: breadcrumb that becomes the task's name, like a session title.

function ComposerHeader({
  identifier,
  title,
  titlePending,
  titleSuggested,
  expanded,
  onToggleExpanded,
  onRenameTitle,
  onResetTitle,
  onClose,
}: {
  identifier: string | null;
  title: string;
  titlePending: boolean;
  titleSuggested: boolean;
  expanded: boolean;
  onToggleExpanded: () => void;
  onRenameTitle: (value: string) => void;
  onResetTitle?: () => void;
  onClose: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  useEffect(() => { if (editing) setDraft(title); }, [editing, title]);
  const commit = (value: string) => {
    setEditing(false);
    if (value.trim() && value.trim() !== title) onRenameTitle(value.trim());
  };

  return (
    <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-2.5">
      <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
        <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs font-semibold text-foreground">{identifier ?? "PAP"}</span>
        <span aria-hidden className="text-muted-foreground/60">&rsaquo;</span>
        <DialogTitleSlot>
          {editing ? (
            <input
              autoFocus
              aria-label="Task title"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={() => commit(draft)}
              onKeyDown={(event) => {
                if (event.key === "Enter") commit(draft);
                if (event.key === "Escape") setEditing(false);
              }}
              className="min-w-0 flex-1 rounded border border-border bg-transparent px-1.5 py-0.5 text-sm font-medium text-foreground outline-none focus:border-ring"
            />
          ) : title ? (
            <button
              type="button"
              onClick={() => setEditing(true)}
              title={titleSuggested ? "Suggested title. Click to rename." : "Click to rename"}
              className="flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-left font-medium text-foreground hover:bg-accent/50"
            >
              {titleSuggested ? <Sparkles aria-label="Suggested" className="h-3 w-3 shrink-0 text-muted-foreground" /> : null}
              <span className="truncate">{title}</span>
            </button>
          ) : titlePending ? (
            <>
              <Skeleton className="h-3.5 w-40" />
              <span className="sr-only">Naming this task</span>
            </>
          ) : (
            <span>New task</span>
          )}
        </DialogTitleSlot>
        {onResetTitle && !editing ? (
          <Button variant="ghost" size="icon-xs" className="text-muted-foreground" onClick={onResetTitle} title="Use the suggested title">
            <Undo2 />
          </Button>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="ghost"
          size="icon-xs"
          className="hidden text-muted-foreground sm:inline-flex"
          onClick={onToggleExpanded}
          aria-label={expanded ? "Collapse" : "Expand"}
        >
          {expanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
        </Button>
        <Button variant="ghost" size="icon-xs" className="text-muted-foreground" onClick={onClose} aria-label="Close">
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

/** Gives the dialog an accessible name that tracks the task title, without changing the breadcrumb's look. */
function DialogTitleSlot({ children }: { children: ReactNode }) {
  const inDialog = useContext(InDialogContext);
  const content = <div className="flex min-w-0 items-center gap-1.5 text-sm font-normal leading-normal">{children}</div>;
  if (!inDialog) return <h2 className="contents">{content}</h2>;
  return <DialogTitle asChild>{content}</DialogTitle>;
}

// ---------------------------------------------------------------------------
// Prompt: the hero of the modal. Enter starts the task; Shift+Enter adds a line.

function PromptField({
  value,
  expanded,
  onChange,
  onSubmit,
}: {
  value: string;
  expanded: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  // Grow with the text, like the shipped title field, instead of scrolling inside a fixed box.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, [value, expanded]);

  return (
    <textarea
      ref={ref}
      autoFocus
      rows={expanded ? 8 : 4}
      aria-label="Describe the task"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
          event.preventDefault();
          onSubmit();
        }
      }}
      placeholder="What should get done?"
      className="w-full resize-none overflow-hidden break-words bg-transparent text-base leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/50"
    />
  );
}

// ---------------------------------------------------------------------------
// Routing row: "[Mode] For [Owner] in [Project]", the shipped dialog's sentence shape.

type Effective = { title: string; assignee: string | null; project: string | null; workMode: IssueWorkMode };

function RoutingRow({
  created,
  promptLength,
  prompt,
  agents,
  status,
  routing,
  effective,
  fromJev,
  flash,
  settled,
  liveStats,
  setField,
  resetField,
  onRetry,
}: {
  created: boolean;
  promptLength: number;
  prompt: string;
  agents: JevAgent[];
  status: Status;
  routing: JevRouting | null;
  effective: Effective;
  fromJev: (field: RoutedField) => boolean;
  flash: Partial<Record<JevField, boolean>>;
  settled: boolean;
  liveStats: LiveStats;
  setField: <K extends OverrideField>(field: K, value: Overrides[K]) => void;
  resetField: (field: OverrideField) => void;
  onRetry: () => void;
}) {
  const loading = status === "thinking" && !routing;
  const probabilities = routing?.probabilities;
  const assignee = agents.find((agent) => agent.id === effective.assignee) ?? null;
  const project = JEV_PROJECTS.find((candidate) => candidate.id === effective.project) ?? null;
  const resetFor = (field: RoutedField) => (routing && !fromJev(field) ? () => resetField(field) : undefined);
  // Below the confidence threshold the task goes to the org's fallback owner (see `fallbackAssigneeId`).
  const fallbackOwner = routing?.assigneeSource === "fallback" && fromJev("assignee") ? assignee : null;
  const alternates = (routing?.alternateAssigneeIds ?? [])
    .map((id) => agents.find((agent) => agent.id === id))
    .filter((agent): agent is JevAgent => agent !== undefined && agent.id !== effective.assignee);

  const hint = !created && promptLength === 0
    ? `${JEV_NAME} sets the mode and owner as you type.`
    : !created && promptLength < JEV_MIN_PROMPT_LENGTH
      ? "Keep going. Suggestions start after a few words."
      : null;

  return (
    <div className="flex flex-col gap-2">
      {status === "error" ? (
        <InlineBanner
          tone="warning"
          compact
          actions={<Button variant="outline" size="xs" onClick={onRetry}>Try again</Button>}
        >
          {JEV_NAME} couldn't route this task. Choose the mode and owner, or try again.
        </InlineBanner>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-sm text-muted-foreground">
        {loading ? (
          <>
            <Skeleton className="h-8 w-24 sm:h-6" />
            <span>For</span>
            <Skeleton className="h-8 w-28 sm:h-6" />
          </>
        ) : (
          <>
            <WorkModeControl
              mode={effective.workMode}
              suggested={fromJev("workMode")}
              flash={Boolean(flash.workMode)}
              probabilities={probabilities?.workMode}
              onChange={(mode) => setField("workMode", mode)}
              onReset={resetFor("workMode")}
            />
            <span className="inline-flex items-center gap-2">
            <span>For</span>
            <PickerControl
              label="Owner"
              valueKey={assignee?.id ?? "none"}
              suggested={fromJev("assignee") && !fallbackOwner}
              flash={Boolean(flash.assignee)}
              onReset={resetFor("assignee")}
              display={assignee ? <><AgentAvatar agent={assignee} size={16} />{assignee.name}</> : <span>Choose owner</span>}
            >
              {(close) => agents.map((agent) => (
                <MenuOption
                  key={agent.id}
                  selected={agent.id === effective.assignee}
                  probability={probabilities?.assignee[agent.id]}
                  onSelect={() => { setField("assignee", agent.id); close(); }}
                  leading={<AgentAvatar agent={agent} size={20} />}
                  label={agent.name}
                  detail={[agent.title, agent.paused ? "Paused" : null, agent.id === fallbackOwner?.id ? "Fallback owner" : null].filter(Boolean).join(" · ")}
                />
              ))}
            </PickerControl>
            </span>
          </>
        )}
        <span className="inline-flex items-center gap-2">
        <span>in</span>
        <PickerControl
          label="Project"
          valueKey={project?.id ?? "none"}
          suggested={false}
          flash={false}
          display={<><FolderKanban aria-hidden className="h-3 w-3" />{project?.name ?? "No project"}</>}
        >
          {(close) => [
            ...JEV_PROJECTS.map((candidate) => (
              <MenuOption
                key={candidate.id}
                selected={candidate.id === effective.project}
                onSelect={() => { setField("project", candidate.id); close(); }}
                label={candidate.name}
              />
            )),
            <MenuOption key="none" selected={effective.project === null} onSelect={() => { setField("project", null); close(); }} label="No project" />,
          ]}
        </PickerControl>
        </span>
        {routing ? (
          <JevConfidence
            routing={routing}
            prompt={prompt}
            agents={agents}
            liveStats={liveStats}
            updating={status === "thinking"}
          />
        ) : null}
      </div>

      {fallbackOwner && settled ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span>
            {JEV_NAME} wasn't sure who should own this ({percent(routing!.confidence.assignee)}), so {fallbackOwner.name} has it
            {fallbackOwner.reportsTo === null ? " as the agent who reports to the board." : " as the first agent in your org."}
          </span>
          {alternates.length ? <span>Or:</span> : null}
          {alternates.map((agent) => (
            <Button key={agent.id} variant="ghost" size="xs" onClick={() => setField("assignee", agent.id)}>
              <AgentAvatar agent={agent} size={16} />
              {agent.name}
              <span className="font-mono text-muted-foreground">{percent(probabilities?.assignee[agent.id])}</span>
            </Button>
          ))}
        </div>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

function PickerControl({
  label,
  valueKey,
  display,
  suggested,
  flash,
  onReset,
  children,
}: {
  label: string;
  valueKey: string;
  display: ReactNode;
  suggested: boolean;
  flash: boolean;
  onReset?: () => void;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <span className="inline-flex items-center">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`${label}${suggested ? ` (set by ${JEV_NAME})` : ""}`}
            className={cn(
              COMPACT_CONTROL,
              CHANGE_TRANSITION,
              "border-border font-medium text-foreground hover:bg-accent/50",
              flash ? "bg-accent" : "bg-muted/40",
            )}
          >
            {suggested ? <Sparkles aria-hidden className="h-3 w-3 text-muted-foreground" /> : null}
            <span key={valueKey} className="tc-enter-marker inline-flex items-center gap-1.5">{display}</span>
            <ChevronDown aria-hidden className="h-3 w-3 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 p-1">
          {children(() => setOpen(false))}
        </PopoverContent>
      </Popover>
      {onReset ? (
        <Button variant="ghost" size="icon-xs" className="text-muted-foreground" onClick={onReset} title={`Use ${JEV_NAME}'s choice`}>
          <Undo2 />
        </Button>
      ) : null}
    </span>
  );
}

const WORK_MODE_HINTS: Partial<Record<IssueWorkMode, string>> = {
  standard: "The agent does the work",
  planning: "The agent writes a plan for your review first",
  ask: "The agent answers without changing anything",
};

/** The task's type. Uses the shipped work-mode labels, icons, and chip styles. */
function WorkModeControl({
  mode,
  suggested,
  flash,
  probabilities,
  onChange,
  onReset,
}: {
  mode: IssueWorkMode;
  suggested: boolean;
  flash: boolean;
  probabilities?: Record<string, number>;
  onChange: (mode: IssueWorkMode) => void;
  onReset?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const meta = workModeMetaFor(mode);
  const Icon = meta.icon;
  return (
    <span className="inline-flex items-center">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-issue-work-mode-chip={mode}
            aria-label={`Mode${suggested ? ` (set by ${JEV_NAME})` : ""}`}
            className={cn(COMPACT_CONTROL, CHANGE_TRANSITION, meta.classes.chip, flash && "bg-accent")}
          >
            {suggested ? <Sparkles aria-hidden className="h-3 w-3" /> : null}
            <span key={mode} className="tc-enter-marker inline-flex items-center gap-1.5">
              <Icon aria-hidden className="h-3 w-3" />
              {meta.label}
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 p-1">
          {workModeMetaList().map((option) => {
            const OptionIcon = option.icon;
            return (
              <MenuOption
                key={option.value}
                selected={option.value === mode}
                probability={probabilities?.[option.value]}
                onSelect={() => { onChange(option.value); setOpen(false); }}
                leading={<OptionIcon aria-hidden className={cn("h-3.5 w-3.5", option.classes.menuItem)} />}
                label={option.label}
                detail={WORK_MODE_HINTS[option.value]}
              />
            );
          })}
        </PopoverContent>
      </Popover>
      {onReset ? (
        <Button variant="ghost" size="icon-xs" className="text-muted-foreground" onClick={onReset} title={`Use ${JEV_NAME}'s choice`}>
          <Undo2 />
        </Button>
      ) : null}
    </span>
  );
}

/** Menu row in the shipped InlineEntitySelector style, plus Jev's probability for the option. */
function MenuOption({
  selected,
  probability,
  onSelect,
  leading,
  label,
  detail,
}: {
  selected: boolean;
  probability?: number;
  onSelect: () => void;
  leading?: ReactNode;
  label: string;
  detail?: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn("flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent/50", selected && "bg-accent")}
    >
      {leading}
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{label}</span>
        {detail ? <span className="truncate text-xs text-muted-foreground">{detail}</span> : null}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-2">
        {probability !== undefined ? <span className="font-mono text-xs text-muted-foreground">{percent(probability)}</span> : null}
        <Check aria-hidden className={cn("h-3.5 w-3.5 text-muted-foreground", selected ? "opacity-100" : "opacity-0")} />
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Jev's presence: a quiet live indicator that opens the confidence details.

function JevConfidence({
  routing,
  prompt,
  agents,
  liveStats,
  updating,
}: {
  routing: JevRouting;
  prompt: string;
  agents: JevAgent[];
  liveStats: LiveStats;
  updating: boolean;
}) {
  const coverage = agentContextCoverage(agents.filter((agent) => !agent.paused));
  const rows: { field: JevField; label: string; value: string }[] = [
    { field: "workMode", label: "Mode", value: workModeMetaFor(routing.workMode).label },
    {
      field: "assignee",
      label: "Owner",
      value: routing.assigneeSource === "fallback"
        ? `${agents.find((agent) => agent.id === routing.assigneeId)?.name} (fallback)`
        : agents.find((agent) => agent.id === routing.assigneeId)?.name ?? routing.assigneeId,
    },
  ];
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={updating ? `${JEV_NAME} is updating. Show confidence.` : `Show how sure ${JEV_NAME} is`}
          className="ml-auto inline-flex h-8 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-6"
        >
          <Sparkles aria-hidden className={cn("h-3 w-3", updating && "animate-pulse motion-reduce:animate-none")} />
          <span className="font-mono">{percent(routing.confidence.assignee)}</span>
          <span role="status" className="sr-only">{updating ? "Updating suggestions" : ""}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-3 p-3 text-xs">
        <div className="space-y-1.5">
          {rows.map((row) => {
            const confidence = routing.confidence[row.field];
            return (
              <div key={row.field} className="flex items-center gap-2">
                <span className="w-12 shrink-0 text-muted-foreground">{row.label}</span>
                <span className="min-w-0 flex-1 truncate text-foreground">{row.value}</span>
                <span className="h-1 w-16 shrink-0 overflow-hidden rounded-full bg-muted" aria-hidden>
                  <span
                    className={cn("block h-full rounded-full", confidence < JEV_CONFIDENCE_THRESHOLD ? "bg-muted-foreground" : "bg-primary")}
                    style={{ width: percent(confidence) }}
                  />
                </span>
                <span className="w-9 shrink-0 text-right font-mono text-muted-foreground">{percent(confidence)}</span>
              </div>
            );
          })}
        </div>
        <p className="text-muted-foreground">
          {JEV_MODEL} returns a choice and probabilities, not reasons. Open a control to see every option's probability.
          Anything you change stays as you set it.
        </p>
        <p className="text-muted-foreground">
          Agent context: title and role for all {coverage.total}, finished tasks for {coverage.history}, project leads for {coverage.leads},
          custom instructions for {coverage.instructions}, skills for {coverage.skills}, capabilities for {coverage.capabilities}.
        </p>
        <p className="font-mono text-muted-foreground">
          {formatTokens(routing.usage.input_tokens)} input tokens · {formatUsd(routing.usage.cost)} per call · output free
        </p>
        <details>
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Request sent to {JEV_NAME}</summary>
          <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2 font-mono text-xs text-foreground">
            {`POST https://openrouter.ai/api/alpha/decisions\n${JSON.stringify(buildJevDecisionRequest(prompt, agents), null, 2)}`}
          </pre>
        </details>
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// Estimated cost for this task: every live Jev call plus the one Haiku title call.

const formatTokens = (value: number) => value.toLocaleString("en-US");
const formatUsd = (value: number) => `$${value < 0.01 ? value.toFixed(5) : value.toFixed(4)}`;
/** Whole dollars with separators, for the at-scale estimate (for example "$160"). */
const formatScaledUsd = (value: number) => `$${Math.round(value).toLocaleString("en-US")}`;

function TaskCostSummary({ jev, title, titlePending }: { jev: LiveStats; title: ModelUsage | null; titlePending: boolean }) {
  const total = jev.cost + (title?.cost ?? 0);
  const rows = [
    {
      label: `${JEV_NAME} · live routing`,
      detail: `${jev.calls} ${jev.calls === 1 ? "call" : "calls"} · ${formatTokens(jev.inputTokens)} in`,
      cost: formatUsd(jev.cost),
    },
    {
      label: "Haiku 4.5 · title",
      detail: title ? `1 call · ${formatTokens(title.input_tokens)} in / ${formatTokens(title.output_tokens)} out` : titlePending ? "writing…" : "runs on start",
      cost: title ? formatUsd(title.cost) : "—",
    },
  ];
  return (
    <section aria-label="Estimated cost for this task" className="flex flex-col gap-1 text-xs text-muted-foreground">
      <span className="font-medium">Estimated cost</span>
      {rows.map((row) => (
        <div key={row.label} className="flex items-baseline gap-3">
          <span className="w-24 shrink-0 sm:w-32">{row.label}</span>
          <span className="min-w-0 flex-1 break-words font-mono">{row.detail}</span>
          <span className="shrink-0 font-mono">{row.cost}</span>
        </div>
      ))}
      <div className="flex items-baseline gap-3 text-foreground">
        <span className="w-24 shrink-0 sm:w-32">Total</span>
        <span className="min-w-0 flex-1 break-words font-mono text-muted-foreground">
          {title ? `≈ ${formatScaledUsd(total * 1_000_000)} per 1M tasks` : ""}
        </span>
        <span className="shrink-0 font-mono">{formatUsd(total)}</span>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Footer: secondary left, primary right, one row (DESIGN.md form footers).

function ComposerFooter({
  flow,
  created,
  canCreate,
  routingPending,
  titlePending,
  assigneeName,
  onCancel,
  onCreate,
  onCreateAnother,
}: {
  flow: "suggest-first" | "instant";
  created: boolean;
  canCreate: boolean;
  routingPending: boolean;
  titlePending: boolean;
  assigneeName: string | null;
  onCancel: () => void;
  onCreate: () => void;
  onCreateAnother: () => void;
}) {
  // The result shows in place rather than as a toast, because the task is on screen.
  const status = created
    ? routingPending || titlePending
      ? "Naming and routing…"
      : assigneeName
        ? `Created and assigned to ${assigneeName}`
        : "Created"
    : null;

  return (
    <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border px-4 py-2.5">
      {created ? (
        <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={onCreateAnother}>
          Create another
        </Button>
      ) : (
        <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={onCancel} disabled={!canCreate}>
          Cancel
        </Button>
      )}
      <div className="flex min-w-0 items-center gap-3">
        {status ? (
          <span role="status" className="hidden truncate text-xs text-muted-foreground sm:inline">{status}</span>
        ) : (
          <span className="hidden items-center gap-1 text-xs text-muted-foreground sm:inline-flex">
            <kbd className="rounded border border-border px-1 font-mono">↵</kbd> to {flow === "instant" ? "start" : "create"}
            <kbd className="ml-1 rounded border border-border px-1 font-mono">⇧↵</kbd> new line
          </span>
        )}
        {created ? (
          <Button size="sm" className="min-w-(--sz-8_5rem)">Open task</Button>
        ) : (
          <Button size="sm" className="min-w-(--sz-8_5rem)" onClick={onCreate} disabled={!canCreate}>
            {flow === "instant" ? "Start task" : "Create task"}
          </Button>
        )}
      </div>
    </div>
  );
}
