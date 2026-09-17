import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pause } from "./pause.js";

describe("pause", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("resolves once the time has passed", async () => {
    let done = false;
    void pause(1_000).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
  });

  it("rejects with the abort reason when the signal fires first", async () => {
    const controller = new AbortController();
    const pending = pause(10_000, controller.signal);
    const outcome = expect(pending).rejects.toThrow(/abort/i);
    controller.abort();
    await outcome;
  });

  it("rejects immediately on a signal that is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(pause(10_000, controller.signal)).rejects.toThrow(/abort/i);
  });
});
