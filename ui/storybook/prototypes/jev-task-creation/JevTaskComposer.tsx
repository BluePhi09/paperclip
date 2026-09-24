import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { IssueWorkMode } from "@paperclipai/shared";
import { AlertTriangle, Check, ChevronDown, FolderKanban, Pencil, RotateCcw, Sparkles, Undo2 } from "lucide-react";
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
  JEV_PROJECTS,
  agentContextCoverage,
  stabilizeRouting,
  buildJevDecisionRequest,
  draftTaskTitle,
  routeTaskWithJev,
  type JevField,
  type JevRouting,
} from "./jev-classifier";

export type JevTaskComposerProps = {
  /**
   * Both flows update mode and owner live while you type. The title is
   * drafted once, when the task is started (Start task or Enter), like Claude
   * Code naming a session after the first message.
   * `suggest-first`: review the live suggestions, then create.
   * `instant`: start any time; whatever Jev has suggested so far is used, and
   * anything still pending finishes after.
   */
  flow?: "suggest-first" | "instant";
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
  mobile?: boolean;
};

type Overrides = Partial<{ title: string; workMode: IssueWorkMode; assignee: string; project: string | null }>;
type OverrideField = keyof Overrides;
type Status = "idle" | "thinking" | "ready" | "error";
type LiveStats = { calls: number; cost: number };

const FLASH_MS = 900;
/** Explanatory notes (like the fallback owner) wait for a pause in typing, so they don't flicker mid-sentence. */
const SETTLE_MS = 1000;

/** Debounce with a ceiling: wait for a pause, but never longer than `maxWaitMs` since the first pending change. */
function throttledDelay(pendingSince: { current: number | null }, debounceMs: number, maxWaitMs: number) {
  if (pendingSince.current === null) pendingSince.current = Date.now();
  return Math.max(0, Math.min(debounceMs, maxWaitMs - (Date.now() - pendingSince.current)));
}

const percent = (value: number | undefined) => (value === undefined ? "" : `${Math.round(value * 100)}%`);
const isAbort = (error: unknown) => error instanceof DOMException && error.name === "AbortError";

function commonPrefixLength(a: string, b: string) {
  let index = 0;
  while (index < a.length && index < b.length && a[index] === b[index]) index += 1;
  return index;
}

/**
 * Types a suggested title in, like a session title arriving. When the title is
 * redrafted mid-typing, only the part that changed is retyped.
 */
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
  initialPrompt = "",
  latencyMs = 350,
  titleLatencyMs = 1200,
  liveDebounceMs = 250,
  liveMaxWaitMs = 800,
  jevUnavailable = false,
  presetAssigneeId,
  pausedAgentIds,
  typeOnMount = false,
  mobile = false,
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
  const [editingTitle, setEditingTitle] = useState(false);
  const [createdIdentifier, setCreatedIdentifier] = useState<string | null>(null);
  const [createdPrompt, setCreatedPrompt] = useState("");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [flash, setFlash] = useState<Partial<Record<JevField, boolean>>>({});
  const [liveStats, setLiveStats] = useState<LiveStats>({ calls: 0, cost: 0 });
  const routingRef = useRef<JevRouting | null>(null);
  const routingAbortRef = useRef<AbortController | null>(null);
  const titleAbortRef = useRef<AbortController | null>(null);
  const lastRoutedRef = useRef("");
  const lastTitledRef = useRef("");
  const flashTimerRef = useRef<number | undefined>(undefined);
  const [settled, setSettled] = useState(true);
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
        const changed: Partial<Record<JevField, boolean>> = previous ? {
          workMode: previous.workMode !== next.workMode,
          assignee: previous.assigneeId !== next.assigneeId,
        } : {};
        routingRef.current = next;
        setRouting(next);
        setRoutingStatus("ready");
        setLiveStats((stats) => ({ calls: stats.calls + 1, cost: stats.cost + result.usage.cost }));
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
    lastTitledRef.current = text;
    setTitleStatus("thinking");
    draftTaskTitle(text, { latencyMs: titleLatencyMs, signal: controller.signal })
      .then((title) => { setSuggestedTitle(title); setTitleStatus("ready"); })
      .catch((error: unknown) => { if (!isAbort(error)) setTitleStatus("error"); });
  }, [titleLatencyMs]);

  const resetSuggestions = useCallback(() => {
    routingAbortRef.current?.abort();
    titleAbortRef.current?.abort();
    lastRoutedRef.current = "";
    lastTitledRef.current = "";
    routingPendingSinceRef.current = null;
    routingRef.current = null;
    setRouting(null);
    setSuggestedTitle(null);
    setRoutingStatus("idle");
    setTitleStatus("idle");
    setFlash({});
  }, []);

  // Live routing: re-run shortly after each pause in typing, until the task is created.
  useEffect(() => {
    if (createdIdentifier) return;
    const text = prompt.trim();
    if (text.length < JEV_MIN_PROMPT_LENGTH) {
      if (lastRoutedRef.current || lastTitledRef.current) resetSuggestions();
      return;
    }
    if (text === lastRoutedRef.current) return;
    const timer = window.setTimeout(() => runRouting(text), throttledDelay(routingPendingSinceRef, liveDebounceMs, liveMaxWaitMs));
    return () => window.clearTimeout(timer);
  }, [prompt, createdIdentifier, runRouting, resetSuggestions, liveDebounceMs, liveMaxWaitMs]);

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
    // Creating never waits: keep the routing that's shown, bring it up to date if
    // typing got ahead of it, and draft the title now that the prompt is final.
    if (lastRoutedRef.current !== text) runRouting(text);
    runTitle(text);
  };
  const startOver = () => {
    resetSuggestions();
    setPrompt("");
    setOverrides({});
    setCreatedIdentifier(null);
    setDetailsOpen(false);
    setLiveStats({ calls: 0, cost: 0 });
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
                // Enter starts the task, like sending a first message. Shift+Enter adds a line.
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  create();
                }
              }}
              placeholder="What should get done? Mode and owner update as you write. Enter to start, Shift+Enter for a new line."
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
          agents={agents}
          routing={routing}
          effective={effective}
          fromJev={fromJev}
          setField={setField}
          resetField={resetField}
          flash={flash}
          liveStats={liveStats}
          settled={settled || created}
          detailsOpen={detailsOpen}
          onToggleDetails={() => setDetailsOpen((open) => !open)}
          onRetry={() => runRouting(prompt.trim() || createdPrompt)}
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
                {busy ? (
                  <span className="hidden text-xs text-muted-foreground sm:inline">
                    You can {flow === "instant" ? "start" : "create"} now; routing finishes after.
                  </span>
                ) : null}
                <Button size="sm" onClick={create} disabled={!canCreate}>
                  {flow === "instant" ? "Start task" : "Create task"}
                  <kbd className="ml-1 hidden text-xs opacity-60 sm:inline">↵</kbd>
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
  agents,
  routing,
  effective,
  fromJev,
  setField,
  resetField,
  flash,
  liveStats,
  settled,
  detailsOpen,
  onToggleDetails,
  onRetry,
}: {
  flow: "suggest-first" | "instant";
  created: boolean;
  status: Status;
  promptLength: number;
  prompt: string;
  agents: typeof JEV_AGENTS;
  routing: JevRouting | null;
  effective: Effective;
  fromJev: (field: Exclude<OverrideField, "title">) => boolean;
  setField: <K extends OverrideField>(field: K, value: Overrides[K]) => void;
  resetField: (field: OverrideField) => void;
  flash: Partial<Record<JevField, boolean>>;
  liveStats: LiveStats;
  settled: boolean;
  detailsOpen: boolean;
  onToggleDetails: () => void;
  onRetry: () => void;
}) {
  // Below the confidence threshold the task goes to the org's fallback owner (see `fallbackAssigneeId`).
  const fallbackOwner = routing?.assigneeSource === "fallback" && fromJev("assignee")
    ? JEV_AGENTS.find((agent) => agent.id === routing.assigneeId) ?? null
    : null;

  const statusLine = (() => {
    if (status === "thinking" && !routing) return created ? `${JEV_NAME} is routing this task…` : `${JEV_NAME} is reading as you type…`;
    if (fallbackOwner && settled) {
      const why = fallbackOwner.reportsTo === null ? "who reports to the board" : "the first agent in your org";
      return `${JEV_NAME} wasn't sure who should own this (${percent(routing!.confidence.assignee)}), so it goes to ${fallbackOwner.name}, ${why}.`;
    }
    if (status === "idle" && promptLength === 0 && !created) {
      return `As you type, ${JEV_NAME} picks the mode and owner. The title is written when you ${flow === "instant" ? "start" : "create"} the task.`;
    }
    if (status === "idle" && promptLength > 0 && promptLength < JEV_MIN_PROMPT_LENGTH) return "Keep going. Suggestions start once there's a bit more to go on.";
    return null;
  })();

  // Chips stay on screen from the first keystroke, so suggestions fill in place instead of popping in.
  const showChips = true;
  const updating = routing !== null && status === "thinking";
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
          {routing && !statusLine ? (
            <span title={updating ? `${JEV_NAME} is updating` : `Suggested by ${JEV_NAME}`}>
              <JevMark thinking={updating} />
            </span>
          ) : null}
          <span role="status" className="sr-only">{updating ? "Updating suggestions" : ""}</span>
          <WorkModeChip
            flash={flash.workMode}
            loading={loading}
            mode={effective.workMode}
            suggested={fromJev("workMode")}
            probabilities={probabilities?.workMode}
            onChange={(mode) => setField("workMode", mode)}
            onReset={resetFor("workMode")}
          />
          <PropertyChip
            label="Assignee"
            valueKey={effective.assignee ?? "none"}
            flash={flash.assignee}
            loading={loading}
            suggested={fromJev("assignee") && !fallbackOwner}
            onReset={resetFor("assignee")}
            display={assignee ? <><AgentAvatar agent={assignee} size={16} />{assignee.name}</> : <span>Assignee</span>}
          >
            {(close) => agents.map((agent) => (
              <MenuItem
                key={agent.id}
                selected={agent.id === effective.assignee}
                probability={probabilities?.assignee[agent.id]}
                onClick={() => { setField("assignee", agent.id); close(); }}
              >
                <AgentAvatar agent={agent} size={20} />
                <span className="flex flex-col">
                  <span>{agent.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {agent.title}{agent.paused ? " · Paused" : ""}{agent.id === fallbackOwner?.id ? " · Fallback owner" : ""}
                  </span>
                </span>
              </MenuItem>
            ))}
          </PropertyChip>

          <PropertyChip
            label="Project"
            valueKey={effective.project ?? "none"}
            loading={false}
            suggested={false}
            display={<><FolderKanban aria-hidden className="size-3.5" />{JEV_PROJECTS.find((project) => project.id === effective.project)?.name ?? "No project"}</>}
          >
            {(close) => [
              ...JEV_PROJECTS.map((project) => (
                <MenuItem
                  key={project.id}
                  selected={project.id === effective.project}
                  onClick={() => { setField("project", project.id); close(); }}
                >
                  {project.name}
                </MenuItem>
              )),
              <MenuItem
                key="none"
                selected={effective.project === null}
                onClick={() => { setField("project", null); close(); }}
              >
                No project
              </MenuItem>,
            ]}
          </PropertyChip>

        </div>
      ) : null}

      {fallbackOwner && settled && alternates.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-foreground">{JEV_NAME}'s best guesses:</span>
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
          {detailsOpen ? <ConfidenceDetails routing={routing} prompt={prompt} agents={agents} liveStats={liveStats} /> : null}
        </div>
      ) : null}
    </div>
  );
}

const FIELD_LABELS: Record<JevField, string> = { workMode: "Mode", assignee: "Assignee" };

function choiceLabel(field: JevField, routing: JevRouting): string {
  if (field === "assignee") {
    const name = (id: string) => JEV_AGENTS.find((agent) => agent.id === id)?.name ?? id;
    return routing.assigneeSource === "fallback"
      ? `${name(routing.assigneeId)} (fallback; ${JEV_NAME} leaned ${name(routing.jevAssigneeId)})`
      : name(routing.assigneeId);
  }
  return workModeMetaFor(routing.workMode).label;
}

function ConfidenceDetails({ routing, prompt, agents, liveStats }: { routing: JevRouting; prompt: string; agents: typeof JEV_AGENTS; liveStats: LiveStats }) {
  const fields: JevField[] = ["workMode", "assignee"];
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
      <AgentContextLine agents={agents.filter((agent) => !agent.paused)} />
      <p className="tabular-nums">
        {routing.usage.input_tokens} input tokens · ${routing.usage.cost.toFixed(6)} · output tokens are free
      </p>
      <p className="tabular-nums">
        Routed live {liveStats.calls} {liveStats.calls === 1 ? "time" : "times"} while typing · ${liveStats.cost.toFixed(6)} total
      </p>
      <details>
        <summary className="cursor-pointer hover:text-foreground">Request sent to {JEV_NAME}</summary>
        <pre className="mt-1 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2 font-mono text-xs text-foreground">
          {`POST https://openrouter.ai/api/alpha/decisions\n${JSON.stringify(buildJevDecisionRequest(prompt, agents), null, 2)}`}
        </pre>
      </details>
    </div>
  );
}

/** Which agent context sources fed the assignee decision, highest fidelity first. */
function AgentContextLine({ agents }: { agents: typeof JEV_AGENTS }) {
  const coverage = agentContextCoverage(agents);
  const sources = [
    ["finished tasks", coverage.history],
    ["project leads", coverage.leads],
    ["custom instructions", coverage.instructions],
    ["skills", coverage.skills],
    ["capabilities", coverage.capabilities],
  ] as const;
  return (
    <p>
      Agent context sent: title and role for all {coverage.total}
      {sources.map(([label, count]) => `, ${label} for ${count}`).join("")}.
    </p>
  );
}

/** A changed value flashes briefly and fades in, so live updates are noticeable but calm. */
const FLASH_CLASSES = "ring-2 ring-primary/50 bg-primary/10";
const CHANGE_TRANSITION = "transition-[background-color,box-shadow,border-color] duration-700 motion-reduce:transition-none";
const FADE_IN = "animate-[tc-fade-in_240ms_ease-out] motion-reduce:animate-none";

function PropertyChip({
  label,
  valueKey,
  display,
  loading,
  suggested,
  flash = false,
  onReset,
  children,
}: {
  label: string;
  valueKey: string;
  display: ReactNode;
  flash?: boolean;
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
              "inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-sm text-foreground hover:bg-accent",
              CHANGE_TRANSITION,
              suggested ? "border-primary/40 bg-primary/5" : "border-border",
              flash && FLASH_CLASSES,
            )}
          >
            {suggested ? <Sparkles aria-hidden className="size-3 text-primary" /> : null}
            <span key={valueKey} className={cn("inline-flex items-center gap-1.5", FADE_IN)}>{display}</span>
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

const WORK_MODE_HINTS: Partial<Record<IssueWorkMode, string>> = {
  standard: "The agent does the work",
  planning: "The agent writes a plan for your review first",
  ask: "The agent answers without changing anything",
};

/** The task's type. Uses the shipped work-mode labels, icons, and colors. */
function WorkModeChip({
  mode,
  loading,
  suggested,
  flash = false,
  probabilities,
  onChange,
  onReset,
}: {
  mode: IssueWorkMode;
  flash?: boolean;
  loading: boolean;
  suggested: boolean;
  probabilities?: Record<string, number>;
  onChange: (mode: IssueWorkMode) => void;
  onReset?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const meta = workModeMetaFor(mode);
  const Icon = meta.icon;
  if (loading) return <span aria-label="Mode loading" className="h-7 w-20 animate-pulse rounded-md border border-border bg-muted/60" />;
  return (
    <span className="inline-flex items-center">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`Mode${suggested ? ` (suggested by ${JEV_NAME})` : ""}`}
            className={cn("inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-sm", CHANGE_TRANSITION, meta.classes.chip, flash && FLASH_CLASSES)}
          >
            {suggested ? <Sparkles aria-hidden className="size-3" /> : null}
            <span key={mode} className={cn("inline-flex items-center gap-1.5", FADE_IN)}>
              <Icon aria-hidden className="size-3.5" />
              {meta.label}
            </span>
            <ChevronDown aria-hidden className="size-3 opacity-60" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 p-1">
          {workModeMetaList().map((option) => {
            const OptionIcon = option.icon;
            return (
              <MenuItem
                key={option.value}
                selected={option.value === mode}
                probability={probabilities?.[option.value]}
                onClick={() => { onChange(option.value); setOpen(false); }}
              >
                <OptionIcon aria-hidden className={cn("size-3.5 shrink-0", option.classes.menuItem)} />
                <span className="flex flex-col">
                  <span>{option.label}</span>
                  <span className="text-xs text-muted-foreground">{WORK_MODE_HINTS[option.value]}</span>
                </span>
              </MenuItem>
            );
          })}
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
