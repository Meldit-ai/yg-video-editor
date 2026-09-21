/** A queued acquirer, granted a slot (or dropped on abort) in FIFO order. */
interface Waiter {
  grant: () => void;
  signal?: AbortSignal;
  onAbort: () => void;
}

/**
 * Caps how many callers hold a slot at once; anyone past the cap queues
 * FIFO for the next release.
 *
 * Mirrors `pause.ts`'s abort idiom: an already-aborted signal rejects at
 * once, and aborting while queued rejects with `signal.reason`, removes the
 * waiter, and does not consume a slot — the next waiter in line gets it
 * instead.
 */
export class Semaphore {
  private available: number;
  private readonly queue: Waiter[] = [];

  constructor(slots: number) {
    this.available = slots;
  }

  /** Resolves with a release function once a slot is free. FIFO. */
  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      return Promise.reject(signal.reason as Error);
    }

    if (this.available > 0) {
      this.available -= 1;
      return Promise.resolve(this.makeRelease());
    }

    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        grant: () => resolve(this.makeRelease()),
        signal,
        onAbort: () => {
          const index = this.queue.indexOf(waiter);
          if (index === -1) return;
          this.queue.splice(index, 1);
          reject(signal?.reason as Error);
        },
      };
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      this.queue.push(waiter);
    });
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release();
    };
  }

  private release(): void {
    const next = this.queue.shift();
    if (!next) {
      this.available += 1;
      return;
    }
    next.signal?.removeEventListener("abort", next.onAbort);
    next.grant();
  }
}
