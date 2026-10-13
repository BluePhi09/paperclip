import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRecoveryActions, issueRelations } from "@paperclipai/db";

// paperclipai/paperclip#14792: recovery escalations park an issue in `blocked`
// only when something can resume it: an unresolved first-class blocker or an
// active recovery action. Otherwise they park it in `backlog` with a comment.

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  addComment: vi.fn(),
  logActivity: vi.fn(),
  upsertSourceScoped: vi.fn(),
}));

vi.mock("../issues.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../issues.js")>();
  return {
    ...actual,
    issueService: () => ({ update: mocks.update, addComment: mocks.addComment }),
  };
});

vi.mock("../activity-log.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../activity-log.js")>();
  return { ...actual, logActivity: mocks.logActivity };
});

vi.mock("../issue-recovery-actions.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../issue-recovery-actions.js")>();
  return {
    ...actual,
    issueRecoveryActionService: () => ({
      upsertSourceScoped: mocks.upsertSourceScoped,
    }),
  };
});

import { recoveryParkStatus, recoveryService } from "./service.js";

/**
 * Minimal chainable Drizzle stand-in: every query builder method returns the
 * chain, and awaiting it yields `blockerRows` for `issue_relations` reads and
 * `activeRecoveryActionRows` for `issue_recovery_actions` reads, and an empty
 * result for everything else.
 */
function fakeDb(
  blockerRows: Array<{ id: string; identifier: string | null }>,
  activeRecoveryActionRows: Array<{ id: string }> = [],
) {
  const select = () => {
    let table: unknown = null;
    const chain: Record<string, unknown> = {};
    for (const method of [
      "innerJoin",
      "leftJoin",
      "where",
      "orderBy",
      "limit",
      "for",
    ]) {
      chain[method] = () => chain;
    }
    chain.from = (t: unknown) => {
      table = t;
      return chain;
    };
    chain.then = (
      resolve: (rows: unknown[]) => unknown,
      reject?: (error: unknown) => unknown,
    ) =>
      Promise.resolve(
        table === issueRelations
          ? blockerRows
          : table === issueRecoveryActions
            ? activeRecoveryActionRows
            : [],
      ).then(
        resolve,
        reject,
      );
    return chain;
  };
  return { select } as never;
}

const baseIssue = {
  id: "issue-1",
  companyId: "company-1",
  identifier: "PAP-1",
  title: "Stranded work",
  status: "in_progress",
  assigneeAgentId: "agent-1",
  assigneeUserId: null,
  originKind: "manual",
  originId: null,
  originFingerprint: null,
  executionRunId: null,
  checkoutRunId: null,
} as never;

const latestRun = {
  id: "run-1",
  agentId: "agent-1",
  status: "failed",
  errorCode: "adapter_failed",
  error: null,
  contextSnapshot: {},
  resultJson: null,
} as never;

describe("recovery escalation park status (#14792)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.update.mockImplementation(async (_id: string, patch: object) => ({
      ...(baseIssue as object),
      ...patch,
    }));
    mocks.addComment.mockResolvedValue(null);
    mocks.logActivity.mockResolvedValue(undefined);
    mocks.upsertSourceScoped.mockResolvedValue({
      id: "action-1",
      ownerType: "board",
      ownerAgentId: null,
      previousOwnerAgentId: "agent-1",
      returnOwnerAgentId: "agent-1",
      attemptCount: 2,
      evidence: {},
    });
  });

  it("allows blocked only when a blocker or an active recovery action can wake the issue", () => {
    expect(
      recoveryParkStatus({ unresolvedBlockerIssueIds: [], hasActiveRecoveryAction: false }),
    ).toBe("backlog");
    expect(
      recoveryParkStatus({ unresolvedBlockerIssueIds: ["blocker-1"], hasActiveRecoveryAction: false }),
    ).toBe("blocked");
    expect(
      recoveryParkStatus({ unresolvedBlockerIssueIds: [], hasActiveRecoveryAction: true }),
    ).toBe("blocked");
  });

  it("keeps stranded assigned work blocked while its active recovery action can resume it", async () => {
    // e.g. a configuration_incomplete escalation waiting on an AI connection:
    // connection-intent delivery resumes the issue only from `blocked`.
    const recovery = recoveryService(fakeDb([], [{ id: "action-1" }]), {
      enqueueWakeup: vi.fn(),
    });

    await recovery.escalateStrandedAssignedIssue({
      issue: baseIssue,
      previousStatus: "in_progress",
      latestRun,
      recoveryCause: "configuration_incomplete",
    });

    expect(mocks.update).toHaveBeenCalledWith("issue-1", {
      status: "blocked",
      blockedByIssueIds: [],
    });
    expect(
      mocks.addComment.mock.calls.some(([, body]) =>
        String(body).includes("Parked in `backlog`"),
      ),
    ).toBe(false);
  });

  it("parks exhausted stranded assigned work in backlog with an explanation when nothing can wake it", async () => {
    const recovery = recoveryService(fakeDb([]), { enqueueWakeup: vi.fn() });

    await recovery.escalateStrandedAssignedIssue({
      issue: baseIssue,
      previousStatus: "in_progress",
      latestRun,
    });

    expect(mocks.update).toHaveBeenCalledTimes(1);
    const patch = mocks.update.mock.calls[0]![1];
    expect(patch.status).toBe("backlog");
    expect(patch).not.toHaveProperty("blockedByIssueIds");
    const backlogComment = mocks.addComment.mock.calls.find(([, body]) =>
      String(body).includes("Parked in `backlog`"),
    );
    expect(backlogComment?.[1]).toContain("no unresolved blocker issue and no active recovery action");
    expect(mocks.logActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        details: expect.objectContaining({ status: "backlog" }),
      }),
    );
  });

  it("keeps stranded assigned work blocked on its real unresolved blockers", async () => {
    const recovery = recoveryService(
      fakeDb([{ id: "blocker-1", identifier: "PAP-2" }]),
      { enqueueWakeup: vi.fn() },
    );

    await recovery.escalateStrandedAssignedIssue({
      issue: baseIssue,
      previousStatus: "in_progress",
      latestRun,
    });

    expect(mocks.update).toHaveBeenCalledWith("issue-1", {
      status: "blocked",
      blockedByIssueIds: ["blocker-1"],
    });
  });

  it("parks a failed stranded-recovery issue in backlog with an explanation when nothing can wake it", async () => {
    const recovery = recoveryService(fakeDb([]), { enqueueWakeup: vi.fn() });

    await recovery.escalateStrandedRecoveryIssueInPlace({
      issue: {
        ...(baseIssue as object),
        originKind: "stranded_issue_recovery",
      } as never,
      previousStatus: "in_progress",
      latestRun,
    });

    expect(mocks.update).toHaveBeenCalledWith("issue-1", { status: "backlog" });
    const body = mocks.addComment.mock.calls[0]![1];
    expect(body).toContain("move this recovery issue out of `backlog`");
    expect(body).toContain("Parked in `backlog`");
  });

  it("keeps a failed stranded-recovery issue blocked while it has an active recovery action", async () => {
    const recovery = recoveryService(fakeDb([], [{ id: "action-1" }]), {
      enqueueWakeup: vi.fn(),
    });

    await recovery.escalateStrandedRecoveryIssueInPlace({
      issue: {
        ...(baseIssue as object),
        originKind: "stranded_issue_recovery",
      } as never,
      previousStatus: "in_progress",
      latestRun,
    });

    expect(mocks.update).toHaveBeenCalledWith("issue-1", { status: "blocked" });
    expect(mocks.addComment.mock.calls[0]![1]).not.toContain("Parked in `backlog`");
  });
});
