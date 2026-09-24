import type { IssueWorkMode } from "@paperclipai/shared";

/**
 * Storybook-only model of task routing with Jev, TypeSafe's decision model on
 * OpenRouter (https://openrouter.ai/docs/guides/community/jev).
 *
 * Jev answers typed questions about application state with probabilities; it
 * does not generate text or explain itself. So routing is split in two:
 *
 * - Jev (`POST /api/alpha/decisions`, model `typesafe/jev-1.13`) answers `choice`
 *   questions for the task's mode (its type: Auto, Plan, or Ask) and assignee.
 * - A small text model drafts the title, the way Claude Code names a session.
 *
 * `buildJevDecisionRequest` produces the real request body. The response is
 * simulated locally from keyword signals, in the documented response shape, so
 * the UX can be reviewed without an API key. Swap `simulateJevDecisions` for a
 * server call to go live; never call OpenRouter from the browser with a key.
 */

export const JEV_NAME = "Jev";
export const JEV_MODEL = "typesafe/jev-1.13";
/** Below this assignee confidence, the task goes to the fallback owner (see `fallbackAssigneeId`). */
export const JEV_CONFIDENCE_THRESHOLD = 0.6;
/** Prompts need a little substance before routing starts. */
export const JEV_MIN_PROMPT_LENGTH = 12;
/** While typing, a suggestion only switches when the new pick leads the current one by this much probability. */
export const JEV_SWITCH_MARGIN = 0.15;

// ---------------------------------------------------------------------------
// Decisions API shapes (from the OpenRouter Jev docs)

export type JevChoiceQuestion = { type: "choice"; instructions: string; criteria: Record<string, string> };
export type JevNoulQuestion = { type: "noul"; instructions: string; criteria?: { true: string; false: string } };
export type JevScoreQuestion = { type: "score"; instructions: string; criteria: string[] };
export type JevQuestion = JevChoiceQuestion | JevNoulQuestion | JevScoreQuestion;

export type JevDecisionRequest = {
  model: string;
  state: Record<string, unknown>;
  questions: Record<string, JevQuestion>;
};

export type JevChoiceAnswer = { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> };
export type JevDecisionResponse = {
  model: string;
  answers: Record<string, JevChoiceAnswer>;
  usage: { input_tokens: number; output_tokens: number; cost: number };
};

// ---------------------------------------------------------------------------
// Company fixtures (match the Storybook company)

/**
 * An agent as Paperclip stores it, reduced to the fields that describe what it
 * does. Ranked by how well they separate agents for routing:
 *
 * 1. `recentDoneTaskTitles`: issues it finished (`issues.assigneeAgentId`, status done).
 * 2. Projects it leads (`projects.leadAgentId`, on `JevProject`).
 * 3. `customInstructionsExcerpt`: its `AGENTS.md` bundle, only when customized.
 * 4. `skills`: assigned company skills (`adapterConfig.paperclipSkillSync`).
 * 5. `capabilities`: free text (`agents.capabilities`). Set by built-in agents and
 *    imports; the new-agent flow can't set it, so hand-made agents usually lack it.
 * 6. `name`, `title`, `role`: always present, rarely decisive.
 */
export type JevAgent = {
  id: string;
  name: string;
  role: string;
  title: string;
  capabilities: string | null;
  skills: string[];
  /** Null while the agent still uses the default instructions template, which says nothing about it. */
  customInstructionsExcerpt: string | null;
  /** Most recent first. Empty for new agents. */
  recentDoneTaskTitles: string[];
  /** `null` means the agent reports directly to the board. */
  reportsTo: string | null;
  createdAt: string;
  paused?: boolean;
};

export const JEV_AGENTS: JevAgent[] = [
  {
    id: "agent-codex",
    name: "CodexCoder",
    role: "engineer",
    title: "Senior Product Engineer",
    // Hand-created: no capabilities, default instructions. History carries it.
    capabilities: null,
    skills: ["paperclip", "github-pr-workflow"],
    customInstructionsExcerpt: null,
    recentDoneTaskTitles: [
      "Fix inbox unread badge after archiving",
      "Retry issue checkout on 409 conflicts",
      "Paginate the activity feed API",
      "Fix duplicate toast on task create",
    ],
    reportsTo: "agent-cto",
    createdAt: "2026-04-02T09:00:00Z",
  },
  {
    id: "agent-design-system",
    name: "DesignSystemCoder",
    role: "designer",
    title: "Design System Engineer",
    capabilities: "Owns the design system: tokens, shared components, and Storybook coverage.",
    skills: ["paperclip", "design-guide"],
    customInstructionsExcerpt: "You maintain the token layer in ui/src/index.css and the shared components. Every UI change must pass the token gates. Review spacing, typography, and dark mode on every surface you touch.",
    recentDoneTaskTitles: ["Tokenize spacing in dialogs", "Add dark-mode stories for badges", "Tighten mobile layout of the inbox"],
    reportsTo: "agent-cto",
    createdAt: "2026-04-06T09:00:00Z",
  },
  {
    id: "agent-qa",
    name: "QAChecker",
    role: "qa",
    title: "QA Engineer",
    capabilities: null,
    skills: ["paperclip", "release-smoke"],
    customInstructionsExcerpt: null,
    recentDoneTaskTitles: ["Run release smoke for v1.14", "Reproduce invite link 404 in private mode", "Verify budget hard-stop pauses agents"],
    reportsTo: "agent-cto",
    createdAt: "2026-04-03T09:00:00Z",
  },
  {
    id: "agent-cto",
    name: "CTO",
    role: "cto",
    title: "Chief Technology Officer",
    // Hired from the teams catalog: catalog instructions and skills, no capabilities text.
    capabilities: null,
    skills: ["github-pr-workflow", "task-planning", "doc-maintenance"],
    customInstructionsExcerpt: "You own technical direction. Break large work into planned child issues for the engineers, review architecture proposals, and answer technical questions from the board.",
    recentDoneTaskTitles: ["Decide between a queue and cron for routines", "Review the adapter plugin API proposal"],
    reportsTo: null,
    createdAt: "2026-04-01T09:00:00Z",
  },
  {
    id: "agent-darnold",
    name: "Darnold",
    role: "general",
    title: "Chief of Staff",
    // Built-in agent: capabilities come from its short purpose.
    capabilities: "Prepares concise operational briefs for the board and agent company.",
    skills: ["paperclip"],
    customInstructionsExcerpt: null,
    recentDoneTaskTitles: ["Weekly board brief", "Follow up on overdue approvals", "Send the invoice reminder to finance"],
    reportsTo: null,
    createdAt: "2026-04-10T09:00:00Z",
  },
];

export type JevProject = { id: string; name: string; description: string; leadAgentId: string | null };

export const JEV_PROJECTS: JevProject[] = [
  { id: "project-board-ui", name: "Board UI", description: "The operator-facing web app: pages, dialogs, inbox, mobile.", leadAgentId: "agent-codex" },
  { id: "project-agent-runtime", name: "Agent Runtime", description: "Adapters, heartbeats, runners, and agent sessions.", leadAgentId: "agent-cto" },
  { id: "project-budget-guardrails", name: "Budget Guardrails", description: "Spend limits, cost tracking, and billing.", leadAgentId: null },
];

/** How many finished task titles to send per agent. */
export const JEV_RECENT_TASKS_PER_AGENT = 10;
const INSTRUCTIONS_EXCERPT_MAX = 280;

/** One line per agent for Jev's choice criteria, highest-fidelity context first; empty sources are skipped. */
export function describeAgentForJev(agent: JevAgent, projects: JevProject[] = JEV_PROJECTS): string {
  const leads = projects.filter((project) => project.leadAgentId === agent.id).map((project) => project.name);
  const recent = agent.recentDoneTaskTitles.slice(0, JEV_RECENT_TASKS_PER_AGENT);
  const instructions = agent.customInstructionsExcerpt?.slice(0, INSTRUCTIONS_EXCERPT_MAX);
  return [
    `${agent.name}, ${agent.title} (${agent.role}).`,
    agent.capabilities ? agent.capabilities : null,
    leads.length ? `Leads ${leads.join(", ")}.` : null,
    agent.skills.length ? `Skills: ${agent.skills.join(", ")}.` : null,
    recent.length ? `Recently finished: ${recent.map((title) => `"${title}"`).join("; ")}.` : null,
    instructions ? `Instructions: ${instructions}` : null,
  ].filter(Boolean).join(" ");
}

/** Which context sources were available for the agents sent to Jev. */
export function agentContextCoverage(agents: JevAgent[], projects: JevProject[] = JEV_PROJECTS) {
  const count = (predicate: (agent: JevAgent) => boolean) => agents.filter(predicate).length;
  return {
    total: agents.length,
    history: count((agent) => agent.recentDoneTaskTitles.length > 0),
    leads: count((agent) => projects.some((project) => project.leadAgentId === agent.id)),
    instructions: count((agent) => agent.customInstructionsExcerpt !== null),
    skills: count((agent) => agent.skills.length > 0),
    capabilities: count((agent) => agent.capabilities !== null),
  };
}


// ---------------------------------------------------------------------------
// Request builder: this is what a server would send to OpenRouter.

export function buildJevDecisionRequest(prompt: string, agents: JevAgent[] = JEV_AGENTS): JevDecisionRequest {
  // Paused agents can't take work, so Jev never sees them as options.
  const available = agents.filter((agent) => !agent.paused);
  return {
    model: JEV_MODEL,
    state: {
      task_prompt: prompt,
      // Each agent's full description lives in the assignee criteria, so it is sent once.
      agents: available.map(({ id, name, title, reportsTo }) => ({ id, name, title, reports_to: reportsTo ?? "board" })),
    },
    questions: {
      work_mode: {
        type: "choice",
        instructions: "What type of task is this: should the agent do the work, plan it first, or answer a question?",
        criteria: {
          standard: "Auto: a clear, bounded request the agent can carry out directly.",
          planning: "Plan: large, risky, or multi-step work that needs a reviewed plan before anything changes.",
          ask: "Ask: a question or investigation to answer without changing anything.",
        },
      },
      assignee: {
        type: "choice",
        instructions: "Which agent should own this task?",
        criteria: Object.fromEntries(available.map((agent) => [agent.id, describeAgentForJev(agent)])),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Local simulation of Jev's answers. Work areas are internal signals for
// picking an owner; they are not shown or stored.

type WorkArea = "bug" | "feature" | "research" | "design" | "qa" | "ops";

const AREA_KEYWORDS: Record<WorkArea, string[]> = {
  bug: ["bug", "broken", "fix", "crash", "error", "regress", "fails", "failing", "500", "stuck", "doesn't", "does not", "not working", "wrong"],
  feature: ["add", "build", "implement", "support", "create", "new", "allow", "enable", "endpoint", "integrate", "make", "improve", "faster", "performance"],
  research: ["research", "investigate", "compare", "evaluate", "why", "how does", "figure out", "explore", "options", "should we"],
  design: ["design", "mockup", "figma", "layout", "visual", "ux", "ui polish", "spacing", "typography", "color", "icon", "prototype"],
  qa: ["test", "qa", "verify", "reproduce", "regression suite", "smoke", "e2e", "check that", "coverage"],
  ops: ["release", "deploy", "rotate", "invoice", "schedule", "onboard", "hire", "budget report", "coordinate", "follow up", "email"],
};

/** Which agent usually owns each work area. */
const AREA_OWNER: Record<WorkArea, string> = {
  bug: "agent-codex",
  feature: "agent-codex",
  research: "agent-cto",
  design: "agent-design-system",
  qa: "agent-qa",
  ops: "agent-darnold",
};

function score(text: string, keywords: string[]): number {
  return keywords.reduce((total, keyword) => total + (text.includes(keyword) ? 1 : 0), 0);
}

function softmax(scores: Record<string, number>, sharpness = 2.2): Record<string, number> {
  const entries = Object.entries(scores);
  const weights = entries.map(([, value]) => Math.exp(value * sharpness));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return Object.fromEntries(entries.map(([key], index) => [key, weights[index]! / total]));
}

function choiceAnswer(probabilities: Record<string, number>): JevChoiceAnswer {
  const ranked = Object.entries(probabilities).sort((a, b) => b[1] - a[1]);
  const top = ranked[0]!;
  const second = ranked[1]?.[1] ?? 0;
  // Jev reports confidence separately from the top probability; approximate it by the margin.
  const confidence = Math.min(1, Math.max(0, (top[1] - second) * 1.6));
  return {
    type: "choice",
    choice: top[0],
    confidence: Math.round(confidence * 100) / 100,
    probabilities: Object.fromEntries(ranked.map(([key, value]) => [key, Math.round(value * 100) / 100])),
  };
}

export function simulateJevDecisions(request: JevDecisionRequest): JevDecisionResponse {
  const prompt = String(request.state.task_prompt ?? "");
  const text = prompt.toLowerCase();

  const areaScores = Object.fromEntries(
    (Object.keys(AREA_KEYWORDS) as WorkArea[]).map((area) => [area, score(text, AREA_KEYWORDS[area])]),
  ) as Record<WorkArea, number>;
  // No signal at all reads as an open question.
  if (Object.values(areaScores).every((value) => value === 0)) areaScores.research = 0.6;
  const areaProbabilities = softmax(areaScores);

  const assigneeQuestion = request.questions.assignee as JevChoiceQuestion;
  const assigneeProbabilities: Record<string, number> = Object.fromEntries(Object.keys(assigneeQuestion.criteria).map((id) => [id, 0.02]));
  for (const [area, probability] of Object.entries(areaProbabilities)) {
    const owner = AREA_OWNER[area as WorkArea];
    if (owner in assigneeProbabilities) assigneeProbabilities[owner]! += probability;
  }
  const assigneeTotal = Object.values(assigneeProbabilities).reduce((sum, value) => sum + value, 0);
  for (const id of Object.keys(assigneeProbabilities)) assigneeProbabilities[id]! /= assigneeTotal;

  const isQuestion = /\?\s*$/.test(prompt.trim()) || (/^(how|why|what|which|should|is|are|can|does)\b/.test(text) && !/^(can|could|would) you\b/.test(text));
  const isLarge = /\b(plan|roadmap|migrate|migration|redesign|rewrite|overhaul|multi-step|phases?)\b/.test(text);
  const isInvestigation = /^(investigate|research|find out|figure out|look into|compare|evaluate)\b/.test(text);
  const modeScores = { standard: 1, planning: isLarge ? 3 : 0, ask: isQuestion ? 3 : isInvestigation ? 1.6 : 0 };

  // Rough estimate: about four characters per token.
  const inputTokens = Math.round(JSON.stringify(request).length / 4);
  return {
    model: request.model,
    answers: {
      work_mode: choiceAnswer(softmax(modeScores)),
      assignee: choiceAnswer(assigneeProbabilities),
    },
    // Output tokens are free on Jev; $0.042 per million input tokens.
    usage: { input_tokens: inputTokens, output_tokens: 0, cost: (inputTokens * 0.042) / 1_000_000 },
  };
}

// ---------------------------------------------------------------------------
// What the composer consumes

export type JevField = "workMode" | "assignee";

/**
 * Who gets a task when Jev isn't confident about the owner: the org's first
 * active agent that reports to the board, or else its first active agent.
 */
export function fallbackAssigneeId(agents: JevAgent[]): string | null {
  const active = agents.filter((agent) => !agent.paused).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return (active.find((agent) => agent.reportsTo === null) ?? active[0])?.id ?? null;
}

export type JevRouting = {
  /** The task's type. */
  workMode: IssueWorkMode;
  /** The owner to use: Jev's pick, or the fallback when Jev is unsure. */
  assigneeId: string;
  assigneeSource: "jev" | "fallback";
  /** Jev's own top pick, kept even when the fallback is used. */
  jevAssigneeId: string;
  confidence: Record<JevField, number>;
  probabilities: Record<JevField, Record<string, number>>;
  /** Jev's likely owners other than the one assigned, offered when Jev is unsure. */
  alternateAssigneeIds: string[];
  usage: JevDecisionResponse["usage"];
};

export function routingFromJev(response: JevDecisionResponse, agents: JevAgent[] = JEV_AGENTS): JevRouting {
  const { work_mode: mode, assignee } = response.answers as Record<string, JevChoiceAnswer>;
  const fallbackId = assignee!.confidence < JEV_CONFIDENCE_THRESHOLD ? fallbackAssigneeId(agents) : null;
  const assigneeId = fallbackId ?? assignee!.choice;
  const alternateAssigneeIds = Object.entries(assignee!.probabilities)
    .filter(([id, probability]) => id !== assigneeId && probability >= 0.1)
    .slice(0, 2)
    .map(([id]) => id);
  return {
    workMode: mode!.choice as IssueWorkMode,
    assigneeId,
    assigneeSource: fallbackId ? "fallback" : "jev",
    jevAssigneeId: assignee!.choice,
    confidence: { workMode: mode!.confidence, assignee: assignee!.confidence },
    probabilities: { workMode: mode!.probabilities, assignee: assignee!.probabilities },
    alternateAssigneeIds,
    usage: response.usage,
  };
}

/**
 * Keeps live suggestions steady while the prompt changes. Each field keeps its
 * current value unless Jev's new top pick beats it by `JEV_SWITCH_MARGIN`, so a
 * word or two of typing doesn't make the owner flicker between two agents.
 * Moving in or out of the low-confidence fallback always applies.
 */
export function stabilizeRouting(previous: JevRouting | null, next: JevRouting): JevRouting {
  if (!previous) return next;
  const keepPrevious = (field: JevField, previousChoice: string, nextChoice: string) =>
    previousChoice !== nextChoice &&
    (next.probabilities[field][nextChoice] ?? 0) - (next.probabilities[field][previousChoice] ?? 0) < JEV_SWITCH_MARGIN;
  const result: JevRouting = { ...next };
  if (keepPrevious("workMode", previous.workMode, next.workMode)) result.workMode = previous.workMode;
  if (previous.assigneeSource === "jev" && next.assigneeSource === "jev" && keepPrevious("assignee", previous.assigneeId, next.assigneeId)) {
    result.assigneeId = previous.assigneeId;
    result.jevAssigneeId = previous.assigneeId;
  }
  result.alternateAssigneeIds = Object.entries(next.probabilities.assignee)
    .filter(([id, probability]) => id !== result.assigneeId && probability >= 0.1)
    .slice(0, 2)
    .map(([id]) => id);
  return result;
}

export type LatencyOptions = { latencyMs?: number; fail?: boolean; signal?: AbortSignal };
export type RouteOptions = LatencyOptions & { agents?: JevAgent[] };

function delay<T>(produce: () => T, { latencyMs = 400, fail = false, signal }: LatencyOptions, failure: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => (fail ? reject(new Error(failure)) : resolve(produce())), latencyMs);
    signal?.addEventListener("abort", () => {
      window.clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    });
  });
}

/** Jev is a fast decision model, so routing usually lands before the title. */
export function routeTaskWithJev(prompt: string, { agents = JEV_AGENTS, ...options }: RouteOptions = {}): Promise<JevRouting> {
  return delay(() => routingFromJev(simulateJevDecisions(buildJevDecisionRequest(prompt, agents)), agents), options, `${JEV_NAME} is unavailable right now.`);
}

// ---------------------------------------------------------------------------
// Title: a small text model, not Jev. Simulated with curated titles and a trim.

const CURATED_TITLES: Record<string, string> = {
  "the login page redirects": "Fix login redirect loop after session expiry",
  "add a csv export": "Add CSV export to the issues list",
  "should we move": "Evaluate moving heartbeats to a queue",
  "the new task dialog feels": "Tighten spacing in the new task dialog",
  "before friday's release": "Run release smoke tests before Friday",
  "the invite emails": "Sort out the invite emails",
  "rotate the": "Rotate the GitHub App private key",
  "plan the migration": "Plan phased migration of runtime sessions to the new adapter",
};

const FILLER = /^(hey|hi|please|pls|so|ok|okay|can you|could you|would you|i need you to|i need to|i want to|we need to|we should|let's|lets|i think|it seems like|it looks like)\b[\s,]*/i;

export function draftTitle(prompt: string): string {
  const normalized = prompt.trim().toLowerCase();
  for (const [prefix, title] of Object.entries(CURATED_TITLES)) {
    if (normalized.startsWith(prefix)) return title;
  }
  let text = prompt.trim().split(/(?<=[.!?])\s|\n/)[0] ?? prompt.trim();
  let previous = "";
  while (previous !== text) {
    previous = text;
    text = text.replace(FILLER, "");
  }
  text = text.replace(/[.!?]+$/, "").replace(/\s+/g, " ");
  if (text.length > 60) {
    const cut = text.slice(0, 60);
    text = cut.slice(0, cut.lastIndexOf(" ") > 30 ? cut.lastIndexOf(" ") : 60);
  }
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function draftTaskTitle(prompt: string, options: LatencyOptions = {}): Promise<string> {
  return delay(() => draftTitle(prompt), options, "Couldn't draft a title.");
}
