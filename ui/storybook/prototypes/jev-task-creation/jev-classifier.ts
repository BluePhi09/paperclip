import type { IssueWorkMode } from "@paperclipai/shared";

/**
 * Storybook-only stand-in for Jev, the assistant that reads a task prompt and
 * suggests a title, task type, owner, project, and work mode. It is a keyword
 * heuristic with simulated latency so the UX can be reviewed without a model.
 * A real implementation would replace `classifyTaskPrompt` with an API call
 * that returns the same `JevSuggestion` shape.
 */

export const JEV_NAME = "Jev";

export type JevTaskType = "bug" | "feature" | "research" | "design" | "qa" | "ops";

export const JEV_TASK_TYPES: { value: JevTaskType; label: string; hint: string }[] = [
  { value: "bug", label: "Bug", hint: "Something is broken or regressed" },
  { value: "feature", label: "Feature", hint: "Build or change product behavior" },
  { value: "research", label: "Research", hint: "Investigate, compare, or answer a question" },
  { value: "design", label: "Design", hint: "UI, UX, or visual work" },
  { value: "qa", label: "QA", hint: "Verify, test, or reproduce" },
  { value: "ops", label: "Ops", hint: "Admin, release, or coordination work" },
];

export type JevAgent = {
  id: string;
  name: string;
  role: string;
  title: string;
  paused?: boolean;
};

export const JEV_AGENTS: JevAgent[] = [
  { id: "agent-codex", name: "CodexCoder", role: "engineer", title: "Senior Product Engineer" },
  { id: "agent-design-system", name: "DesignSystemCoder", role: "designer", title: "Design System Engineer" },
  { id: "agent-qa", name: "QAChecker", role: "qa", title: "QA Engineer" },
  { id: "agent-cto", name: "CTO", role: "cto", title: "CTO" },
  { id: "agent-darnold", name: "Darnold", role: "general", title: "Chief of Staff" },
];

export type JevProject = { id: string; name: string };

export const JEV_PROJECTS: JevProject[] = [
  { id: "project-board-ui", name: "Board UI" },
  { id: "project-agent-runtime", name: "Agent Runtime" },
  { id: "project-budget-guardrails", name: "Budget Guardrails" },
];

export type JevConfidence = "high" | "medium" | "low";

export type JevSuggestion = {
  title: string;
  type: JevTaskType;
  assigneeId: string;
  /** Other plausible owners, shown when confidence is not high. */
  alternateAssigneeIds: string[];
  projectId: string | null;
  workMode: IssueWorkMode;
  confidence: JevConfidence;
  /** One short sentence per decision, shown under "Why". */
  reasons: { field: "type" | "assignee" | "project" | "mode"; text: string }[];
};

/** Prompts need a little substance before Jev starts guessing. */
export const JEV_MIN_PROMPT_LENGTH = 18;

const TYPE_KEYWORDS: Record<JevTaskType, string[]> = {
  bug: ["bug", "broken", "fix", "crash", "error", "regress", "fails", "failing", "500", "stuck", "doesn't", "does not", "not working", "wrong"],
  feature: ["add", "build", "implement", "support", "create", "new", "allow", "enable", "endpoint", "integrate", "make", "improve", "faster", "performance"],
  research: ["research", "investigate", "compare", "evaluate", "why", "how does", "figure out", "explore", "options", "should we"],
  design: ["design", "mockup", "figma", "layout", "visual", "ux", "ui polish", "spacing", "typography", "color", "icon", "prototype"],
  qa: ["test", "qa", "verify", "reproduce", "regression suite", "smoke", "e2e", "check that", "coverage"],
  ops: ["release", "deploy", "rotate", "invoice", "schedule", "onboard", "hire", "budget report", "coordinate", "follow up", "email"],
};

const TYPE_OWNER: Record<JevTaskType, string> = {
  bug: "agent-codex",
  feature: "agent-codex",
  research: "agent-cto",
  design: "agent-design-system",
  qa: "agent-qa",
  ops: "agent-darnold",
};

const TYPE_OWNER_REASON: Record<JevTaskType, string> = {
  bug: "CodexCoder owns product engineering and closed 3 similar bugs this week.",
  feature: "CodexCoder owns product engineering and has capacity today.",
  research: "The CTO handles open-ended technical questions.",
  design: "DesignSystemCoder owns UI and design-system work.",
  qa: "QAChecker runs verification and reproduction tasks.",
  ops: "Darnold, the Chief of Staff, handles coordination and admin work.",
};

const PROJECT_KEYWORDS: Record<string, string[]> = {
  "project-board-ui": ["ui", "board", "dashboard", "page", "button", "dialog", "sidebar", "inbox", "screen", "mobile", "login", "storybook"],
  "project-agent-runtime": ["agent", "runtime", "heartbeat", "adapter", "wake", "codex", "claude", "runner", "session"],
  "project-budget-guardrails": ["budget", "spend", "cost", "billing", "limit", "invoice", "quota"],
};

/** Hand-written titles for the story scenarios, so reviews read realistically. */
const CURATED_TITLES: Record<string, string> = {
  "the login page redirects": "Fix login redirect loop after session expiry",
  "add a csv export": "Add CSV export to the issues list",
  "should we move": "Evaluate moving heartbeats to a queue",
  "the new task dialog feels": "Tighten spacing in the new task dialog",
  "before friday's release": "Run release smoke tests before Friday",
  "something is off": "Investigate agent budget discrepancy",
  "rotate the": "Rotate the GitHub App private key",
  "plan the migration": "Plan phased migration of runtime sessions to the new adapter",
};

function score(prompt: string, keywords: string[]): number {
  return keywords.reduce((total, keyword) => total + (prompt.includes(keyword) ? 1 : 0), 0);
}

const FILLER = /^(hey|hi|please|pls|so|ok|okay|can you|could you|would you|i need you to|i need to|i want to|we need to|we should|let's|lets|i think|it seems like|it looks like)\b[\s,]*/i;

/** Turn free-form text into a short, imperative-ish title. */
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

export function classifyTaskPromptSync(prompt: string): JevSuggestion {
  const text = prompt.toLowerCase();
  const typeScores = (Object.keys(TYPE_KEYWORDS) as JevTaskType[])
    .map((type) => ({ type, score: score(text, TYPE_KEYWORDS[type]) }))
    .sort((a, b) => b.score - a.score);
  const best = typeScores[0]!;
  const runnerUp = typeScores[1]!;
  const type: JevTaskType = best.score === 0 ? "research" : best.type;

  const lead = best.score - runnerUp.score;
  const confidence: JevConfidence =
    best.score === 0 || lead === 0 ? "low" : lead >= 2 || runnerUp.score === 0 ? "high" : "medium";

  const projectScores = Object.entries(PROJECT_KEYWORDS)
    .map(([id, keywords]) => ({ id, score: score(text, keywords) }))
    .sort((a, b) => b.score - a.score);
  const projectId = projectScores[0]!.score > 0 ? projectScores[0]!.id : null;

  const isQuestion = /\?\s*$/.test(prompt.trim()) || (/^(how|why|what|which|should|is|are|can|does)\b/.test(text) && !/^(can|could|would) you\b/.test(text));
  const isLarge = /\b(plan|roadmap|migrate|migration|redesign|rewrite|overhaul|multi-step|phases?)\b/.test(text);
  const workMode: IssueWorkMode = isQuestion && type === "research" ? "ask" : isLarge ? "planning" : "standard";

  const assigneeId = TYPE_OWNER[type];
  const alternateAssigneeIds = confidence === "high"
    ? []
    : [TYPE_OWNER[runnerUp.type], "agent-cto"].filter((id, index, ids) => id !== assigneeId && ids.indexOf(id) === index).slice(0, 2);

  const typeLabel = JEV_TASK_TYPES.find((option) => option.value === type)!.label;
  const typeNoun = type === "qa" ? "QA" : typeLabel.toLowerCase();
  const projectName = JEV_PROJECTS.find((project) => project.id === projectId)?.name;
  const reasons: JevSuggestion["reasons"] = [
    {
      field: "type",
      text: best.score === 0
        ? `No strong signal, so ${JEV_NAME} treated it as ${typeNoun} until you say otherwise.`
        : `Reads as ${typeNoun} work${runnerUp.score > 0 && confidence !== "high" ? `, though it could be ${runnerUp.type}` : ""}.`,
    },
    { field: "assignee", text: TYPE_OWNER_REASON[type] },
  ];
  if (projectName) reasons.push({ field: "project", text: `Mentions areas covered by ${projectName}.` });
  if (workMode === "planning") reasons.push({ field: "mode", text: "Large scope, so it starts in Plan mode for your review." });
  if (workMode === "ask") reasons.push({ field: "mode", text: "It's a question, so Ask mode returns an answer without changing code." });

  return { title: draftTitle(prompt), type, assigneeId, alternateAssigneeIds, projectId, workMode, confidence, reasons };
}

export type ClassifyOptions = { latencyMs?: number; fail?: boolean; signal?: AbortSignal };

export function classifyTaskPrompt(prompt: string, { latencyMs = 900, fail = false, signal }: ClassifyOptions = {}): Promise<JevSuggestion> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      if (fail) reject(new Error(`${JEV_NAME} is unavailable right now.`));
      else resolve(classifyTaskPromptSync(prompt));
    }, latencyMs);
    signal?.addEventListener("abort", () => {
      window.clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    });
  });
}
