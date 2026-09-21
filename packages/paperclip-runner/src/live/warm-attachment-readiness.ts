/** Require two fresh authenticated barriers before rotating a warm run authority. */
export async function waitForWarmAttachmentReadiness(input: {
  graceMs: number;
  waitForConnection: (deadline: number) => Promise<void>;
  snapshot: (deadline: number) => Promise<Record<string, unknown>>;
  onBlocked?: (blockers: unknown) => void;
}): Promise<void> {
  const deadline = Date.now() + input.graceMs;
  let consecutiveReadyProbes = 0;
  let lastBlockers: unknown = null;
  let blockedDelayMs = 25;
  // Each probe is a durable command. A 25 ms loop over the remote 120 second
  // reconnect budget can exhaust its 500-command journal before that budget.
  const maxBlockedDelayMs = Math.max(1_000, Math.ceil(input.graceMs / 100));
  while (Date.now() < deadline) {
    await input.waitForConnection(deadline);
    const snapshot = await input.snapshot(deadline);
    if (snapshot.warmAttachReady !== true && JSON.stringify(snapshot.warmAttachBlockers) !== JSON.stringify(lastBlockers)) {
      input.onBlocked?.(snapshot.warmAttachBlockers);
    }
    lastBlockers = snapshot.warmAttachBlockers;
    if (snapshot.warmAttachReady === true) {
      consecutiveReadyProbes += 1;
      if (consecutiveReadyProbes >= 2) return;
    } else {
      consecutiveReadyProbes = 0;
    }
    const delayMs = snapshot.warmAttachReady === true ? 25 : blockedDelayMs;
    if (snapshot.warmAttachReady !== true) blockedDelayMs = Math.min(blockedDelayMs * 2, maxBlockedDelayMs);
    await new Promise<void>(resolve => setTimeout(resolve, Math.min(delayMs, Math.max(0, deadline - Date.now()))));
  }
  throw new Error(`native_runner_warm_attachment_not_quiescent: ${JSON.stringify(lastBlockers)}`);
}
