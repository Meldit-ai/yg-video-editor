import { Injectable, Logger } from "@nestjs/common";
import {
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
 * HTTP client for the video comparison engine.
 *
 * Two calls, and the asymmetry between them is the whole shape of this
 * integration: `submit` hands over a list of URLs and gets a job id back
 * immediately, and `fetchJob` reads that job until it stops changing. Nothing
 * here waits for a comparison to finish — that is the service's polling loop,
 * not a long-held socket.
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
   * back, so a campaign is submitted as one job rather than one job per new
   * video against the rest.
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
