import { ComparisonStatus, ComparisonVerdict } from "@repo/database";

/**
 * The comparison engine's wire format, and the parsing that turns it into
 * something the rest of the app may trust.
 *
 * The engine is a separate service with its own release cycle, so nothing
 * about the payload is assumed. The rules mirror TrackerService's: a response
 * that cannot yield a job at all throws, while an individual video or pair
 * that cannot be read is dropped rather than poisoning the whole result. A
 * dropped pair shows up as a pair that never appears, which is the same as
 * one the engine never returned — a half-parsed pair with a fabricated score
 * would not be.
 */

/** Job lifecycle as the engine reports it, before our own states are added. */
const ENGINE_STATUS: Record<string, ComparisonStatus> = {
  queued: ComparisonStatus.QUEUED,
  running: ComparisonStatus.RUNNING,
  succeeded: ComparisonStatus.SUCCEEDED,
  partial: ComparisonStatus.PARTIAL,
  failed: ComparisonStatus.FAILED,
  timeout: ComparisonStatus.TIMEOUT,
};

/**
 * States that will never change again. `result` is null until one of these is
 * reached — reading it earlier is the documented mistake.
 */
export const TERMINAL_STATUSES: ReadonlySet<ComparisonStatus> = new Set([
  ComparisonStatus.SUCCEEDED,
  ComparisonStatus.PARTIAL,
  ComparisonStatus.FAILED,
  ComparisonStatus.TIMEOUT,
  ComparisonStatus.SUPERSEDED,
]);

export function isTerminal(status: ComparisonStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** The engine's verdict strings. */
const ENGINE_VERDICT: Record<string, ComparisonVerdict> = {
  match: ComparisonVerdict.MATCH,
  likely_match: ComparisonVerdict.LIKELY_MATCH,
  uncertain: ComparisonVerdict.UNCERTAIN,
  no_match: ComparisonVerdict.NO_MATCH,
};

/**
 * The verdict bands, as a function of score.
 *
 * Only a fallback: the engine sends `verdict` and that is what gets stored,
 * so the two can never disagree on a payload we understand. This covers a
 * band the engine adds later — better to place such a pair by its score than
 * to drop a real match because the label was new.
 */
export function verdictFromScore(score: number): ComparisonVerdict {
  if (score >= 90) return ComparisonVerdict.MATCH;
  if (score >= 60) return ComparisonVerdict.LIKELY_MATCH;
  if (score >= 25) return ComparisonVerdict.UNCERTAIN;
  return ComparisonVerdict.NO_MATCH;
}

/**
 * Per-video statuses that mean the engine got a usable fingerprint.
 *
 * `ready` is the fresh case. `cached` is the same video seen in an earlier
 * run — the engine keys its cache on the URL, and ours are stable, so from
 * the second run of a campaign onwards *most* videos come back cached. It is
 * a success, and reading only `ready` as usable would report a healthy re-run
 * as "these videos could not be read".
 *
 * An allow-list rather than a deny-list, because an unfamiliar status is
 * safer treated as "did not contribute" — see `EngineVideo.ready`, and note
 * that appearing in a pair overrides this either way.
 */
const USABLE_VIDEO_STATUSES = new Set(["ready", "cached"]);

/** One input video, after the engine has resolved and probed it. */
export interface EngineVideo {
  /** `<extractor>:<id>` — what pairs reference. NOT the URL. */
  key: string;
  /** The URL we submitted, echoed back. The only link to our own rows. */
  url: string;
  /**
   * Whether the engine fingerprinted it, from its status alone. Callers
   * should prefer `resolveResult`, which also promotes any video that turned
   * up in a pair — being compared is proof, whatever the status string says.
   */
  ready: boolean;
  durationSeconds: number | null;
}

/** One compared pair. `aKey`/`bKey` are engine keys, resolved by the caller. */
export interface EnginePair {
  aKey: string;
  bKey: string;
  score: number;
  verdict: ComparisonVerdict;
  containment: number;
  /** The `evidence` block verbatim — diagnostic detail, never branched on. */
  evidence: unknown;
}

export interface EngineResult {
  engineVersion: string | null;
  videos: EngineVideo[];
  pairs: EnginePair[];
}

/** A job as `GET /v1/jobs/{id}` describes it. */
export interface EngineJob {
  status: ComparisonStatus;
  /** resolving / preparing / comparing / done. Live only. */
  stage: string | null;
  pairsDone: number;
  pairsTotal: number;
  /** The engine's error message, or null. Present on FAILED and TIMEOUT. */
  errorMessage: string | null;
  /** Null until the job is terminal, and on the failure paths after that. */
  result: EngineResult | null;
}

/** Narrow an unknown to a plain object without asserting its shape. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A finite number from anything, or null. Rejects NaN and Infinity. */
function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The job id from `POST /v1/compare`.
 *
 * Only the id is taken: the `status` alongside it is always "queued", and the
 * caller polls for the real one anyway.
 */
export function parseSubmitResponse(payload: unknown): string {
  const body = asRecord(payload);
  const jobId = asNonEmptyString(body?.job_id);
  if (jobId === null) {
    throw new Error("the engine accepted the job but returned no job_id");
  }
  return jobId;
}

/** One entry of `result.videos`, or null when it cannot be identified. */
function parseVideo(entry: unknown): EngineVideo | null {
  const video = asRecord(entry);
  if (video === null) return null;

  // Both are required: the key is what pairs reference, and the URL is the
  // only thing that maps that key back to one of our submissions.
  const key = asNonEmptyString(video.key);
  const url = asNonEmptyString(video.url);
  if (key === null || url === null) return null;

  return {
    key,
    url,
    ready:
      typeof video.status === "string" &&
      USABLE_VIDEO_STATUSES.has(video.status.trim().toLowerCase()),
    durationSeconds: asNumber(video.duration_s),
  };
}

/** One entry of `result.pairs`, or null when it cannot be trusted. */
function parsePair(entry: unknown): EnginePair | null {
  const pair = asRecord(entry);
  if (pair === null) return null;

  const aKey = asNonEmptyString(pair.a);
  const bKey = asNonEmptyString(pair.b);
  const score = asNumber(pair.score);
  // A pair with no score is not a comparison, whatever else it carries.
  if (aKey === null || bKey === null || score === null) return null;

  const label = typeof pair.verdict === "string" ? pair.verdict : "";
  return {
    aKey,
    bKey,
    score,
    // The engine's own label wins; the band is only consulted for one it has
    // not sent before.
    verdict: ENGINE_VERDICT[label] ?? verdictFromScore(score),
    containment: asNumber(pair.containment) ?? 0,
    evidence: pair.evidence ?? null,
  };
}

/** `result`, once the job is terminal. Null while it is not. */
function parseResult(payload: unknown): EngineResult | null {
  const result = asRecord(payload);
  if (result === null) return null;

  const videos = Array.isArray(result.videos) ? result.videos : [];
  const pairs = Array.isArray(result.pairs) ? result.pairs : [];

  return {
    engineVersion: asNonEmptyString(result.engine_version),
    videos: videos.map(parseVideo).filter((video) => video !== null),
    pairs: pairs.map(parsePair).filter((pair) => pair !== null),
  };
}

/**
 * The error envelope, flattened to the one line worth showing a human.
 *
 * `retryable` is deliberately dropped: a run is cheap to start again by hand,
 * and retrying automatically on a job the engine already spent minutes on is
 * a good way to melt it.
 */
function parseError(payload: unknown): string | null {
  const error = asRecord(payload);
  if (error === null) return null;
  const message = asNonEmptyString(error.message);
  const code = asNonEmptyString(error.code);
  if (message !== null) return code === null ? message : `${message} (${code})`;
  return code ?? "the engine reported an error with no message";
}

/**
 * A job payload from `GET /v1/jobs/{id}`.
 *
 * Throws on a status the engine has never documented rather than guessing:
 * treating an unknown status as terminal would discard a running job's
 * result, and treating it as running would poll forever. The caller keeps
 * polling through the throw and gives up on its own deadline.
 */
export function parseJob(payload: unknown): EngineJob {
  const body = asRecord(payload);
  if (body === null) {
    throw new Error("the engine's job response was not a JSON object");
  }

  const label = typeof body.status === "string" ? body.status.trim() : "";
  const status = ENGINE_STATUS[label];
  if (status === undefined) {
    throw new Error(`the engine reported an unknown status "${label}"`);
  }

  const progress = asRecord(body.progress);

  return {
    status,
    stage: asNonEmptyString(progress?.stage),
    pairsDone: asNumber(progress?.pairs_done) ?? 0,
    pairsTotal: asNumber(progress?.pairs_total) ?? 0,
    errorMessage: parseError(body.error),
    // Documented as null until terminal, so this is simply absent while the
    // job runs — no special case needed.
    result: parseResult(body.result),
  };
}
