import { Logger } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComparisonEngineClient, engineMaxUrls } from "./comparison-engine.client.js";
import { EngineJobNotifications } from "./engine-job-notifications.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A terminal job payload, as the engine's GET /v1/jobs/{id} answers it. */
function jobPayload(status: string, extra: Record<string, unknown> = {}) {
  return { job_id: "job-1", status, progress: null, result: null, ...extra };
}

describe("engineMaxUrls", () => {
  afterEach(() => {
    delete process.env.COMPARISON_ENGINE_MAX_URLS;
  });

  it("defaults to 4, the engine's own hard cap", () => {
    expect(engineMaxUrls()).toBe(4);
  });

  it("ignores a value below 2 — a job needs two URLs to compare", () => {
    process.env.COMPARISON_ENGINE_MAX_URLS = "1";
    expect(engineMaxUrls()).toBe(4);
  });

  it("honours a configured value", () => {
    process.env.COMPARISON_ENGINE_MAX_URLS = "5";
    expect(engineMaxUrls()).toBe(5);
  });

  it("never exceeds the safe pair budget, whatever the engine would accept", () => {
    process.env.COMPARISON_ENGINE_MAX_URLS = "12";
    expect(engineMaxUrls()).toBe(8);
  });
});

describe("ComparisonEngineClient", () => {
  let client: ComparisonEngineClient;

  beforeEach(() => {
    vi.useFakeTimers();
    client = new ComparisonEngineClient(new EngineJobNotifications());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe("submitWithBackoff", () => {
    it("waits out a full engine queue and submits once there is room", async () => {
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          jsonResponse(
            { error: { code: "engine_busy", message: "queue is full" } },
            503,
          ),
        )
        .mockResolvedValueOnce(jsonResponse({ job_id: "job-1" }, 202));

      const pending = client.submitWithBackoff(["u1", "u2"]);
      await vi.advanceTimersByTimeAsync(10_000);

      await expect(pending).resolves.toBe("job-1");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("retries a plain 503 — a proxy or uvicorn refusing under load, not the engine", async () => {
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(new Response("Service Unavailable", { status: 503 }))
        .mockResolvedValueOnce(new Response("Service Unavailable", { status: 503 }))
        .mockResolvedValueOnce(jsonResponse({ job_id: "job-1" }, 202));

      const pending = client.submitWithBackoff(["u1", "u2"]);
      await vi.advanceTimersByTimeAsync(15_000);

      await expect(pending).resolves.toBe("job-1");
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("retries a dropped connection rather than failing the run on one lost packet", async () => {
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValueOnce(new Error("fetch failed: ECONNRESET"))
        .mockResolvedValueOnce(jsonResponse({ job_id: "job-1" }, 202));

      const pending = client.submitWithBackoff(["u1", "u2"]);
      await vi.advanceTimersByTimeAsync(10_000);

      await expect(pending).resolves.toBe("job-1");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("throws a non-busy refusal immediately, without retrying", async () => {
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(
          jsonResponse({ error: { code: "invalid_request" } }, 422),
        );

      await expect(client.submitWithBackoff(["u1", "u2"])).rejects.toThrow(
        /HTTP 422/,
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("waitForJob", () => {
    it("polls until the job is terminal and returns it", async () => {
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(jsonResponse(jobPayload("running")))
        .mockResolvedValueOnce(
          jsonResponse(
            jobPayload("succeeded", {
              result: { engine_version: "0.6.0", videos: [], pairs: [] },
            }),
          ),
        );

      const pending = client.waitForJob("job-1");
      await vi.advanceTimersByTimeAsync(10_000);

      const job = await pending;
      expect(job.status).toBe("SUCCEEDED");
      expect(job.result?.engineVersion).toBe("0.6.0");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("returns a job the engine finished within a second after a single one-second poll", async () => {
      // Cache-warm calls finish in under a second on the engine; every
      // second of polling granularity is paid on thousands of them.
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(jsonResponse(jobPayload("succeeded")));

      const pending = client.waitForJob("job-1");
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(pending).resolves.toMatchObject({ status: "SUCCEEDED" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("keeps polling every second for the first minute, then every three", async () => {
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async () => jsonResponse(jobPayload("running")));

      const pending = client.waitForJob("job-1");
      const outcome = expect(pending).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetchMock).toHaveBeenCalledTimes(60);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(fetchMock).toHaveBeenCalledTimes(70);
      // Past the deadline the loop throws; let it, so the test does not leak.
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      await outcome;
    });

    it("rides out a transient poll failure rather than abandoning the job", async () => {
      vi.spyOn(globalThis, "fetch")
        .mockRejectedValueOnce(new Error("ECONNRESET"))
        .mockResolvedValueOnce(jsonResponse(jobPayload("failed")));

      const pending = client.waitForJob("job-1");
      await vi.advanceTimersByTimeAsync(10_000);

      await expect(pending).resolves.toMatchObject({ status: "FAILED" });
    });

    it("rides out a minute of refused polls, backing off while it waits", async () => {
      const startedAt = Date.now();
      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        // Refused for the first 50 seconds, then the job is there.
        if (Date.now() - startedAt < 50_000) {
          return new Response("Service Unavailable", { status: 503 });
        }
        return jsonResponse(jobPayload("succeeded"));
      });

      const pending = client.waitForJob("job-1");
      await vi.advanceTimersByTimeAsync(60_000);

      await expect(pending).resolves.toMatchObject({ status: "SUCCEEDED" });
      // Backed off to the slow interval while failing: far fewer than one poll a second.
      expect(fetchMock.mock.calls.length).toBeLessThan(30);
    });

    it("gives up on a job whose polls have failed for a whole minute", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("Service Unavailable", { status: 503 }),
      );

      let settled: string | null = null;
      const pending = client.waitForJob("job-1").then(
        () => (settled = "resolved"),
        (error: Error) => (settled = error.message),
      );

      await vi.advanceTimersByTimeAsync(30_000);
      expect(settled).toBeNull(); // half a minute of refusals is not yet a dead job

      await vi.advanceTimersByTimeAsync(60_000);
      await pending;
      expect(settled).toMatch(/HTTP 503/);
    });

    it("gives up once the deadline passes", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
        jsonResponse(jobPayload("running")),
      );

      const pending = client.waitForJob("job-1", { maxWaitMs: 20_000 });
      // Assert first so a rejection while the clock advances is not unhandled.
      const outcome = expect(pending).rejects.toThrow(/did not finish/);
      await vi.advanceTimersByTimeAsync(30_000);
      await outcome;
    });

    it("stops when the caller aborts", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
        jsonResponse(jobPayload("running")),
      );
      const controller = new AbortController();

      const pending = client.waitForJob("job-1", { signal: controller.signal });
      const outcome = expect(pending).rejects.toThrow(/abort/i);
      await vi.advanceTimersByTimeAsync(1_000);
      controller.abort();
      await vi.advanceTimersByTimeAsync(10_000);
      await outcome;
    });
  });
});

describe("callback mode", () => {
  let client: ComparisonEngineClient;
  let notifications: EngineJobNotifications;

  beforeEach(() => {
    vi.useFakeTimers();
    process.env.API_PUBLIC_URL = "https://editor.example/";
    vi.spyOn(Math, "random").mockReturnValue(0.5); // jitter factor exactly 1.0
    notifications = new EngineJobNotifications();
    client = new ComparisonEngineClient(notifications);
  });

  afterEach(() => {
    delete process.env.API_PUBLIC_URL;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("submit sends callback_url built from the base URL", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => jsonResponse({ job_id: "job-1" }, 202));

    await client.submit(["u1", "u2"]);
    const [, withCallback] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(withCallback.body as string)).toMatchObject({
      callback_url: "https://editor.example/api/comparisons/engine-callback",
    });

    delete process.env.API_PUBLIC_URL;
    await client.submit(["u1", "u2"]);
    const [, withoutCallback] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(withoutCallback.body as string)).not.toHaveProperty("callback_url");
  });

  it("waitForJob resolves from a notification with zero fetches", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const pending = client.waitForJob("job-1");
    notifications.notify("job-1", jobPayload("succeeded"));

    await expect(pending).resolves.toMatchObject({ status: "SUCCEEDED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a notification buffered before waitForJob resolves it without a fetch", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    notifications.notify("job-1", jobPayload("succeeded"));
    const pending = client.waitForJob("job-1");

    await expect(pending).resolves.toMatchObject({ status: "SUCCEEDED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an unparseable notification triggers exactly one GET", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(jobPayload("succeeded")));

    const pending = client.waitForJob("job-1");
    notifications.notify("job-1", { nonsense: true });

    await expect(pending).resolves.toMatchObject({ status: "SUCCEEDED" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("first fallback poll lands at 60 s", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(jobPayload("running")));

    client.waitForJob("job-1").catch(() => {});

    await vi.advanceTimersByTimeAsync(59_000);
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("then 120 s and 180 s steps", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => jsonResponse(jobPayload("running")));

    client.waitForJob("job-1").catch(() => {});

    await vi.advanceTimersByTimeAsync(61_000); // first poll, at 60 s
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(120_000); // second poll, at +120 s
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(180_000); // third poll, at +180 s
    expect(fetchMock).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(180_000); // schedule's last entry repeats
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("at most four fallback polls are in flight across jobs", async () => {
    const releasers: Array<(response: Response) => void> = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          releasers.push(resolve);
        }),
    );

    const jobIds = ["job-1", "job-2", "job-3", "job-4", "job-5", "job-6"];
    for (const jobId of jobIds) {
      client.waitForJob(jobId).catch(() => {});
    }

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    const inFlight = releasers.splice(0, releasers.length);
    inFlight.forEach((resolve) => resolve(jsonResponse(jobPayload("running"))));
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("a stale fallback fetch in flight when a notification wins never reaches onProgress", async () => {
    let releaseFetch: ((response: Response) => void) | null = null;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          releaseFetch = resolve;
        }),
    );
    const onProgress = vi.fn();

    const pending = client.waitForJob("job-1", { onProgress });

    // First fallback poll fires at 60 s; its GET is left in flight (the mock
    // never resolves on its own), matching a slow request racing a callback.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(releaseFetch).not.toBeNull();

    // The callback wins the race while that GET is still outstanding.
    notifications.notify("job-1", jobPayload("succeeded"));
    await expect(pending).resolves.toMatchObject({ status: "SUCCEEDED" });

    // Only now does the stale GET resolve, with a non-terminal job.
    releaseFetch!(jsonResponse(jobPayload("running")));
    await vi.advanceTimersByTimeAsync(0);

    expect(onProgress).not.toHaveBeenCalled();
  });

  it("deadline still throws", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse(jobPayload("running")));

    const pending = client.waitForJob("job-1", { maxWaitMs: 5 * 60_000 });
    const outcome = expect(pending).rejects.toThrow(/did not finish/);
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    await outcome;
  });

  it("abort stops both branches and forgets the job", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(jobPayload("running")));
    const controller = new AbortController();

    const pending = client.waitForJob("job-1", { signal: controller.signal });
    const outcome = expect(pending).rejects.toThrow(/abort/i);
    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort();
    await outcome;

    expect(notifications.notify("job-1", jobPayload("succeeded"))).toBe("buffered");
  });

  it("warns when the fallback poll wins the race — no callback arrived", async () => {
    const warnSpy = vi.spyOn(Logger.prototype, "warn");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(jobPayload("succeeded")));

    const pending = client.waitForJob("job-1");
    await vi.advanceTimersByTimeAsync(60_000);

    await expect(pending).resolves.toMatchObject({ status: "SUCCEEDED" });
    expect(warnSpy).toHaveBeenCalledWith(
      "Job job-1 finished via fallback poll — no callback arrived; check API_PUBLIC_URL / COMPARISON_ENGINE_CALLBACK_SECRET and the engine's callback.last_error",
    );
  });

  it("does not warn when the notification wins the race", async () => {
    const warnSpy = vi.spyOn(Logger.prototype, "warn");
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const pending = client.waitForJob("job-1");
    notifications.notify("job-1", jobPayload("succeeded"));

    await expect(pending).resolves.toMatchObject({ status: "SUCCEEDED" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("fallback poll"));
  });

  it("callback mode off leaves the poll loop untouched", async () => {
    delete process.env.API_PUBLIC_URL;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(jobPayload("succeeded")));

    const pending = client.waitForJob("job-1");
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(pending).resolves.toMatchObject({ status: "SUCCEEDED" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
