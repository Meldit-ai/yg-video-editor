import { ComparisonStatus, ComparisonVerdict } from "@repo/database";
import { describe, expect, it } from "vitest";
import {
  isTerminal,
  parseJob,
  parseSubmitResponse,
  verdictFromScore,
} from "./comparison-engine.types.js";

/**
 * The engine is a separate service, so these are the tests that matter most:
 * everything here is about what happens when it sends something we did not
 * expect. The payloads are trimmed from a real `GET /v1/jobs/{id}` response.
 */

/** A terminal job over two videos that matched nothing. */
function succeededJob(overrides: Record<string, unknown> = {}): unknown {
  return {
    job_id: "8caa3696",
    status: "succeeded",
    progress: { stage: "done", pairs_done: 1, pairs_total: 1 },
    result: {
      engine_version: "0.6.0",
      pairs: [
        {
          a: "http:dd68d51e",
          b: "http:1f5ea660",
          score: 1.0,
          verdict: "no_match",
          containment: 0.0,
          evidence: { tiers: { winning_tier: "pdq_sw" } },
        },
      ],
      videos: [
        {
          key: "http:dd68d51e",
          url: "https://meldit.fsn1.your-objectstorage.com/campaigns/c1/a.mp4",
          status: "ready",
          duration_s: 28.813107,
          fps: 30,
        },
        {
          key: "http:1f5ea660",
          url: "https://meldit.fsn1.your-objectstorage.com/campaigns/c1/b.mp4",
          status: "ready",
          duration_s: 27.646708,
          fps: 30,
        },
      ],
    },
    error: null,
    ...overrides,
  };
}

describe("parseSubmitResponse", () => {
  it("takes the job id", () => {
    expect(parseSubmitResponse({ job_id: "abc", status: "queued" })).toBe("abc");
  });

  it("rejects a response with no job id, since there is nothing to poll", () => {
    expect(() => parseSubmitResponse({ status: "queued" })).toThrow(/job_id/);
    expect(() => parseSubmitResponse({ job_id: "   " })).toThrow(/job_id/);
    expect(() => parseSubmitResponse("queued")).toThrow(/job_id/);
  });
});

describe("verdictFromScore", () => {
  it("maps the engine's own bands", () => {
    expect(verdictFromScore(90)).toBe(ComparisonVerdict.MATCH);
    expect(verdictFromScore(89.9)).toBe(ComparisonVerdict.LIKELY_MATCH);
    expect(verdictFromScore(60)).toBe(ComparisonVerdict.LIKELY_MATCH);
    expect(verdictFromScore(59.9)).toBe(ComparisonVerdict.UNCERTAIN);
    expect(verdictFromScore(25)).toBe(ComparisonVerdict.UNCERTAIN);
    expect(verdictFromScore(24.9)).toBe(ComparisonVerdict.NO_MATCH);
    // The floor, not "1% similar".
    expect(verdictFromScore(1)).toBe(ComparisonVerdict.NO_MATCH);
  });
});

describe("isTerminal", () => {
  it("treats queued and running as still moving", () => {
    expect(isTerminal(ComparisonStatus.QUEUED)).toBe(false);
    expect(isTerminal(ComparisonStatus.RUNNING)).toBe(false);
  });

  it("treats every finished state as terminal, ours included", () => {
    for (const status of [
      ComparisonStatus.SUCCEEDED,
      ComparisonStatus.PARTIAL,
      ComparisonStatus.FAILED,
      ComparisonStatus.TIMEOUT,
      ComparisonStatus.SUPERSEDED,
    ]) {
      expect(isTerminal(status)).toBe(true);
    }
  });
});

describe("parseJob", () => {
  it("reads a finished job", () => {
    const job = parseJob(succeededJob());

    expect(job.status).toBe(ComparisonStatus.SUCCEEDED);
    expect(job.stage).toBe("done");
    expect(job.pairsDone).toBe(1);
    expect(job.pairsTotal).toBe(1);
    expect(job.errorMessage).toBeNull();
    expect(job.result?.engineVersion).toBe("0.6.0");
    expect(job.result?.videos).toHaveLength(2);
    expect(job.result?.videos[0]).toMatchObject({
      key: "http:dd68d51e",
      ready: true,
      durationSeconds: 28.813107,
    });
    expect(job.result?.pairs[0]).toMatchObject({
      aKey: "http:dd68d51e",
      bKey: "http:1f5ea660",
      score: 1,
      verdict: ComparisonVerdict.NO_MATCH,
      containment: 0,
    });
  });

  it("reads a running job, whose result is still null", () => {
    const job = parseJob({
      job_id: "8caa3696",
      status: "running",
      progress: { stage: "comparing", pairs_done: 2, pairs_total: 6 },
      result: null,
      error: null,
    });

    expect(job.status).toBe(ComparisonStatus.RUNNING);
    expect(job.result).toBeNull();
    expect(job.pairsDone).toBe(2);
    expect(job.pairsTotal).toBe(6);
  });

  it("flattens the error envelope onto one line", () => {
    const job = parseJob({
      status: "failed",
      result: null,
      error: {
        code: "download_failed",
        message: "could not fetch input",
        retryable: true,
      },
    });

    expect(job.status).toBe(ComparisonStatus.FAILED);
    expect(job.errorMessage).toBe("could not fetch input (download_failed)");
  });

  it("keeps a partial job's result — the rest were still compared", () => {
    const job = parseJob(succeededJob({ status: "partial" }));

    expect(job.status).toBe(ComparisonStatus.PARTIAL);
    expect(job.result?.pairs).toHaveLength(1);
  });

  it("marks a video the engine could not prepare as not ready", () => {
    const payload = succeededJob() as {
      result: { videos: { status: string }[] };
    };
    payload.result.videos[1]!.status = "error";

    const job = parseJob(payload);

    expect(job.result?.videos[1]?.ready).toBe(false);
  });

  it("treats a cached video as usable, not as a failure", () => {
    // From the second run of a campaign onwards most videos come back
    // "cached" — the engine keys its cache on the URL, and ours are stable.
    // Reading only "ready" as usable reported a healthy re-run as broken.
    const payload = succeededJob() as {
      result: { videos: { status: string }[] };
    };
    payload.result.videos[0]!.status = "cached";
    payload.result.videos[1]!.status = "CACHED";

    const job = parseJob(payload);

    expect(job.result?.videos.map((video) => video.ready)).toEqual([
      true,
      true,
    ]);
  });

  it("falls back to the band for a verdict label it has not seen", () => {
    const payload = succeededJob() as {
      result: { pairs: { verdict: string; score: number }[] };
    };
    payload.result.pairs[0]!.verdict = "extremely_likely";
    payload.result.pairs[0]!.score = 94;

    expect(parseJob(payload).result?.pairs[0]?.verdict).toBe(
      ComparisonVerdict.MATCH,
    );
  });

  it("drops an unusable video or pair rather than the whole result", () => {
    const job = parseJob({
      status: "succeeded",
      progress: {},
      result: {
        videos: [
          // No key: nothing could ever reference it.
          { url: "https://x/a.mp4", status: "ready" },
          { key: "http:2", url: "https://x/b.mp4", status: "ready" },
        ],
        pairs: [
          // No score: not a comparison, whatever else it carries.
          { a: "http:1", b: "http:2", verdict: "match" },
          { a: "http:1", b: "http:2", score: 97.2, verdict: "match" },
        ],
      },
      error: null,
    });

    expect(job.result?.videos).toHaveLength(1);
    expect(job.result?.pairs).toHaveLength(1);
    expect(job.result?.pairs[0]?.verdict).toBe(ComparisonVerdict.MATCH);
  });

  it("defaults missing progress and containment rather than failing", () => {
    const job = parseJob({ status: "queued", result: null, error: null });

    expect(job.stage).toBeNull();
    expect(job.pairsDone).toBe(0);
    expect(job.pairsTotal).toBe(0);
  });

  it("throws on a status it cannot place, instead of guessing", () => {
    // Guessing either way is worse than throwing: "terminal" discards a
    // running job's result, "running" polls until the deadline.
    expect(() => parseJob({ status: "paused" })).toThrow(/unknown status/);
    expect(() => parseJob({ result: null })).toThrow(/unknown status/);
    expect(() => parseJob(null)).toThrow(/not a JSON object/);
    expect(() => parseJob([])).toThrow(/not a JSON object/);
  });
});
