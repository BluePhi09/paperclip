import type { IssueWorkMode } from "@paperclipai/shared";

/**
 * Storybook-only model of task routing with Jev, TypeSafe's decision model on
 * OpenRouter (https://openrouter.ai/docs/guides/community/jev).
 *
 * Jev answers typed questions about application state with probabilities; it
 * does not generate text or explain itself. So routing is split in two:
 *
 * - Jev (`POST /api/alpha/decisions`, model `typesafe/jev-1.13`) answers `choice`
 *   questions for the task's mode (its type: Auto, Plan, or Ask), assignee, and
 *   project.
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
export const JEV_MIN_PROMPT_LENGTH = 18;

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

export type JevAgent = {
  id: string;
  name: string;
  role: string;
  title: string;
  owns: string;
  /** `null` means the agent reports directly to the board. */
  reportsTo: string | null;
  createdAt: string;
  paused?: boolean;
};

export const JEV_AGENTS: JevAgent[] = [
  { id: "agent-codex", name: "CodexCoder", role: "engineer", title: "Senior Product Engineer", owns: "Product engineering: bugs and features in the app and API.", reportsTo: "agent-cto", createdAt: "2026-04-02T09:00:00Z" },
  { id: "agent-design-system", name: "DesignSystemCoder", role: "designer", title: "Design System Engineer", owns: "UI, UX, visual polish, and the design system.", reportsTo: "agent-cto", createdAt: "2026-04-06T09:00:00Z" },
  { id: "agent-qa", name: "QAChecker", role: "qa", title: "QA Engineer", owns: "Verification, reproduction, and release testing.", reportsTo: "agent-cto", createdAt: "2026-04-03T09:00:00Z" },
  { id: "agent-cto", name: "CTO", role: "cto", title: "CTO", owns: "Architecture decisions and open-ended technical questions.", reportsTo: null, createdAt: "2026-04-01T09:00:00Z" },
  { id: "agent-darnold", name: "Darnold", role: "general", title: "Chief of Staff", owns: "Coordination, admin, and operational follow-ups.", reportsTo: null, createdAt: "2026-04-10T09:00:00Z" },
];

export type JevProject = { id: string; name: string; description: string };

export const JEV_PROJECTS: JevProject[] = [
  { id: "project-board-ui", name: "Board UI", description: "The operator-facing web app: pages, dialogs, inbox, mobile." },
  { id: "project-agent-runtime", name: "Agent Runtime", description: "Adapters, heartbeats, runners, and agent sessions." },
  { id: "project-budget-guardrails", name: "Budget Guardrails", description: "Spend limits, cost tracking, and billing." },
];

export const JEV_NO_PROJECT = "none";

// ---------------------------------------------------------------------------
// Request builder: this is what a server would send to OpenRouter.

export function buildJevDecisionRequest(prompt: string, agents: JevAgent[] = JEV_AGENTS): JevDecisionRequest {
  // Paused agents can't take work, so Jev never sees them as options.
  const available = agents.filter((agent) => !agent.paused);
  return {
    model: JEV_MODEL,
    state: {
      task_prompt: prompt,
      agents: available.map(({ id, name, title, owns }) => ({ id, name, title, owns })),
      projects: JEV_PROJECTS.map(({ id, name, description }) => ({ id, name, description })),
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
        criteria: Object.fromEntries(available.map((agent) => [agent.id, `${agent.name}, ${agent.title}. ${agent.owns}`])),
      },
      project: {
        type: "choice",
        instructions: "Which project does this task belong to?",
        criteria: {
          ...Object.fromEntries(JEV_PROJECTS.map((project) => [project.id, project.description])),
          [JEV_NO_PROJECT]: "None of the projects fit.",
        },
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

const PROJECT_KEYWORDS: Record<string, string[]> = {
  "project-board-ui": ["ui", "board", "dashboard", "page", "button", "dialog", "sidebar", "inbox", "screen", "mobile", "login", "storybook"],
  "project-agent-runtime": ["agent", "runtime", "heartbeat", "adapter", "wake", "codex", "claude", "runner", "session"],
  "project-budget-guardrails": ["budget", "spend", "cost", "billing", "limit", "invoice", "quota"],
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

  const projectScores: Record<string, number> = {
    ...Object.fromEntries(Object.entries(PROJECT_KEYWORDS).map(([id, keywords]) => [id, score(text, keywords)])),
    [JEV_NO_PROJECT]: 0.5,
  };

  const isQuestion = /\?\s*$/.test(prompt.trim()) || (/^(how|why|what|which|should|is|are|can|does)\b/.test(text) && !/^(can|could|would) you\b/.test(text));
  const isLarge = /\b(plan|roadmap|migrate|migration|redesign|rewrite|overhaul|multi-step|phases?)\b/.test(text);
  const isInvestigation = /^(investigate|research|find out|figure out|look into|compare|evaluate)\b/.test(text);
  const modeScores = { standard: 1, planning: isLarge ? 3 : 0, ask: isQuestion ? 3 : isInvestigation ? 1.6 : 0 };

  const inputTokens = 380 + Math.round(prompt.length / 4);
  return {
    model: request.model,
    answers: {
      work_mode: choiceAnswer(softmax(modeScores)),
      assignee: choiceAnswer(assigneeProbabilities),
      project: choiceAnswer(softmax(projectScores, 2.4)),
    },
    // Output tokens are free on Jev; $0.042 per million input tokens.
    usage: { input_tokens: inputTokens, output_tokens: 0, cost: (inputTokens * 0.042) / 1_000_000 },
  };
}

// ---------------------------------------------------------------------------
// What the composer consumes

export type JevField = "workMode" | "assignee" | "project";

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
  projectId: string | null;
  confidence: Record<JevField, number>;
  probabilities: Record<JevField, Record<string, number>>;
  /** Jev's likely owners other than the one assigned, offered when Jev is unsure. */
  alternateAssigneeIds: string[];
  usage: JevDecisionResponse["usage"];
};

export function routingFromJev(response: JevDecisionResponse, agents: JevAgent[] = JEV_AGENTS): JevRouting {
  const { work_mode: mode, assignee, project } = response.answers as Record<string, JevChoiceAnswer>;
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
    projectId: project!.choice === JEV_NO_PROJECT ? null : project!.choice,
    confidence: { workMode: mode!.confidence, assignee: assignee!.confidence, project: project!.confidence },
    probabilities: { workMode: mode!.probabilities, assignee: assignee!.probabilities, project: project!.probabilities },
    alternateAssigneeIds,
    usage: response.usage,
  };
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
