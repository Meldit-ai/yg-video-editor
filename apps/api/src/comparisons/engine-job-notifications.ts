import { Injectable } from "@nestjs/common";

/**
 * How long a notification that arrives before its waiter is kept around.
 *
 * Closes a real race: the engine's callback can land before the editor's own
 * `POST /v1/compare` response does, for a sub-second cache-warm job. Ten
 * minutes is far longer than that race ever takes, and short enough that a
 * `jobId` nobody ever waits for does not linger.
 */
export const EARLY_NOTIFICATION_TTL_MS = 10 * 60 * 1000;

interface Waiter {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  onAbort: () => void;
  signal?: AbortSignal;
}

interface EarlyNotification {
  payload: unknown;
  at: number;
}

/**
 * In-process pub/sub between the engine's callback and whichever request is
 * awaiting that job's result. Pure and I/O-free: it only ever resolves,
 * rejects, or buffers in memory.
 *
 * Two paths race to use it — `notify` from the callback controller, `waitFor`
 * from the client — and the ordering in each is what makes the race safe:
 * `notify` checks for a live waiter before buffering, and `waitFor` checks
 * the buffer before registering, so whichever side runs first still hands
 * off correctly to the other.
 */
@Injectable()
export class EngineJobNotifications {
  private readonly waiters = new Map<string, Waiter>();
  private readonly early = new Map<string, EarlyNotification>();

  /** Delivers a job document to whoever is waiting, or buffers it briefly for a waiter that has not registered yet. */
  notify(jobId: string, payload: unknown): "resolved" | "buffered" {
    const waiter = this.waiters.get(jobId);
    if (waiter) {
      this.waiters.delete(jobId);
      waiter.signal?.removeEventListener("abort", waiter.onAbort);
      waiter.resolve(payload);
      return "resolved";
    }

    this.pruneEarly();
    this.early.set(jobId, { payload, at: Date.now() });
    return "buffered";
  }

  /** Resolves with the payload delivered for jobId. Checks the early buffer BEFORE registering a waiter. */
  waitFor(jobId: string, signal?: AbortSignal): Promise<unknown> {
    const buffered = this.early.get(jobId);
    if (buffered) {
      this.early.delete(jobId);
      return Promise.resolve(buffered.payload);
    }

    if (signal?.aborted) {
      return Promise.reject(signal.reason as Error);
    }

    return new Promise((resolve, reject) => {
      const existing = this.waiters.get(jobId);
      if (existing) {
        existing.signal?.removeEventListener("abort", existing.onAbort);
        existing.reject(
          new Error(
            `A new waitFor(${jobId}) replaced this one before it settled.`,
          ),
        );
      }

      const onAbort = (): void => {
        this.waiters.delete(jobId);
        reject(signal?.reason as Error);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.set(jobId, { resolve, reject, onAbort, signal });
    });
  }

  /** Drops both the waiter and any buffered payload for jobId. */
  forget(jobId: string): void {
    const waiter = this.waiters.get(jobId);
    if (waiter) {
      this.waiters.delete(jobId);
      waiter.signal?.removeEventListener("abort", waiter.onAbort);
      waiter.reject(new Error(`Notification for job ${jobId} was forgotten.`));
    }
    this.early.delete(jobId);
  }

  /** Drops buffered notifications the ten-minute TTL has passed for. */
  private pruneEarly(): void {
    const now = Date.now();
    for (const [jobId, entry] of this.early) {
      if (now - entry.at > EARLY_NOTIFICATION_TTL_MS) {
        this.early.delete(jobId);
      }
    }
  }
}
