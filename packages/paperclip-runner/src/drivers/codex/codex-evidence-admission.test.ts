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
});
