import { expect, type Route } from "@playwright/test";
import type { RunnerApi } from "./api.js";
import { readChatOutputDocument, sendChatMessage, type ChatFlowInput, type ChatIssue, type ChatRun } from "./chat-flow.js";

type Agent = {
  id: string; name: string; reportsTo?: string; adapterType?: string;
  adapterConfig?: Record<string, unknown>; runtimeConfig?: Record<string, unknown>;
};
type Comment = { id: string; body: string; authorAgentId?: string; clientRequestId?: string };
type Document = { id: string; body: string; latestRevisionId: string; createdByAgentId?: string };

export function assertChatHire(input: {
  agents: Agent[]; leadId: string; hireName: string; hiredId?: string;
  connectionId: string; binding: unknown; taskIds: string[]; tasks: ChatIssue[]; runs: ChatRun[];
}) {
  const hires = input.agents.filter(agent => agent.name === input.hireName);
  expect(hires).toHaveLength(1);
  const hired = hires[0]!;
  const lead = input.agents.find(agent => agent.id === input.leadId)!;
  expect(input.connectionId).toBeTruthy();
  expect(hired).toMatchObject({ reportsTo: input.leadId, adapterType: "paperclip_runner" });
  if (input.hiredId) expect(hired.id).toBe(input.hiredId);
  expect(hired.adapterConfig?.model).toBe(lead.adapterConfig?.model);
  expect(hired.runtimeConfig?.aiConnection).toEqual(input.binding);
  expect(input.tasks.map(task => task.id).sort()).toEqual([...input.taskIds].sort());
  for (const id of input.taskIds) {
    const task = input.tasks.find(task => task.id === id)!;
    expect(task).toMatchObject({ status: "done", assigneeAgentId: hired.id, parentId: null });
    expect(task.projectId).toBeTruthy();
    const runs = input.runs.filter(run => run.contextSnapshot?.issueId === id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ agentId: hired.id, status: "succeeded", runtimeMode: "native" });
    expect(runs[0]!.contextSnapshot?.aiConnection).toMatchObject({ connectionId: input.connectionId });
  }
  return hired;
}

export function assertGroundedChatStatus(input: {
  reply: string; expectedIssueIdentifier: string; blocker: string; staleBlocker: string;
  before: ChatIssue; after: ChatIssue; taskIdsBefore: string[]; taskIdsAfter: string[]; taskRuns: ChatRun[];
}) {
  expect(input.reply).toContain(input.expectedIssueIdentifier);
  expect(input.reply).toMatch(/blocked/i);
  expect(input.reply).toContain(input.blocker);
  expect(input.reply).not.toContain(input.staleBlocker);
  expect(input.after).toMatchObject({ id: input.before.id, status: "blocked", assigneeAgentId: input.before.assigneeAgentId });
  expect([...input.taskIdsAfter].sort()).toEqual([...input.taskIdsBefore].sort());
  expect(input.taskRuns).toHaveLength(0);
}

export function assertChatSourceReview(body: string, expected: { planLaunchDay: string; briefLaunchDay: string }) {
  // The user requests JSON, so an independent parser grades the actual saved
  // deliverable. A claim in the chat or a copied source document cannot pass.
  const json = body.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  expect(JSON.parse(json)).toMatchObject({ ...expected, consistent: expected.planLaunchDay === expected.briefLaunchDay });
}

export function assertCommittedSendRetry(input: {
  commentId: string; clientRequestId: string; comments: Comment[]; taskId: string;
  tasks: ChatIssue[]; runs: ChatRun[]; chatId: string;
}) {
  expect(input.comments.filter(comment => comment.clientRequestId === input.clientRequestId).map(comment => comment.id)).toEqual([input.commentId]);
  expect(input.tasks.map(task => task.id)).toEqual([input.taskId]);
  expect(input.tasks[0]).toMatchObject({ status: "backlog", parentId: null });
  expect(input.runs.filter(run => run.contextSnapshot?.issueId === input.taskId)).toHaveLength(0);
  const original = input.runs.filter(run => run.contextSnapshot?.wakeCommentId === input.commentId ||
    (Array.isArray(run.contextSnapshot?.wakeCommentIds) && run.contextSnapshot.wakeCommentIds.includes(input.commentId)));
  expect(original).toHaveLength(1);
  expect(original[0]).toMatchObject({ status: "succeeded", runtimeMode: "native" });
  expect(original[0]!.contextSnapshot?.issueId).toBe(input.chatId);
}

export function isChatStopReady(events: Array<{ eventType?: unknown }>, phase: "startup" | "active"): boolean {
  const active = events.some(event => ["turn.started", "turn.accepted"].includes(String(event.eventType)));
  return phase === "active" ? active : !active && events.some(event => event.eventType === "native.process_start_requested");
}

export async function runChatHardeningFlow(context: {
  input: ChatFlowInput; marker: string; issue(): ChatIssue;
  turn(message: string, count: number): Promise<void>; idle(count: number): Promise<void>;
  tasks(): Promise<ChatIssue[]>; allRuns(): Promise<ChatRun[]>; comments(): Promise<Comment[]>;
}) {
  const { input, marker, turn, idle, tasks, allRuns, comments } = context;
  const { api, page, fixtures: f, execution, nonce } = input;
  const companyPath = `/api/companies/${f.company.id}`;
  const project = await api.post<{ id: string; name: string }>(`${companyPath}/projects`, {
    name: `Chat coordination ${nonce}`, description: "Repository-free launch planning and review.",
  });
  const agents = () => api.get<Agent[]>(`${companyPath}/agents`);
  const latestReply = async () => (await comments()).filter(comment => comment.authorAgentId === f.agent.id).at(-1)?.body ?? "";
  const output = (id: string, token: string) => readChatOutputDocument(api, id, token);

  if (execution.task.id === "hire-delegate-reuse") {
    const hireName = `Morgan Reviewer ${nonce}`;
    await turn(`Hire exactly one teammate named ${hireName}, reporting to you, using your native runner, model, and available AI connection. Have that teammate write a concise launch checklist as a saved Paperclip document containing ${marker}. Put the work in one assigned task in ${project.name}. Link it here and let the teammate complete it.`, 2);
    const first = (await tasks())[0]!;
    expect(first).toBeTruthy();
    const firstOutput = await output(first.id, marker);
    const account = f.aiConnection!;
    const hired = assertChatHire({ agents: await agents(), leadId: f.agent.id, hireName,
      connectionId: account.connectionId, binding: account.binding, taskIds: [first.id], tasks: await tasks(), runs: await allRuns() });
    expect((firstOutput as Document).createdByAgentId).toBe(hired.id);
    await turn(`Have the existing ${hireName} review the checklist on ${first.identifier} and write a separate saved review document containing REVIEW${marker}. Create one review task in ${project.name}, assigned to that same teammate. Include the actual checklist in the handoff so they can review it. Preserve the original checklist and task.`, 4);
    const observed = await tasks();
    const second = observed.find(task => task.id !== first.id)!;
    expect(second).toBeTruthy();
    const reviewOutput = await output(second.id, `REVIEW${marker}`);
    expect((reviewOutput as Document).createdByAgentId).toBe(hired.id);
    expect(await api.get(`/api/issues/${first.id}/documents/${encodeURIComponent(firstOutput.key)}`)).toEqual(firstOutput);
    await turn(`Give me a brief status update on ${first.identifier} and ${second.identifier}: identify their owner and recorded status. Do not create or change work.`, 5);
    assertChatHire({ agents: await agents(), leadId: f.agent.id, hireName, hiredId: hired.id,
      connectionId: account.connectionId, binding: account.binding, taskIds: [first.id, second.id], tasks: await tasks(), runs: await allRuns() });
    const reply = await latestReply();
    expect(reply).toContain(first.identifier!); expect(reply).toContain(second.identifier!);
    expect(reply).toContain(hireName); expect(reply).toMatch(/done|completed/i);
    await input.evidence("chat-hire-reuse.json", { agents: await agents(), tasks: await tasks(), firstOutput, reviewOutput, runs: await allRuns() });
  } else if (execution.task.id === "blocked-status-review") {
    const blocker = `VENUE${marker}`, staleBlocker = `BUDGET${marker}`;
    const source = await api.post<ChatIssue>(`${companyPath}/issues`, {
      title: `Launch brief ${nonce}`, status: "blocked", projectId: project.id,
      description: "The launch brief is waiting for its recorded blocker to be resolved.",
      initialPlan: "The approved launch day is Tuesday.",
    });
    const docResponse = await api.request.put(`/api/issues/${source.id}/documents/brief`, {
      data: { title: "Launch brief", format: "markdown", body: "The launch brief schedules the launch for Wednesday." },
    });
    expect(docResponse.ok()).toBe(true);
    const sourcePlan = await api.get<Document>(`/api/issues/${source.id}/documents/plan`);
    const sourceBrief = await api.get<Document>(`/api/issues/${source.id}/documents/brief`);
    await api.post(`/api/issues/${source.id}/comments`, { body: `Earlier blocker: ${staleBlocker}. Waiting for the budget.` });
    await api.post(`/api/issues/${source.id}/comments`, { body: `Budget is resolved. Current blocker: ${blocker}. Waiting for the venue confirmation. Keep this task blocked; no execution is active.` });
    await turn(`What is the actual current blocker on ${source.identifier}? Read the latest recorded explanation, include its exact blocker label, and distinguish task status from active execution. Just report; do not change it or create work.`, 1);
    assertGroundedChatStatus({ reply: await latestReply(), expectedIssueIdentifier: source.identifier!, blocker, staleBlocker,
      before: source, after: await api.get(`/api/issues/${source.id}`), taskIdsBefore: [source.id],
      taskIdsAfter: (await tasks()).map(task => task.id), taskRuns: (await allRuns()).filter(run => run.contextSnapshot?.issueId === source.id) });
    const config = execution.profile.buildAgent({ environmentId: f.environment.id, environmentFixtureId: execution.environment.id,
      workspacePath: input.workspacePath, secretRefs: f.secretRefs, executionId: nonce });
    const reviewer = await api.post<Agent>(`${companyPath}/agents`, { ...config, name: `Riley Reviewer ${nonce}`, role: "engineer", reportsTo: f.agent.id });
    await turn(`Have ${reviewer.name} review the saved brief on ${source.identifier} against that task's saved plan, in one separate task in ${project.name}. Give the reviewer both source documents. They should save a JSON review document with planLaunchDay, briefLaunchDay, and a boolean consistent, then complete the review task. Preserve the source task and both documents.`, 3);
    const review = (await tasks()).find(task => task.id !== source.id)!;
    expect(review).toMatchObject({ status: "done", assigneeAgentId: reviewer.id, parentId: null, projectId: project.id });
    const document = await output(review.id, "planLaunchDay");
    assertChatSourceReview(document.body, { planLaunchDay: "Tuesday", briefLaunchDay: "Wednesday" });
    expect((document as Document).createdByAgentId).toBe(reviewer.id);
    const reviewRuns = (await allRuns()).filter(run => run.contextSnapshot?.issueId === review.id);
    expect(reviewRuns).toHaveLength(1);
    expect(reviewRuns[0]).toMatchObject({ agentId: reviewer.id, status: "succeeded", runtimeMode: "native" });
    await turn(`Summarize ${review.identifier}'s recorded review result and tell me whether ${source.identifier} is still blocked. Read the saved evidence; do not change or create work.`, 4);
    const reply = await latestReply();
    expect(reply).toContain("Tuesday"); expect(reply).toContain("Wednesday"); expect(reply).toContain(source.identifier!); expect(reply).toMatch(/blocked/i);
    expect((await tasks()).map(task => task.id).sort()).toEqual([source.id, review.id].sort());
    expect(await api.get(`/api/issues/${source.id}/documents/plan`)).toEqual(sourcePlan);
    expect(await api.get(`/api/issues/${source.id}/documents/brief`)).toEqual(sourceBrief);
    expect(await api.get(`/api/issues/${source.id}`)).toMatchObject({ status: "blocked" });
    await input.evidence("chat-status-review.json", { source, sourcePlan, sourceBrief, review, document, reviewRuns, reply });
  } else if (execution.task.id === "committed-send-retry") {
    let sent: { path: string; data: Record<string, unknown>; commentId: string } | undefined;
    let abortResponse!: () => void;
    const responseMayDrop = new Promise<void>(resolve => { abortResponse = resolve; });
    const handler = async (route: Route) => {
      if (route.request().method() !== "POST") return route.continue();
      const data = route.request().postDataJSON() as Record<string, unknown>;
      if (typeof data.body !== "string" || !data.body.includes(marker) || sent) return route.continue();
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      const comment = await response.json() as { id: string };
      sent = { path: new URL(route.request().url()).pathname, data, commentId: comment.id };
      await responseMayDrop;
      await route.abort("connectionreset");
    };
    await page.route("**/api/issues/*/comments", handler);
    try {
      await sendChatMessage(page, `Create exactly one task titled Later ${nonce} in ${project.name}, assigned to yourself, in backlog. Save an initial plan containing ${marker}. Do not start it. Link the task here.`);
      await idle(1); // The server and real agent complete while the browser acknowledgement is withheld.
      expect(sent).toBeTruthy();
      const saved = (await tasks())[0]!;
      expect(saved).toBeTruthy();
      const plan = await api.get<Document>(`/api/issues/${saved.id}/documents/plan`);
      expect(plan.body).toContain(marker);
      abortResponse();
      await page.unroute("**/api/issues/*/comments", handler);
      await input.restart();
      // Replay the exact interrupted public request, including its original key.
      // This tests transport retries, not automatic replay of a failed provider turn.
      const retried = await api.post<Comment>(sent!.path, sent!.data);
      expect(retried.id).toBe(sent!.commentId);
      await page.goto(`/${f.company.issuePrefix}/chats/${f.agent.id}`, { waitUntil: "domcontentloaded" });
      await turn(`What is the saved status of ${saved.identifier}? Just report it; do not create or change work.`, 2);
      assertCommittedSendRetry({ commentId: sent!.commentId, clientRequestId: String(sent!.data.clientRequestId),
        comments: await comments(), taskId: saved.id, tasks: await tasks(), runs: await allRuns(), chatId: context.issue().id });
      expect(await api.get(`/api/issues/${saved.id}/documents/plan`)).toEqual(plan);
      expect(await latestReply()).toMatch(/backlog/i);
      await input.evidence("chat-committed-send-retry.json", { commentId: sent!.commentId, task: saved, plan, runs: await allRuns() });
    } finally {
      abortResponse();
      await page.unroute("**/api/issues/*/comments", handler);
    }
  } else throw new Error(`Unsupported chat hardening case ${execution.task.id}`);
}
