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
 * pair shares one job timeout. But the classifier's jobs are one fresh video
 * pinned beside cached ones: the pairs among the cached videos are
 * comparison-cache hits, so a job of 8 costs 7 alignments at the measured
 * ~0.5 s each, well inside the engine's 420 s budget. Eight is also the
 * engine's own request cap (its schema). Capped here rather than left to
 * configuration because it is a property of how the engine spends a job
 * budget, not a deployment choice: a larger value does not run slower, it
 * silently loses pairs.
 */
const SAFE_URLS_PER_JOB = 8;

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
 * How many upcoming candidates the classifier fingerprints ahead of time,
 * in parallel with the one it is labelling. The engine prepares every video
 * of a job concurrently across its worker pool, but a classifier that sends
 * one job at a time only ever keeps one worker busy; warming the next few
 * candidates uses the rest. Default matches the engine's worker count.
 */
export function prefetchDepth(): number {
  const configured = Number(process.env.COMPARISON_ENGINE_PREFETCH ?? "");
  return Number.isInteger(configured) && configured >= 0 ? configured : 3;
}

/**
 * How many of one candidate's pinned calls run at once, once its fingerprint
 * is cached. Bounded by the engine's active-job slots; past that the extra
 * calls only queue.
 */
export function callConcurrency(): number {
  const configured = Number(process.env.COMPARISON_ENGINE_CALL_CONCURRENCY ?? "");
  return Number.isInteger(configured) && configured >= 1 ? configured : 2;
}

/** A warm-up is discarded work; it is not worth waiting long for. */
const WARM_MAX_WAIT_MS = 5 * 60 * 1000;

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

/**
 * Poll every second while the job is young, then back off — see
 * `pollInterval`. A cache-warm comparison finishes on the engine in under a
 * second, and a classifier pass makes thousands of them, so every second of
 * polling granularity is paid thousands of times over. A fresh fingerprint
 * takes tens of seconds; after a minute the call is clearly one of those.
 */
const FAST_POLL_MS = 1_000;
const SLOW_POLL_MS = 3_000;
const FAST_POLL_WINDOW_MS = 60_000;

/**
 * How long to wait for a job before giving up on it.
 *
 * The engine's own work is minutes, not hours: the reference run took ~38s for
 * two short videos, and cost grows with the pair count. Half an hour is far
 * past any healthy run and still bounds a job the engine has silently dropped.
 */
const DEFAULT_MAX_WAIT_MS = 30 * 60 * 1000;

/**
 * How long polls may keep failing before a job is called dead. A minute
 * covers an engine restart, or a relay/uvicorn refusing under load, without
 * abandoning a job that is still running behind it. Polls back off to the
 * slow interval while they fail, so a struggling engine is not hammered.
 */
const POLL_FAILURE_GRACE_MS = 60_000;

/**
 * Statuses that mean "not now", never "not ever": the engine's own queue-full
 * 503 (`engine_busy`), uvicorn refusing past its concurrency cap (a plain
 * 503), a relay or proxy in between (502/504), or a rate limit (429). Each is
 * worth the same patience as a full queue. A 4xx of any other kind is a
 * verdict on the request and is thrown at once.
 */
const TRANSIENT_STATUSES = new Set([429, 502, 503, 504]);

/** A non-2xx answer, with the status kept so callers can tell overload from refusal. */
export class EngineHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "EngineHttpError";
  }
}

/**
 * Whether a failed request is worth retrying: an overload-type status, the
 * engine's busy signal, or the connection itself failing — through a tunnel
 * one dropped connection is a lost packet, not a dead engine. A sustained
 * outage still surfaces: the submit backoff and the poll grace both run out.
 */
function isTransient(caught: unknown): boolean {
  if (caught instanceof EngineHttpError) {
    return TRANSIENT_STATUSES.has(caught.status) || isEngineBusy(caught.message);
  }
  const message = messageOf(caught);
  return isEngineBusy(message) || message.includes("could not reach the comparison engine");
}

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
  /**
   * Called by `compare` once the engine has accepted the job — the moment
   * it holds its place in the engine's queue, and anything submitted after
   * this line up behind it.
   */
  onSubmitted?: (jobId: string) => void;
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
        if (!isTransient(caught) || attempt >= SUBMIT_ATTEMPTS) throw caught;
        this.logger.debug(
          `Engine not accepting work (attempt ${attempt}/${SUBMIT_ATTEMPTS}): ${messageOf(caught)}; retrying`,
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
    /** When the current streak of failed polls began; null while polls succeed. */
    let failingSince: number | null = null;

    for (;;) {
      // Throws an AbortError when the signal fires mid-sleep, which is the
      // "stopped by the caller" outcome and is left to propagate as such.
      await pause(
        failingSince === null ? this.pollInterval(startedAt) : SLOW_POLL_MS,
        options.signal,
      );

      if (Date.now() - startedAt > maxWaitMs) {
        throw new Error(
          `The engine did not finish job ${jobId} within ${Math.round(maxWaitMs / 60_000)} minutes.`,
        );
      }

      let job: EngineJob;
      try {
        job = await this.fetchJob(jobId);
        failingSince = null;
      } catch (caught) {
        failingSince ??= Date.now();
        if (Date.now() - failingSince < POLL_FAILURE_GRACE_MS) continue;
        throw caught;
      }

      if (isTerminal(job.status)) return job;
      options.onProgress?.(job);
    }
  }

  /**
   * Gets the engine to fingerprint `urls` now, for a job that will follow.
   *
   * Just a comparison whose result nobody reads: the engine has no
   * fingerprint-only endpoint, and a two-URL job is the cheapest way to make
   * it prepare a video. Never throws and never waits out a full queue —
   * a warm-up that did not happen only means the real call is slower.
   */
  async warm(urls: string[], signal?: AbortSignal): Promise<void> {
    try {
      const jobId = await this.submit(urls);
      await this.waitForJob(jobId, { signal, maxWaitMs: WARM_MAX_WAIT_MS });
    } catch (caught) {
      this.logger.debug(`Warm-up over ${urls.length} URLs did not finish: ${messageOf(caught)}`);
    }
  }

  /** Submit and wait, as one call. */
  async compare(
    urls: string[],
    options: WaitForJobOptions = {},
  ): Promise<{ jobId: string; job: EngineJob }> {
    const jobId = await this.submitWithBackoff(urls, options.signal);
    options.onSubmitted?.(jobId);
    const job = await this.waitForJob(jobId, options);
    return { jobId, job };
  }

  /**
   * Fast at first, slower once the call is clearly not a quick one. The first
   * minute is where a cache-warm job finishes and where a broken one fails,
   * so that is where the responsiveness is worth paying for.
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
      throw new EngineHttpError(
        response.status,
        `the comparison engine answered HTTP ${response.status}` +
          (detail.length > 0 ? `: ${detail.slice(0, 400)}` : ""),
      );
    }

    return response;
  }
}
