/**
 * `setTimeout` as a promise, with an abort signal.
 *
 * `node:timers/promises` already offers this, and is not used on purpose:
 * vitest's fake timers patch the global `setTimeout` but not that module, so
 * a loop that sleeps through it cannot be tested without waiting in real
 * time. Building on the global keeps every back-off and poll loop fakeable.
 *
 * Rejects with the signal's reason (an `AbortError` by default) so a caller
 * that was stopped can tell that apart from a genuine failure.
 */
export function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason as Error);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason as Error);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
