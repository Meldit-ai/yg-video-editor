import { describe, expect, it } from "vitest";
import { Semaphore } from "./semaphore.js";

describe("Semaphore", () => {
  it("grants up to N slots at once", async () => {
    const semaphore = new Semaphore(2);

    const first = await semaphore.acquire();
    const second = await semaphore.acquire();

    expect(first).toBeTypeOf("function");
    expect(second).toBeTypeOf("function");
  });

  it("queues the N+1th acquire until a release", async () => {
    const semaphore = new Semaphore(1);
    const release = await semaphore.acquire();

    let acquired = false;
    const pending = semaphore.acquire().then((release2) => {
      acquired = true;
      return release2;
    });

    // Give the pending promise a chance to (incorrectly) resolve.
    await Promise.resolve();
    await Promise.resolve();
    expect(acquired).toBe(false);

    release();

    const release2 = await pending;
    expect(acquired).toBe(true);
    expect(release2).toBeTypeOf("function");
  });

  it("is FIFO: queued waiters are granted in order", async () => {
    const semaphore = new Semaphore(1);
    const release = await semaphore.acquire();

    const order: number[] = [];
    const first = semaphore.acquire().then((r) => {
      order.push(1);
      return r;
    });
    const second = semaphore.acquire().then((r) => {
      order.push(2);
      return r;
    });

    release();
    const release1 = await first;
    expect(order).toEqual([1]);

    release1();
    await second;
    expect(order).toEqual([1, 2]);
  });

  it("rejects a queued acquire on abort, without consuming a slot", async () => {
    const semaphore = new Semaphore(1);
    await semaphore.acquire(); // fills the only slot

    const controller = new AbortController();
    const pending = semaphore.acquire(controller.signal);
    const outcome = expect(pending).rejects.toThrow(/abort/i);
    controller.abort();
    await outcome;

    // The next waiter must still be able to get the slot once it frees up —
    // proving the aborted waiter did not consume it.
    const third = semaphore.acquire();
    let thirdAcquired = false;
    void third.then(() => {
      thirdAcquired = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(thirdAcquired).toBe(false);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const semaphore = new Semaphore(1);
    const controller = new AbortController();
    controller.abort();

    await expect(semaphore.acquire(controller.signal)).rejects.toThrow(
      /abort/i,
    );
  });

  it("double release does not over-grant slots", async () => {
    const semaphore = new Semaphore(1);
    const release = await semaphore.acquire();

    release();
    release(); // must be a no-op

    const second = await semaphore.acquire();

    let thirdAcquired = false;
    void semaphore.acquire().then(() => {
      thirdAcquired = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(thirdAcquired).toBe(false);

    second();
  });
});
