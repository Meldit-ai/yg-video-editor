import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EARLY_NOTIFICATION_TTL_MS, EngineJobNotifications } from "./engine-job-notifications.js";

describe("EngineJobNotifications", () => {
  let notifications: EngineJobNotifications;

  beforeEach(() => {
    notifications = new EngineJobNotifications();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves a registered waiter and notify() returns \"resolved\"", async () => {
    const waiting = notifications.waitFor("job-1");

    const outcome = notifications.notify("job-1", { status: "succeeded" });
    expect(outcome).toBe("resolved");

    await expect(waiting).resolves.toEqual({ status: "succeeded" });
  });

  it("buffers a notification sent before waitFor, and notify() returns \"buffered\"", async () => {
    const outcome = notifications.notify("job-2", { status: "succeeded" });
    expect(outcome).toBe("buffered");

    // Resolves immediately, with no timers involved.
    await expect(notifications.waitFor("job-2")).resolves.toEqual({
      status: "succeeded",
    });
  });

  it("prunes buffered payloads older than the early-notification TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    notifications.notify("stale-job", { status: "stale" });

    vi.setSystemTime(EARLY_NOTIFICATION_TTL_MS + 1);
    // Buffering a new entry sweeps out anything past the TTL.
    expect(notifications.notify("other-job", { status: "fresh" })).toBe(
      "buffered",
    );

    // The stale buffer is gone: waitFor now registers a live waiter instead
    // of resolving immediately from a (pruned) buffer.
    const waiting = notifications.waitFor("stale-job");
    let settled: unknown;
    void waiting.then((value) => {
      settled = value;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBeUndefined();

    // Confirm it really is a live waiter: notify() resolves it directly.
    expect(notifications.notify("stale-job", { status: "new" })).toBe(
      "resolved",
    );
    await expect(waiting).resolves.toEqual({ status: "new" });
  });

  it("rejects the waiter with the abort reason and forgets it", async () => {
    const controller = new AbortController();
    const waiting = notifications.waitFor("job-3", controller.signal);
    const outcome = expect(waiting).rejects.toThrow(/abort/i);
    controller.abort();
    await outcome;

    // The waiter was forgotten: a later notify buffers rather than resolving.
    expect(notifications.notify("job-3", { status: "succeeded" })).toBe(
      "buffered",
    );
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      notifications.waitFor("job-4", controller.signal),
    ).rejects.toThrow(/abort/i);
  });

  it("forget drops both the pending waiter (rejecting it) and any buffer", async () => {
    const waiting = notifications.waitFor("job-5");
    const outcome = expect(waiting).rejects.toBeDefined();
    notifications.forget("job-5");
    await outcome;

    // Buffered payload is also dropped.
    notifications.notify("job-6", { status: "succeeded" });
    notifications.forget("job-6");
    let resolved = false;
    void notifications.waitFor("job-6").then(() => {
      resolved = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);
  });

  it("waitFor checks the early buffer before registering — no waiter left behind", async () => {
    notifications.notify("job-7", { status: "succeeded" });
    await notifications.waitFor("job-7");

    // If a waiter had been registered too, a second notify would resolve it
    // again — but there should be nothing left to resolve.
    expect(notifications.notify("job-7", { status: "succeeded" })).toBe(
      "buffered",
    );
  });
});
