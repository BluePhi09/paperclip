import { FakeCodexTransport, makeDriver, WORKSPACE, describe, it, expect, vi } from "./codex-app-server-driver.test-support.js";

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

describe("Codex fresh provider operation admission", () => {
  it.each([false, true])("revalidates after async initialize, denied=%s", async denied => {
    const entered = barrier(), ready = barrier();
    class DelayedTransport extends FakeCodexTransport {
      override async request(method: string, params: Record<string, unknown>) {
        if (method === "initialize") { entered.release(); await ready.promise; }
        return super.request(method, params);
      }
    }
    const transport = new DelayedTransport();
    const close = vi.spyOn(transport, "close");
    const driver = makeDriver([transport]);
    let valid = true;
    const admission = vi.fn(async () => { if (!valid) throw new Error("evidence_pack_expired"); });
    const opening = driver.openSession({ runId: "a1", normalizedSessionId: "a1", workingDirectory: WORKSPACE, onOperationAdmission: admission })
      .then(session => ({ session, error: null }), error => ({ session: null, error }));
    await Promise.race([entered.promise, opening.then(value => { throw value.error ?? new Error("missing barrier"); })]);
    valid = !denied;
    ready.release();
    const outcome = await opening;
    const starts = transport.calls.filter(call => call.method === "thread/start");
    try {
      expect(starts).toHaveLength(denied ? 0 : 1);
      if (denied) { expect(outcome.error?.message).toBe("evidence_pack_expired"); expect(close).toHaveBeenCalledOnce(); }
      else { expect(outcome.error).toBeNull(); expect(admission).toHaveBeenCalled(); }
    } finally { await outcome.session?.close({ reason: "fixture complete" }); }
  });

  it.each([false, true])("revalidates after async recovery reads, before thread/resume, denied=%s", async denied => {
    const first = new FakeCodexTransport();
    const entered = barrier(), ready = barrier();
    class DelayedRecoveryTransport extends FakeCodexTransport {
      override async request(method: string, params: Record<string, unknown>) {
        if (method === "thread/read") { entered.release(); await ready.promise; }
        return super.request(method, params);
      }
    }
    const second = new DelayedRecoveryTransport();
    second.readResponse = { thread: { id: "thread-1", sessionId: "provider-session-1", cwd: WORKSPACE, turns: [] } };
    const close = vi.spyOn(second, "close");
    const driver = makeDriver([first, second]);
    const original = await driver.openSession({ runId: "a1-recover", normalizedSessionId: "a1-recover", workingDirectory: WORKSPACE });
    const snapshot = await original.snapshot();
    await original.close({ reason: "controller lost" });
    let valid = true;
    const admission = vi.fn(async () => { if (!valid) throw new Error("evidence_pack_expired"); });
    const recovering = driver.recoverSession!(snapshot, { signal: new AbortController().signal, onOperationAdmission: admission })
      .then(value => ({ value, error: null }), error => ({ value: null, error }));
    await Promise.race([entered.promise, recovering.then(value => { throw value.error ?? new Error("missing barrier"); })]);
    valid = !denied;
    ready.release();
    const outcome = await recovering;
    try {
      expect(second.calls.filter(call => call.method === "thread/resume")).toHaveLength(denied ? 0 : 1);
      expect(second.calls.some(call => call.method === "turn/start")).toBe(false);
      if (denied) { expect(outcome.error?.message).toBe("evidence_pack_expired"); expect(close).toHaveBeenCalled(); }
      else { expect(outcome.error).toBeNull(); expect(outcome.value).toMatchObject({ recovered: true }); expect(admission).toHaveBeenCalledOnce(); }
    } finally { await outcome.value?.session?.close({ reason: "fixture complete" }); }
  });

  // A pending server admission must not delay cancellation: abort settles the
  // recovery promptly (bootstrap cleanup) and the effectful resume never runs.
  it("recovery cancellation does not wait for a pending admission", async () => {
    const first = new FakeCodexTransport();
    const second = new FakeCodexTransport();
    second.readResponse = { thread: { id: "thread-1", sessionId: "provider-session-1", cwd: WORKSPACE, turns: [] } };
    const close = vi.spyOn(second, "close");
    const driver = makeDriver([first, second]);
    const original = await driver.openSession({ runId: "a1-cancel", normalizedSessionId: "a1-cancel", workingDirectory: WORKSPACE });
    const snapshot = await original.snapshot();
    await original.close({ reason: "controller lost" });
    const entered = barrier(), hang = barrier();
    const admission = vi.fn(async () => { entered.release(); await hang.promise; });
    const controller = new AbortController();
    const recovering = driver.recoverSession!(snapshot, { signal: controller.signal, onOperationAdmission: admission })
      .then(value => ({ value, error: null as unknown }), error => ({ value: null, error }));
    await entered.promise;
    controller.abort(new Error("run cancelled"));
    try {
      const outcome = await Promise.race([recovering, new Promise<"pending">(resolve => setTimeout(() => resolve("pending"), 1000))]);
      expect(outcome).not.toBe("pending");
      expect(second.calls.filter(call => call.method === "thread/resume")).toHaveLength(0);
      expect(close).toHaveBeenCalled();
    } finally { hang.release(); await recovering; }
  });
});
