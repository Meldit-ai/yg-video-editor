import { Injectable, Logger } from "@nestjs/common";
import { pause } from "../common/pause.js";
import {
  isTerminal,
  parseJob,
  parseSubmitResponse,
  type EngineJob,
} from "./comparison-engine.types.js";

/**
 * Where the engine lives. Local by default because that is where it runs
 * today; `COMPARISON_ENGINE_URL` moves it without a code change.
 */
const DEFAULT_BASE_URL = "http://127.0.0.1:8080";

/**
 * Both calls are cheap — one enqueues, the other reads a status row — so a
 * socket still open after this long is hung, not busy. The comparison itself
 * takes minutes and happens entirely on the engine's side of these requests.
 */
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * The most URLs worth putting in one job, whatever the engine would accept.
 *
 * A job's cost is its *pair* count, which is quadratic in the URLs, and every
 * pair shares one job timeout. Ten URLs is 45 pairs against the engine's
 * default 420s budget — about 9s a pair, while aligning a single pair is
 * allowed up to 90s on its own, so one slow pair starves the rest and the
 * whole batch times out with none of its pairs scored. Six URLs is 15 pairs,
 * which leaves room for the worst case rather than the average one.
 *
 * Capped here rather than left to configuration because it is a property of
 * how the engine spends a job budget, not a deployment choice: a larger value
 * does not run slower, it silently loses pairs.
 */
const SAFE_URLS_PER_JOB = 6;

/**
 * URLs the engine accepts in one `POST /v1/compare`.
 *
 * A hard cap on its side — past it the request is answered with HTTP 422, not
 * a truncated job. Four is what the engine ships with; `COMPARISON_ENGINE_MAX_URLS`
 * raises it without a deploy here, and every caller reads this one function
 * so no two paths can disagree about it. Confirm the deployed engine's cap
 * (a 5-URL probe answering 422 means it is still 4) before raising it.
 */
export function engineMaxUrls(): number {
  const configured = Number(process.env.COMPARISON_ENGINE_MAX_URLS ?? "");
  const requested =
    Number.isInteger(configured) && configured >= 2 ? configured : 4;
  return Math.min(requested, SAFE_URLS_PER_JOB);
}

/**
 * How long, and how often, to keep asking a full engine for room.
 *
 * The engine queues a bounded number of jobs and answers 503 `engine_busy`
 * past that. That is "come back shortly", not a fault: five minutes of
 * asking every five seconds rides out another campaign's rebuild without
 * giving up on this one.
 */
const SUBMIT_ATTEMPTS = 60;
const SUBMIT_BACKOFF_MS = 5_000;

/** Poll fast while the job is young, then back off — see `pollInterval`. */
const FAST_POLL_MS = 3_000;
const SLOW_POLL_MS = 8_000;
const FAST_POLL_WINDOW_MS = 30_000;

/**
 * How long to wait for a job before giving up on it.
 *
 * The engine's own work is minutes, not hours: the reference run took ~38s for
 * two short videos, and cost grows with the pair count. Half an hour is far
 * past any healthy run and still bounds a job the engine has silently dropped.
 */
const DEFAULT_MAX_WAIT_MS = 30 * 60 * 1000;

/**
 * Consecutive failed polls before a job is called dead. At the slow interval
 * that is roughly a minute of engine downtime tolerated mid-job, which covers
 * a restart without abandoning a job that is still running behind it.
 */
const MAX_POLL_FAILURES = 8;

/** Whether a refusal was the engine's queue being full, rather than a fault. */
function isEngineBusy(message: string): boolean {
  return message.includes("engine_busy") || message.includes("queue is full");
}

function messageOf(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

export interface WaitForJobOptions {
  /** Ends the wait early; the job itself keeps running on the engine. */
  signal?: AbortSignal;
  /** Overall deadline. Defaults to half an hour. */
  maxWaitMs?: number;
  /** Called with every non-terminal poll, for progress mirroring. */
  onProgress?: (job: EngineJob) => void;
}

/**
 * HTTP client for the video comparison engine.
 *
 * Two wire calls, and the asymmetry between them is the whole shape of this
 * integration: `submit` hands over a list of URLs and gets a job id back
 * immediately, and `fetchJob` reads that job until it stops changing. The
 * waiting is done here too — `submitWithBackoff` rides out a full queue and
 * `waitForJob` polls to a terminal state — so every caller shares one idea of
 * how patient to be with the engine. Each poll is a short request; nothing
 * holds a socket open across the minutes a comparison takes.
 *
 * The base URL is read per call rather than memoised. It costs nothing, and
 * it means a restart is not needed to point at a different engine.
 */
@Injectable()
export class ComparisonEngineClient {
  private readonly logger = new Logger(ComparisonEngineClient.name);

  /** The configured engine root, without a trailing slash. */
  get baseUrl(): string {
    const configured = (process.env.COMPARISON_ENGINE_URL ?? "").trim();
    return (configured.length > 0 ? configured : DEFAULT_BASE_URL).replace(
      /\/+$/,
      "",
    );
  }

  /**
   * Queues a comparison of every URL against every other, and returns the job
   * id to poll.
   *
   * The engine does the fan-out itself: N URLs in means N*(N-1)/2 pairs come
   * back. Callers that only want one video against the rest put it first and
   * discard the pairs among the others — there is no one-vs-many endpoint.
   */
  async submit(urls: string[]): Promise<string> {
    const response = await this.send("POST", "/v1/compare", { urls });
    const jobId = parseSubmitResponse(await response.json());
    this.logger.log(`Queued comparison job ${jobId} over ${urls.length} URLs`);
    return jobId;
  }

  /** One poll of a job. Throws on anything that is not a readable job. */
  async fetchJob(jobId: string): Promise<EngineJob> {
    const response = await this.send(
      "GET",
      `/v1/jobs/${encodeURIComponent(jobId)}`,
    );
    return parseJob(await response.json());
  }

  /**
   * `submit`, but a full queue is waited out rather than reported.
   *
   * Only `engine_busy` is retried. Any other refusal — a bad URL, too many of
   * them — is the engine's final word on that request, and asking again would
   * get the same answer sixty times.
   */
  async submitWithBackoff(
    urls: string[],
    signal?: AbortSignal,
  ): Promise<string> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.submit(urls);
      } catch (caught) {
        const message = messageOf(caught);
        if (!isEngineBusy(message) || attempt >= SUBMIT_ATTEMPTS) throw caught;
        this.logger.debug(
          `Engine queue is full (attempt ${attempt}/${SUBMIT_ATTEMPTS}); waiting for room`,
        );
        await pause(SUBMIT_BACKOFF_MS, signal);
      }
    }
  }

  /**
   * Reads one job until it stops changing, and returns it.
   *
   * Transient failures are tolerated: the engine restarting mid-job is normal
   * operations, and abandoning a call that is still computing would be worse
   * than waiting. Only a sustained outage, the deadline, or the caller's
   * signal ends it — and in those cases the job is thrown, not returned,
   * because there is no result to hand back.
   */
  async waitForJob(
    jobId: string,
    options: WaitForJobOptions = {},
  ): Promise<EngineJob> {
    const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    const startedAt = Date.now();
    let failures = 0;

    for (;;) {
      // Throws an AbortError when the signal fires mid-sleep, which is the
      // "stopped by the caller" outcome and is left to propagate as such.
      await pause(this.pollInterval(startedAt), options.signal);

      if (Date.now() - startedAt > maxWaitMs) {
        throw new Error(
          `The engine did not finish job ${jobId} within ${Math.round(maxWaitMs / 60_000)} minutes.`,
        );
      }

      let job: EngineJob;
      try {
        job = await this.fetchJob(jobId);
        failures = 0;
      } catch (caught) {
        failures += 1;
        if (failures < MAX_POLL_FAILURES) continue;
        throw caught;
      }

      if (isTerminal(job.status)) return job;
      options.onProgress?.(job);
    }
  }

  /** Submit and wait, as one call. */
  async compare(
    urls: string[],
    options: WaitForJobOptions = {},
  ): Promise<{ jobId: string; job: EngineJob }> {
    const jobId = await this.submitWithBackoff(urls, options.signal);
    const job = await this.waitForJob(jobId, options);
    return { jobId, job };
  }

  /**
   * Fast at first, slower once the call is clearly not a quick one. The first
   * seconds are when a small job finishes and when a broken one fails, so
   * that is where the responsiveness is worth paying for.
   */
  private pollInterval(startedAt: number): number {
    return Date.now() - startedAt < FAST_POLL_WINDOW_MS
      ? FAST_POLL_MS
      : SLOW_POLL_MS;
  }

  /**
   * One round trip, with the failure modes flattened into an Error whose
   * message is worth storing on the run and showing an admin.
   *
   * A non-2xx carries its body along: the engine explains a rejected request
   * (an unreachable URL, an unsupported container) there, and "HTTP 400" on
   * its own tells the person reading it nothing.
   */
  private async send(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          accept: "application/json",
          ...(body === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (caught) {
      // fetch fails the same way for "nothing is listening" and "it hung", and
      // an admin reading the run needs to be told which engine was tried.
      const reason = caught instanceof Error ? caught.message : String(caught);
      throw new Error(`could not reach the comparison engine at ${url}: ${reason}`);
    }

    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).trim();
      throw new Error(
        `the comparison engine answered HTTP ${response.status}` +
          (detail.length > 0 ? `: ${detail.slice(0, 400)}` : ""),
      );
    }

    return response;
  }
}
