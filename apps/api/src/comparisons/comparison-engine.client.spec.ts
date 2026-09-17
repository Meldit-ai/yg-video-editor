import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComparisonEngineClient, engineMaxUrls } from "./comparison-engine.client.js";

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
    process.env.COMPARISON_ENGINE_MAX_URLS = "10";
    expect(engineMaxUrls()).toBe(6);
  });
});

describe("ComparisonEngineClient", () => {
  let client: ComparisonEngineClient;

  beforeEach(() => {
    vi.useFakeTimers();
    client = new ComparisonEngineClient();
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

    it("rides out a transient poll failure rather than abandoning the job", async () => {
      vi.spyOn(globalThis, "fetch")
        .mockRejectedValueOnce(new Error("ECONNRESET"))
        .mockResolvedValueOnce(jsonResponse(jobPayload("failed")));

      const pending = client.waitForJob("job-1");
      await vi.advanceTimersByTimeAsync(10_000);

      await expect(pending).resolves.toMatchObject({ status: "FAILED" });
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
