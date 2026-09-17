import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";
import { ComparisonStatus, Uniqueness, type Prisma } from "@repo/database";
import {
  ComparisonEngineClient,
  callConcurrency,
  engineMaxUrls,
  prefetchDepth,
} from "../comparisons/comparison-engine.client.js";
import type { EngineJob } from "../comparisons/comparison-engine.types.js";
import {
  resolveResult,
  type ResolvedResult,
} from "../comparisons/engine-result.js";
import { ReelTarget } from "./reel-target.js";
import { SubmissionTarget } from "./submission-target.js";
import {
  PARTIAL_FLOOR,
  classifyMatches,
  isTwin,
  matchesOf,
  pairValue,
  planPinnedCalls,
  type Candidate,
  type CandidateMatch,
} from "./uniqueness.rules.js";
import type {
  RunProgress,
  TargetKind,
  UniquenessTarget,
} from "./uniqueness.types.js";

/** Attempts at one engine call before its candidate is left for later. */
const CALL_ATTEMPTS = 2;

const RESTART_MESSAGE = "The server restarted while this check was running.";

function messageOf(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

/** How one engine call ended, from the batch's point of view. */
type CallOutcome =
  | { kind: "ok"; resolved: ResolvedResult; engineVersion: string | null }
  /** The engine took the job and lost it. The candidate is left pending. */
  | { kind: "failed" }
  /** The engine could not be talked to at all. The whole batch stops. */
  | { kind: "fatal"; message: string };

/**
 * Labels every video on a campaign UNIQUE, PARTIAL or DUPLICATE.
 *
 * The rule, in one line: a new video is compared only against the campaign's
 * *baseline* — its UNIQUE and PARTIAL videos, in arrival order — and never
 * against a DUPLICATE, because everything in a DUPLICATE is already in its
 * parent. That turns "every video against every other" into "each video
 * against the ones that matter", and it is what the whole module is for. The
 * numbers live in `uniqueness.rules.ts`; the design is in
 * docs/superpowers/specs/2026-09-17-incremental-duplicate-detection-design.md.
 *
 * Four events touch a label, and every one of them funnels into
 * `classifyPending`: an **arrival** classifies whatever is pending; a
 * **withdrawal** puts the withdrawn video's dependants back to pending; a
 * **rebuild** puts the whole campaign back to pending; and a **threshold
 * edit** re-labels from stored values without the engine at all. A rebuild
 * is therefore literally a replay of arrivals — one code path, so the two
 * cannot drift apart.
 *
 * Work is serialised per campaign and per kind with an in-process promise
 * queue, because sequencing *is* the algorithm: the second video's baseline
 * must include the first video's label. Restart safety comes from the rows
 * rather than from the queue — a pending row is a pending row whichever
 * process reads it, and boot picks them all up.
 */
@Injectable()
export class UniquenessService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(UniquenessService.name);

  /** The tail of each campaign's queue, by `kind:campaignId`. */
  private readonly queues = new Map<string, Promise<void>>();

  /** Fires on shutdown, so a batch mid-engine-call stops waiting. */
  private readonly stopping = new AbortController();

  // Typed as the interface so a test can hand in an in-memory target; the
  // explicit tokens are what Nest resolves at runtime.
  constructor(
    private readonly engine: ComparisonEngineClient,
    @Inject(SubmissionTarget) private readonly submissions: UniquenessTarget,
    @Inject(ReelTarget) private readonly reels: UniquenessTarget,
  ) {}

  /* ------------------------------------------------------------- events */

  /**
   * A video (or several) just arrived on a campaign: classify whatever is
   * pending there. Never throws and never waits — the upload has already
   * succeeded, and an engine that is down must not turn it into a failure.
   */
  onArrival(kind: TargetKind, campaignId: string): void {
    const target = this.target(kind);
    this.enqueue(kind, campaignId, () =>
      this.classifyPending(target, campaignId, null),
    );
  }

  /**
   * A video was withdrawn. If anything was labelled against it, those videos
   * go back to pending and are re-classified in arrival order — the oldest
   * dependant gets classified first, joins the baseline if it earns it, and
   * the rest see it there. A withdrawn DUPLICATE has no dependants, so this
   * is a no-op for it.
   */
  withdraw(kind: TargetKind, campaignId: string, id: string): void {
    const target = this.target(kind);
    this.enqueue(kind, campaignId, async () => {
      const dependants = await target.loadDependants(campaignId, id);
      if (dependants.length === 0) return;
      await target.resetLabels(campaignId, dependants);
      await this.classifyPending(target, campaignId, null);
    });
  }

  /**
   * Replays the whole campaign from scratch, and returns the id of the run
   * that records it.
   *
   * The run row is opened before this returns — outside the queue — so the
   * page can poll it at once rather than after whatever batch is already in
   * flight. The reset and the replay are queued synchronously behind that,
   * which keeps an arrival that lands a moment later behind the rebuild.
   */
  async rebuild(kind: TargetKind, campaignId: string): Promise<string> {
    const target = this.target(kind);

    const opening = (async () => {
      const threshold = await target.loadThreshold(campaignId);
      if (threshold === null) {
        throw new NotFoundException(`Campaign ${campaignId} not found`);
      }
      const candidateCount = await target.countActive(campaignId);
      return target.openRun(campaignId, {
        triggerId: null,
        threshold,
        candidateCount,
      });
    })();

    this.enqueue(kind, campaignId, async () => {
      let runId: string;
      try {
        runId = await opening;
      } catch {
        return; // Reported to the caller through the returned promise.
      }
      await target.resetLabels(campaignId);
      await this.classifyPending(target, campaignId, runId);
    });

    return opening;
  }

  /** `rebuild`, awaited to completion. For scripts and tests. */
  async rebuildAndWait(kind: TargetKind, campaignId: string): Promise<void> {
    await this.rebuild(kind, campaignId);
    await this.whenIdle(kind, campaignId);
  }

  /**
   * Re-labels a campaign from stored match values after its threshold moved.
   *
   * No engine call: every labelled video already carries the number the
   * label is derived from. Runs inside the caller's transaction so a
   * threshold write and the labels it implies land together. Later videos
   * are *not* re-checked against the changed baseline — that is what a
   * rebuild is for, and it should be a button rather than a side-effect of
   * a form field.
   */
  async reclassifyForThreshold(
    tx: Prisma.TransactionClient,
    campaignId: string,
    threshold: number,
  ): Promise<void> {
    await this.submissions.relabelForThreshold(tx, campaignId, threshold);
    await this.reels.relabelForThreshold(tx, campaignId, threshold);
  }

  /** Resolves once everything queued for the campaign so far has run. */
  whenIdle(kind: TargetKind, campaignId: string): Promise<void> {
    return this.queues.get(`${kind}:${campaignId}`) ?? Promise.resolve();
  }

  /* --------------------------------------------------------------- boot */

  /**
   * Picks up where a previous process left off.
   *
   * Runs left live are marked failed — the batch behind them is gone — and
   * every campaign with a pending row gets a fresh batch, which resumes the
   * interrupted work in order. The engine's caches make re-running an
   * interrupted candidate cheap. `UNIQUENESS_SWEEP_ON_BOOT=false` is for the
   * backfill script, which drives the service itself.
   */
  async onApplicationBootstrap(): Promise<void> {
    if (process.env.UNIQUENESS_SWEEP_ON_BOOT === "false") return;

    for (const target of [this.submissions, this.reels]) {
      try {
        const failed = await target.failLiveRuns(RESTART_MESSAGE);
        if (failed > 0) {
          this.logger.warn(
            `Marked ${failed} ${target.kind} check run(s) failed: ${RESTART_MESSAGE}`,
          );
        }
        const campaigns = await target.campaignsWithPending();
        for (const campaignId of campaigns) {
          this.onArrival(target.kind, campaignId);
        }
        if (campaigns.length > 0) {
          this.logger.log(
            `Resuming ${target.kind} classification on ${campaigns.length} campaign(s)`,
          );
        }
      } catch (caught) {
        this.logger.warn(
          `Could not resume ${target.kind} classification: ${messageOf(caught)}`,
        );
      }
    }
  }

  onModuleDestroy(): void {
    this.stopping.abort();
  }

  /* -------------------------------------------------------------- queue */

  private target(kind: TargetKind): UniquenessTarget {
    return kind === "submission" ? this.submissions : this.reels;
  }

  /**
   * Chains `work` behind whatever is already queued for the campaign.
   *
   * The chain never rejects: a failing batch is logged and the next one
   * still runs. Whether a batch left rows pending is recorded on the rows
   * themselves, which is what the next batch reads.
   */
  private enqueue(
    kind: TargetKind,
    campaignId: string,
    work: () => Promise<void>,
  ): void {
    const key = `${kind}:${campaignId}`;
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous
      .then(work)
      .catch((caught: unknown) => {
        this.logger.error(
          `Classification batch on ${key} stopped unexpectedly: ${messageOf(caught)}`,
        );
      })
      .finally(() => {
        if (this.queues.get(key) === next) this.queues.delete(key);
      });
    this.queues.set(key, next);
  }

  /* ----------------------------------------------------------- the loop */

  /**
   * Classifies every pending video on a campaign, oldest first.
   *
   * The baseline and the threshold are re-read before each candidate: the
   * previous candidate may have just joined the baseline, and that is the
   * whole point. One run row records the batch, opened here unless the
   * caller (a rebuild) already opened one.
   */
  private async classifyPending(
    target: UniquenessTarget,
    campaignId: string,
    existingRunId: string | null,
  ): Promise<void> {
    const signal = this.stopping.signal;
    const pending = await target.loadPending(campaignId);
    const threshold = await target.loadThreshold(campaignId);

    if (threshold === null) {
      if (existingRunId !== null) {
        await target.closeRun(existingRunId, {
          status: ComparisonStatus.FAILED,
          errorMessage: "The campaign no longer exists.",
          engineVersion: null,
          flaggedPairCount: 0,
        });
      }
      return;
    }

    if (pending.length === 0 && existingRunId === null) return;

    const runId =
      existingRunId ??
      (await target.openRun(campaignId, {
        triggerId: pending.length === 1 ? pending[0]!.id : null,
        threshold,
        candidateCount: pending.length,
      }));

    const progress: RunProgress = {
      stage: "comparing",
      pairsDone: 0,
      pairsTotal: 0,
      videoCount: 0,
      matchCount: 0,
    };
    const videosSeen = new Set<string>();
    /** Candidates whose fingerprint has been asked for ahead of their turn. */
    const warmed = new Set<string>();
    let engineVersion: string | null = null;
    let flaggedPairCount = 0;
    let unreadable = 0;
    let lostCalls = 0;
    let fatal: string | null = null;

    for (const [index, candidate] of pending.entries()) {
      if (signal.aborted) return; // Boot will mark the run failed.
      const startedAt = Date.now();

      const [baseline, currentThreshold] = await Promise.all([
        target.loadBaseline(campaignId),
        target.loadThreshold(campaignId),
      ]);
      const { calls, twins } = planPinnedCalls(
        candidate,
        baseline,
        engineMaxUrls(),
      );

      videosSeen.add(candidate.id);
      for (const call of calls) for (const video of call) videosSeen.add(video.id);
      progress.videoCount = videosSeen.size;
      progress.pairsTotal +=
        twins.length + calls.reduce((sum, call) => sum + call.length - 1, 0);

      // A baseline video that is the same file — same URL, or the same
      // bytes by content identity — is a perfect match by definition, and
      // the engine is not asked about it.
      const matches: CandidateMatch[] = twins.map((twin) => ({
        otherId: twin.id,
        score: 100,
        containment: 100,
      }));
      progress.pairsDone += twins.length;

      let candidateReady = calls.length === 0 || twins.length > 0;
      let candidateLost = false;

      // The next few candidates are sent to the engine as warm-ups, so their
      // fingerprints are computed on its idle workers while this one is
      // compared. Paired with the oldest baseline video: the engine needs
      // two URLs, and that pair is one the real call will ask for anyway.
      // Only once this candidate's own call holds its place in the engine's
      // queue — the engine fills its active slots in submission order, and
      // warm-ups sent first would take every slot and leave the real call
      // waiting behind work nobody is waiting for.
      const warmAhead = (): void =>
        this.warmAhead(pending, index, baseline, warmed, signal);
      if (calls.length === 0) warmAhead();

      // A cold candidate's first call fingerprints it, and must run alone —
      // fired together, every call would download it. After that (or from
      // the start, for a warmed one) the calls only align cached videos and
      // can overlap.
      const outcomes = await this.runCalls(
        target,
        runId,
        candidate,
        calls,
        warmed.has(candidate.id),
        progress,
        signal,
        warmAhead,
      );

      for (const [callIndex, outcome] of outcomes.entries()) {
        const call = calls[callIndex]!;
        if (outcome.kind === "fatal") {
          fatal = outcome.message;
          break;
        }
        if (outcome.kind === "failed") {
          candidateLost = true;
          continue;
        }
        engineVersion = outcome.engineVersion ?? engineVersion;
        const self = outcome.resolved.videos.find(
          (video) => video.submissionId === candidate.id,
        );
        if (self?.ready === true) candidateReady = true;
        matches.push(...matchesOf(candidate.id, outcome.resolved.pairs));
        progress.pairsDone += call.length - 1;
      }
      if (fatal !== null) break;

      const checkedAt = new Date();
      if (candidateLost) {
        // Left pending: the next arrival or boot tries again, in order.
        lostCalls += 1;
      } else if (!candidateReady) {
        await target.markUnreadable(candidate.id, checkedAt);
        unreadable += 1;
      } else {
        const outcome = classifyMatches(matches, currentThreshold ?? threshold);
        await target.writeOutcome(candidate.id, outcome, checkedAt);
        if (outcome.uniqueness === Uniqueness.DUPLICATE) progress.matchCount += 1;
        flaggedPairCount += matches.filter(
          (match) => pairValue(match.score, match.containment) >= PARTIAL_FLOOR,
        ).length;
        // One line per video: the first call carries the fingerprinting, so
        // this is what a bulk run's cost is read off.
        this.logger.log(
          `Labelled ${target.kind} ${candidate.id} ${outcome.uniqueness} (${outcome.matchValue}) against ${baseline.length} baseline in ${calls.length} call(s), ${Date.now() - startedAt} ms`,
        );
      }

      await target.updateRun(runId, progress);
    }

    const status =
      fatal !== null
        ? ComparisonStatus.FAILED
        : unreadable > 0 || lostCalls > 0
          ? ComparisonStatus.PARTIAL
          : ComparisonStatus.SUCCEEDED;
    const errorMessage =
      fatal ??
      (lostCalls > 0
        ? `${lostCalls} video(s) could not be checked because the engine did not finish; they will be retried.`
        : unreadable > 0
          ? `${unreadable} video(s) could not be read by the engine.`
          : null);

    await target.closeRun(runId, {
      status,
      errorMessage,
      engineVersion,
      flaggedPairCount,
    });

    if (fatal !== null) {
      this.logger.error(
        `Classification on ${target.kind} campaign ${campaignId} stopped: ${fatal}`,
      );
    } else {
      this.logger.log(
        `Classified ${pending.length - lostCalls} ${target.kind}(s) on campaign ${campaignId} as ${status}`,
      );
    }
  }

  /**
   * Asks the engine to fingerprint the candidates after `index`, up to the
   * prefetch depth, each at most once per batch. Twins of a baseline video
   * are skipped — they will never be sent to the engine at all.
   */
  private warmAhead(
    pending: readonly Candidate[],
    index: number,
    baseline: readonly Candidate[],
    warmed: Set<string>,
    signal: AbortSignal,
  ): void {
    const depth = prefetchDepth();
    if (depth === 0) return;
    const anchor = baseline[0] ?? pending[index]!;

    for (const next of pending.slice(index + 1, index + 1 + depth)) {
      if (warmed.has(next.id)) continue;
      if (next.url === anchor.url) continue; // the engine refuses a repeated URL
      if (baseline.some((video) => isTwin(next, video))) continue;
      warmed.add(next.id);
      void this.engine.warm([next.url, anchor.url], signal);
    }
  }

  /**
   * Runs one candidate's calls: the first alone when the candidate is cold,
   * then the rest `callConcurrency()` at a time. Outcomes come back in plan
   * order whatever order the calls finished in, so the tie-break "the older
   * baseline video wins" stays deterministic. A fatal outcome stops the
   * calls that have not started; the ones in flight are left to finish.
   */
  private async runCalls(
    target: UniquenessTarget,
    runId: string,
    candidate: Candidate,
    calls: readonly Candidate[][],
    warmedAlready: boolean,
    progress: RunProgress,
    signal: AbortSignal,
    onFirstSubmitted: () => void,
  ): Promise<CallOutcome[]> {
    const outcomes: CallOutcome[] = new Array<CallOutcome>(calls.length);
    let next = 0;
    let fatal = false;
    let announced = false;

    const run = async (index: number): Promise<void> => {
      const outcome = await this.runCall(
        target,
        runId,
        candidate,
        calls[index]!,
        progress,
        signal,
        () => {
          if (announced) return;
          announced = true;
          onFirstSubmitted();
        },
      );
      outcomes[index] = outcome;
      if (outcome.kind === "fatal") fatal = true;
    };

    if (!warmedAlready && calls.length > 0) {
      await run(0);
      next = 1;
    }

    const worker = async (): Promise<void> => {
      while (!fatal && next < calls.length) {
        const index = next;
        next += 1;
        await run(index);
      }
    };
    const width = Math.max(1, Math.min(callConcurrency(), calls.length - next));
    if (next < calls.length && !fatal) {
      await Promise.all(Array.from({ length: width }, worker));
    }

    // Calls that never started because of a fatal one report as such, so the
    // caller sees one fatal and stops — never a "failed" that leaves the
    // candidate pending for a reason it was not.
    for (let index = 0; index < calls.length; index += 1) {
      outcomes[index] ??= { kind: "fatal", message: "stopped after an earlier call failed" };
    }
    return outcomes;
  }

  /**
   * One engine call: `[candidate, ...slice]`, submitted, waited for, and
   * recorded.
   */
  private async runCall(
    target: UniquenessTarget,
    runId: string,
    candidate: Candidate,
    call: Candidate[],
    progress: RunProgress,
    signal: AbortSignal,
    onSubmitted: () => void,
  ): Promise<CallOutcome> {
    const slice = call.slice(1);
    const urls = call.map((video) => video.url);
    const entries = call.map((video) => ({
      submissionId: video.id,
      url: video.url,
    }));

    for (let attempt = 1; attempt <= CALL_ATTEMPTS; attempt += 1) {
      let jobId: string;
      let job: EngineJob;
      try {
        ({ jobId, job } = await this.engine.compare(urls, {
          signal,
          onSubmitted,
          onProgress: (live) => {
            void target
              .updateRun(runId, { ...progress, stage: live.stage })
              .catch(() => undefined);
          },
        }));
      } catch (caught) {
        const message = messageOf(caught);
        await target.recordCall(runId, {
          candidate,
          slice,
          jobId: null,
          status: ComparisonStatus.FAILED,
          errorMessage: message,
          resolved: null,
        });
        return { kind: "fatal", message };
      }

      if (job.result === null) {
        // Timed out, or the engine hit an internal error. Nothing to read.
        await target.recordCall(runId, {
          candidate,
          slice,
          jobId,
          status: job.status,
          errorMessage:
            job.errorMessage ?? "The engine finished without returning a result.",
          resolved: null,
        });
        if (attempt < CALL_ATTEMPTS) continue;
        return { kind: "failed" };
      }

      // Only the candidate's pairs are the run's business — see `matchesOf`.
      const full = resolveResult(entries, job.result);
      const resolved: ResolvedResult = {
        videos: full.videos,
        pairs: full.pairs.filter(
          (pair) =>
            pair.aSubmissionId === candidate.id ||
            pair.bSubmissionId === candidate.id,
        ),
      };
      await target.recordCall(runId, {
        candidate,
        slice,
        jobId,
        status: job.status,
        errorMessage: job.errorMessage,
        resolved,
      });
      return { kind: "ok", resolved, engineVersion: job.result.engineVersion };
    }

    return { kind: "failed" }; // Unreachable: the loop returns on its last attempt.
  }
}
