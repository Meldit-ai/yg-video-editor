import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";
import { setTimeout as sleep } from "node:timers/promises";
import {
  ComparisonStatus,
  ComparisonVerdict,
  Role,
  type Prisma,
  type VideoComparison,
} from "@repo/database";
import type { AuthenticatedUser } from "../auth/auth.types.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { StorageService } from "../storage/storage.service.js";
import { ComparisonEngineClient } from "./comparison-engine.client.js";
import {
  isTerminal,
  type EngineJob,
  type EngineResult,
} from "./comparison-engine.types.js";
import type {
  ComparisonDto,
  ComparisonGroupDto,
  ComparisonPairDto,
  ComparisonSummaryDto,
  ComparisonVideoDto,
} from "./comparisons.types.js";

/** Nothing to compare a single video against. */
const MIN_VIDEOS = 2;

/**
 * URLs the engine accepts in one `POST /v1/compare`.
 *
 * A hard cap on its side — 5 URLs is answered with HTTP 422, not a truncated
 * job — so any campaign past this is covered by several overlapping calls.
 * Overridable because it is the engine's limit, not ours, and raising it
 * there should not need a deploy here.
 */
function maxUrlsPerJob(): number {
  const configured = Number(process.env.COMPARISON_ENGINE_MAX_URLS ?? "");
  return Number.isInteger(configured) && configured >= 2 ? configured : 4;
}

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
const MAX_WAIT_MS = 30 * 60 * 1000;

/**
 * Consecutive failed polls before a run is called dead. At the slow interval
 * that is roughly a minute of engine downtime tolerated mid-job, which covers
 * a restart without abandoning a job that is still running behind it.
 */
const MAX_POLL_FAILURES = 8;

/**
 * How many times one batch waits for room in the engine's queue.
 *
 * The queue drains as jobs finish, and a job is minutes rather than seconds,
 * so these are long waits by design — the alternative is dropping the batch
 * and leaving its pairs uncompared.
 */
const SUBMIT_ATTEMPTS = 60;
const SUBMIT_BACKOFF_MS = 5_000;

/** The row shape every read selects: the roster and pairs come along. */
const WITH_DETAIL = {
  entries: {
    include: {
      submission: {
        select: {
          id: true,
          fileName: true,
          editorId: true,
          createdAt: true,
          editor: { select: { name: true } },
        },
      },
    },
  },
  pairs: { orderBy: { score: "desc" } },
} satisfies Prisma.VideoComparisonInclude;

/** The two statuses that are still moving. Guards every progress write. */
const LIVE_STATUSES: ComparisonStatus[] = [
  ComparisonStatus.QUEUED,
  ComparisonStatus.RUNNING,
];

/** Canonical, order-independent identity of a pair. See the schema comment. */
export function pairKeyOf(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

type ComparisonRow = Prisma.VideoComparisonGetPayload<{
  include: typeof WITH_DETAIL;
}>;

/** A submission and the URL the engine will be given for it. */
interface PendingEntry {
  submissionId: string;
  url: string;
}

/** Pairs the engine will produce from n videos — every combination of two. */
function pairCount(videoCount: number): number {
  return (videoCount * (videoCount - 1)) / 2;
}

/** Whether a refusal was the engine's queue being full, rather than a fault. */
function isEngineBusy(message: string): boolean {
  return message.includes("engine_busy") || message.includes("queue is full");
}

function messageOf(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

/**
 * Duplicate detection across a campaign's video submissions.
 *
 * The unit of work is a **campaign**, not a video. The engine compares every
 * URL it is given against every other, so handing it the whole campaign in one
 * job is both what the requirement asks for — every video compared with every
 * other — and cheaper than one job per new upload: N videos cost one job of
 * N*(N-1)/2 pairs instead of N jobs re-fingerprinting the same files.
 *
 * A new upload therefore starts a *fresh* run over the widened set and
 * supersedes any run still in flight, rather than appending to it. The
 * superseded run keeps its row: it is a record that a check was started, not
 * a result anyone should read.
 *
 * Three things about the engine shape the code here:
 *
 *   - **Pairs reference engine keys, not URLs.** `pairs[].a` is
 *     `<extractor>:<hash>`; `result.videos[]` is the only thing that maps a
 *     key back to a URL, and `entries` is the only thing that maps a URL back
 *     to a submission. Both hops are needed, and a pair that cannot complete
 *     them is dropped.
 *   - **Nothing is synchronous.** Submitting returns a job id; the result
 *     arrives minutes later. Polling happens here, in-process, so the browser
 *     polls our own database instead of the engine.
 *   - **A restart must not orphan a job.** Runs left non-terminal are picked
 *     back up on boot — the engine kept working through our downtime.
 */
@Injectable()
export class ComparisonsService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(ComparisonsService.name);

  /**
   * Polls currently in flight, by *job* row id — a run is several engine
   * calls, each polled separately. The run and campaign are kept beside the
   * controller so superseding a campaign can stop all of its pollers without
   * walking the database.
   */
  private readonly polls = new Map<
    string,
    { comparisonId: string; campaignId: string; controller: AbortController }
  >();

  /** Set on shutdown so a poll that is mid-await does not restart itself. */
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly engine: ComparisonEngineClient,
  ) {}

  /**
   * Picks up runs this process (or a previous one) left mid-flight.
   *
   * Bootstrap rather than module init: it touches the database, and a poll
   * firing while the app is still wiring itself up buys nothing. Failures are
   * logged and swallowed — an unreachable database at boot must not stop the
   * app, exactly as PrismaService already decides.
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      const running = await this.prisma.client.videoComparisonJob.findMany({
        where: {
          status: { in: LIVE_STATUSES },
          jobId: { not: null },
          comparison: { active: true, status: { in: LIVE_STATUSES } },
        },
        select: {
          id: true,
          jobId: true,
          comparisonId: true,
          comparison: { select: { campaignId: true } },
        },
      });

      for (const row of running) {
        // Narrowing only: the `not: null` filter already guarantees it.
        if (row.jobId === null) continue;
        this.track(
          row.id,
          row.comparisonId,
          row.comparison.campaignId,
          row.jobId,
        );
      }

      if (running.length > 0) {
        this.logger.log(
          `Resumed polling ${running.length} in-flight comparison call(s)`,
        );
      }
    } catch (caught) {
      this.logger.warn(
        `Could not resume in-flight comparison runs: ${messageOf(caught)}`,
      );
    }
  }

  /** Stops every poll so a shutdown is not held open by a sleeping timer. */
  onModuleDestroy(): void {
    this.stopped = true;
    for (const { controller } of this.polls.values()) controller.abort();
    this.polls.clear();
  }

  /**
   * Starts a run because a video was just uploaded.
   *
   * Never throws and never awaits the engine: the upload has already
   * succeeded, the bytes are in the bucket, and a comparison engine that is
   * down must not turn a good submission into a failed request. A campaign
   * with only one video is skipped outright — there is no pair to compare.
   */
  triggerAfterUpload(campaignId: string, submissionId: string): void {
    void this.runForCampaign(campaignId, submissionId).catch(
      (caught: unknown) => {
        // The first video on a campaign has nothing to be compared against.
        // Expected on every new brief, so it is not worth a warning.
        if (caught instanceof BadRequestException) {
          this.logger.debug(
            `No comparison started for campaign ${campaignId}: ${messageOf(caught)}`,
          );
          return;
        }
        this.logger.warn(
          `Could not start a comparison for campaign ${campaignId}: ${messageOf(caught)}`,
        );
      },
    );
  }

  /**
   * Runs a check over every active submission on a campaign.
   *
   * The engine is called before any row is written, so a run that never
   * reached it is recorded as FAILED with the reason rather than as a queued
   * job with no job id behind it — a state that would poll forever.
   */
  async runForCampaign(
    campaignId: string,
    triggerSubmissionId: string | null = null,
  ): Promise<ComparisonSummaryDto> {
    const submissions = await this.prisma.client.videoSubmission.findMany({
      where: { campaignId, active: true },
      select: { id: true, objectKey: true },
      orderBy: { createdAt: "asc" },
    });

    if (submissions.length < MIN_VIDEOS) {
      throw new BadRequestException(
        `At least ${MIN_VIDEOS} submitted videos are needed to run a comparison.`,
      );
    }

    let entries: PendingEntry[];
    let batches: string[][];
    try {
      entries = submissions.map((submission) => ({
        submissionId: submission.id,
        url: this.storage.publicObjectUrl(submission.objectKey),
      }));
      batches = planBatches(
        entries.map((entry) => entry.submissionId),
        maxUrlsPerJob(),
      );
    } catch (caught) {
      // Building the URLs is the only thing that can fail here, and it fails
      // for one reason: the bucket block is not configured.
      return this.recordUnstartedRun(
        campaignId,
        triggerSubmissionId,
        submissions.length,
        messageOf(caught),
      );
    }

    const urlBySubmission = new Map(
      entries.map((entry) => [entry.submissionId, entry.url]),
    );

    // Submitted before anything is written, so a run is only recorded once at
    // least one call has been accepted. Failures are collected rather than
    // thrown: with several calls in play, some succeeding is a usable result.
    const accepted: { jobId: string; submissionIds: string[] }[] = [];
    const rejected: string[] = [];

    for (const batch of batches) {
      const urls = batch.map((id) => urlBySubmission.get(id) ?? "");
      let lastError = "";

      // The engine queues a bounded number of jobs and answers 503 once it is
      // full. A campaign of any size submits far more batches than that fits,
      // so a refusal is "come back shortly", not a failure — dropping the
      // batch would silently leave those pairs uncompared.
      for (let attempt = 0; attempt < SUBMIT_ATTEMPTS; attempt += 1) {
        try {
          const jobId = await this.engine.submit(urls);
          accepted.push({ jobId, submissionIds: batch });
          lastError = "";
          break;
        } catch (caught) {
          lastError = messageOf(caught);
          if (!isEngineBusy(lastError)) break;
          await sleep(SUBMIT_BACKOFF_MS);
        }
      }

      if (lastError !== "") rejected.push(lastError);
    }

    if (accepted.length === 0) {
      return this.recordUnstartedRun(
        campaignId,
        triggerSubmissionId,
        entries.length,
        rejected[0] ?? "The comparison engine accepted none of the requests.",
      );
    }

    const row = await this.prisma.client.$transaction(async (tx) => {
      // Superseded only now that a replacement genuinely exists: a submit that
      // failed above must not take a healthy running job down with it.
      await tx.videoComparison.updateMany({
        where: {
          campaignId,
          active: true,
          status: { in: [ComparisonStatus.QUEUED, ComparisonStatus.RUNNING] },
        },
        data: {
          status: ComparisonStatus.SUPERSEDED,
          completedAt: new Date(),
        },
      });

      return tx.videoComparison.create({
        data: {
          campaignId,
          triggerSubmissionId,
          status: ComparisonStatus.QUEUED,
          videoCount: entries.length,
          // Known up front, so the progress bar has a denominator before the
          // engine reports one. This is the *campaign's* pair count, not the
          // sum over batches — batches overlap, and a pair counted twice
          // would make the bar stall short of full.
          pairsTotal: pairCount(entries.length),
          // Partial from the start when some calls were refused: the run can
          // never cover every pair, and saying so late would be worse.
          errorMessage:
            rejected.length > 0
              ? `${rejected.length} of ${batches.length} engine requests were refused: ${rejected[0]}`
              : null,
          entries: { create: entries },
          jobs: { create: accepted },
        },
        include: { jobs: true },
      });
    });

    this.stopPollsForCampaign(campaignId, row.id);
    for (const job of row.jobs) {
      if (job.jobId === null) continue;
      this.track(job.id, row.id, campaignId, job.jobId);
    }
    return this.toSummary(row);
  }

  /** Runs on a campaign, newest first. Summaries only — no pairs. */
  async findAll(campaignId: string): Promise<ComparisonSummaryDto[]> {
    const rows = await this.prisma.client.videoComparison.findMany({
      where: { campaignId, active: true },
      orderBy: { createdAt: "desc" },
    });
    return rows.map((row) => this.toSummary(row));
  }

  /**
   * The current run for a campaign, in full, or null when none has been made.
   *
   * "Current" is the newest row of any status: a run that failed or is still
   * queued is what the campaign's duplicate check currently *is*, and hiding
   * it in favour of an older success would misreport the state.
   */
  async findLatest(
    campaignId: string,
    user: AuthenticatedUser,
  ): Promise<ComparisonDto | null> {
    const row = await this.prisma.client.videoComparison.findFirst({
      where: { campaignId, active: true },
      orderBy: { createdAt: "desc" },
      include: WITH_DETAIL,
    });
    return row === null ? null : this.toDto(row, user);
  }

  /** One run in full. 404s for an id that is not on this campaign. */
  async findOne(
    campaignId: string,
    id: string,
    user: AuthenticatedUser,
  ): Promise<ComparisonDto> {
    const row = await this.prisma.client.videoComparison.findFirst({
      where: { id, campaignId, active: true },
      include: WITH_DETAIL,
    });
    if (row === null) {
      throw new NotFoundException(`Comparison ${id} not found`);
    }
    return this.toDto(row, user);
  }

  /**
   * Records a run that never reached the engine.
   *
   * Written rather than only logged: "the check could not start, and here is
   * why" is the answer the campaign page needs to show, and an admin who sees
   * nothing at all would reasonably conclude no duplicates were found.
   */
  private async recordUnstartedRun(
    campaignId: string,
    triggerSubmissionId: string | null,
    videoCount: number,
    errorMessage: string,
  ): Promise<ComparisonSummaryDto> {
    this.logger.error(
      `Comparison for campaign ${campaignId} never started: ${errorMessage}`,
    );
    const row = await this.prisma.client.videoComparison.create({
      data: {
        campaignId,
        triggerSubmissionId,
        status: ComparisonStatus.FAILED,
        videoCount,
        pairsTotal: pairCount(videoCount),
        errorMessage,
        completedAt: new Date(),
      },
    });
    return this.toSummary(row);
  }

  /* ----------------------------------------------------------------- polling */

  /** Begins polling one engine call, unless it is already being polled. */
  private track(
    jobRowId: string,
    comparisonId: string,
    campaignId: string,
    jobId: string,
  ): void {
    if (this.stopped || this.polls.has(jobRowId)) return;

    const controller = new AbortController();
    this.polls.set(jobRowId, { comparisonId, campaignId, controller });

    void this.poll(jobRowId, comparisonId, jobId, controller.signal)
      .catch((caught: unknown) => {
        // The loop handles its own failures; anything reaching here is a bug
        // in it, and losing it silently would leave a run stuck at "queued".
        this.logger.error(
          `Polling job ${jobId} stopped unexpectedly: ${messageOf(caught)}`,
        );
      })
      .finally(() => {
        this.polls.delete(jobRowId);
      });
  }

  /** Aborts every poll on a campaign except the run that replaced them. */
  private stopPollsForCampaign(campaignId: string, keepId: string): void {
    for (const [id, poll] of this.polls) {
      if (poll.comparisonId === keepId || poll.campaignId !== campaignId) {
        continue;
      }
      poll.controller.abort();
      this.polls.delete(id);
    }
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
   * Reads one engine call until it stops changing, then folds its result into
   * the run.
   *
   * Transient failures are tolerated: the engine restarting mid-job is normal
   * operations, and abandoning a call that is still computing would be worse
   * than waiting. Only a sustained outage, or the overall deadline, ends it.
   */
  private async poll(
    jobRowId: string,
    comparisonId: string,
    jobId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const startedAt = Date.now();
    let failures = 0;

    while (!signal.aborted && !this.stopped) {
      try {
        await sleep(this.pollInterval(startedAt), undefined, { signal });
      } catch {
        return; // Aborted — superseded, or the app is shutting down.
      }

      if (Date.now() - startedAt > MAX_WAIT_MS) {
        await this.finishJob(jobRowId, comparisonId, {
          status: ComparisonStatus.TIMEOUT,
          errorMessage: `The engine did not finish job ${jobId} within ${Math.round(MAX_WAIT_MS / 60_000)} minutes.`,
        });
        return;
      }

      let job: EngineJob;
      try {
        job = await this.engine.fetchJob(jobId);
        failures = 0;
      } catch (caught) {
        failures += 1;
        if (failures < MAX_POLL_FAILURES) continue;
        await this.finishJob(jobRowId, comparisonId, {
          status: ComparisonStatus.FAILED,
          errorMessage: messageOf(caught),
        });
        return;
      }

      if (!isTerminal(job.status)) {
        await this.saveProgress(jobRowId, comparisonId, job);
        continue;
      }

      await this.saveResult(jobRowId, comparisonId, job);
      return;
    }
  }

  /**
   * Mirrors one call's live progress.
   *
   * Guarded on a non-terminal status so a poll that lost a race with a
   * supersede cannot drag a row back to RUNNING. Failures are logged, not
   * thrown: a missed progress tick is cosmetic, and the next one is seconds
   * away.
   */
  private async saveProgress(
    jobRowId: string,
    comparisonId: string,
    job: EngineJob,
  ): Promise<void> {
    try {
      await this.prisma.client.$transaction([
        this.prisma.client.videoComparisonJob.updateMany({
          where: { id: jobRowId, status: { in: LIVE_STATUSES } },
          data: { status: job.status, stage: job.stage },
        }),
        // The run's own stage is whatever its calls last reported — with
        // several in flight there is no single truth, and the reader only
        // wants to know roughly what is happening.
        this.prisma.client.videoComparison.updateMany({
          where: { id: comparisonId, status: { in: LIVE_STATUSES } },
          data: { status: ComparisonStatus.RUNNING, stage: job.stage },
        }),
      ]);
    } catch (caught) {
      this.logger.warn(
        `Could not save progress for job ${jobRowId}: ${messageOf(caught)}`,
      );
    }
  }

  /**
   * Folds one terminal call into the run: its videos, its pairs, and then a
   * check on whether the run as a whole is finished.
   *
   * Pairs are merged rather than replaced. Batches overlap by design, so the
   * same pair can be reported by more than one call; the first row to land
   * wins, and `pairKey` is what makes "first" well-defined regardless of the
   * order the engine put the two videos in.
   *
   * One transaction, because a run marked SUCCEEDED with half its pairs
   * written would read as "these are the duplicates" and be wrong. If the
   * write fails the call stays non-terminal and the next poll tries again —
   * the engine's result is idempotent and still there.
   */
  private async saveResult(
    jobRowId: string,
    comparisonId: string,
    job: EngineJob,
  ): Promise<void> {
    const result = job.result;

    // Terminal with no result at all: a failed or timed-out call. There is
    // nothing to reconcile, only a reason to record.
    if (result === null) {
      await this.finishJob(jobRowId, comparisonId, {
        status: job.status,
        errorMessage:
          job.errorMessage ?? "The engine finished without returning a result.",
      });
      return;
    }

    try {
      await this.prisma.client.$transaction(async (tx) => {
        const run = await tx.videoComparison.findUnique({
          where: { id: comparisonId },
          include: { entries: true },
        });
        // Superseded, or deleted, while this call was running. Its result is
        // stale by definition — a newer run covers the same videos and more.
        if (run === null || isTerminal(run.status)) return;

        const resolved = resolveResult(run.entries, result);

        for (const video of resolved.videos) {
          await tx.videoComparisonEntry.updateMany({
            where: { comparisonId, submissionId: video.submissionId },
            data: {
              engineKey: video.engineKey,
              ready: video.ready,
              durationSeconds: video.durationSeconds,
            },
          });
        }

        // skipDuplicates rather than delete-and-recreate: sibling calls have
        // already written some of these, and dropping their rows would make
        // the results flicker as each call lands.
        await tx.videoComparisonPair.createMany({
          data: resolved.pairs.map((pair) => ({ comparisonId, ...pair })),
          skipDuplicates: true,
        });

        await tx.videoComparisonJob.update({
          where: { id: jobRowId },
          data: {
            status: job.status,
            stage: "done",
            errorMessage: job.errorMessage,
            completedAt: new Date(),
          },
        });

        await closeRunIfDone(tx, comparisonId, result.engineVersion, this.logger);
      });
    } catch (caught) {
      // Left non-terminal on purpose — the next poll retries against a job the
      // engine still holds.
      this.logger.error(
        `Could not save the result for job ${jobRowId}: ${messageOf(caught)}`,
      );
    }
  }

  /** Marks one call terminal without a result, then re-checks the run. */
  private async finishJob(
    jobRowId: string,
    comparisonId: string,
    data: { status: ComparisonStatus; errorMessage: string },
  ): Promise<void> {
    try {
      await this.prisma.client.$transaction(async (tx) => {
        await tx.videoComparisonJob.updateMany({
          where: { id: jobRowId, status: { in: LIVE_STATUSES } },
          data: { ...data, completedAt: new Date() },
        });
        await closeRunIfDone(tx, comparisonId, null, this.logger);
      });
      this.logger.warn(
        `Comparison job ${jobRowId} ended as ${data.status}: ${data.errorMessage}`,
      );
    } catch (caught) {
      this.logger.error(
        `Could not close comparison job ${jobRowId}: ${messageOf(caught)}`,
      );
    }
  }

  /* -------------------------------------------------------------------- dtos */

  private toSummary(row: VideoComparison): ComparisonSummaryDto {
    return {
      id: row.id,
      campaignId: row.campaignId,
      status: row.status,
      stage: row.stage,
      pairsDone: row.pairsDone,
      pairsTotal: row.pairsTotal,
      videoCount: row.videoCount,
      flaggedPairCount: row.flaggedPairCount,
      engineVersion: row.engineVersion,
      errorMessage: row.errorMessage,
      triggerSubmissionId: row.triggerSubmissionId,
      createdAt: row.createdAt,
      completedAt: row.completedAt,
    };
  }

  /**
   * A run as this caller may see it.
   *
   * An admin gets everything. An editor gets the verdict on their own videos
   * and nothing that identifies the counterpart: the other video keeps its
   * id — the UI needs *something* to key a row on — but its name, its editor
   * and its timings are stripped, and pairs between two videos that are both
   * someone else's are dropped entirely. So an editor learns "this cut of
   * mine duplicates another submission on this campaign" and cannot learn
   * whose, which is the same line SubmissionsService already draws.
   *
   * Groups are admin-only for the same reason: a cluster is a statement about
   * several editors' work at once.
   */
  private toDto(row: ComparisonRow, user: AuthenticatedUser): ComparisonDto {
    const isAdmin = user.role === Role.ADMIN;
    const isOwn = (submissionId: string): boolean =>
      row.entries.some(
        (entry) =>
          entry.submissionId === submissionId &&
          entry.submission.editorId === user.id,
      );

    // Every video stays on the roster even for an editor: a pair needs both
    // of its sides present to render at all, and a redacted entry says
    // "someone else's" without saying whose.
    const videos: ComparisonVideoDto[] = row.entries.map((entry) => {
      const own = isAdmin || entry.submission.editorId === user.id;
      return {
        submissionId: entry.submissionId,
        fileName: own ? entry.submission.fileName : "Another submission",
        editorId: own ? entry.submission.editorId : "",
        editorName: own ? entry.submission.editor.name : "Another editor",
        submittedAt: own ? entry.submission.createdAt : new Date(0),
        ready: entry.ready,
        // A duration is a fingerprint of someone else's cut, and it is only
        // rendered beside a name anyway.
        durationSeconds: own ? entry.durationSeconds : null,
      };
    });

    const pairs: ComparisonPairDto[] = row.pairs
      .filter(
        (pair) =>
          isAdmin || isOwn(pair.aSubmissionId) || isOwn(pair.bSubmissionId),
      )
      .map((pair) => ({
        id: pair.id,
        aSubmissionId: pair.aSubmissionId,
        bSubmissionId: pair.bSubmissionId,
        score: pair.score,
        verdict: pair.verdict,
        containment: pair.containment,
        // The evidence names timings and coverage of *both* sides, so an
        // editor gets it only when both sides are their own — which is the
        // common case, since most duplicates are someone re-uploading their
        // own cut. Against another editor's video it would describe a cut
        // they may not see.
        evidence:
          isAdmin || (isOwn(pair.aSubmissionId) && isOwn(pair.bSubmissionId))
            ? pair.evidence
            : null,
      }));

    return {
      ...this.toSummary(row),
      videos,
      pairs,
      groups: isAdmin ? buildGroups(pairs) : [],
    };
  }
}

/** A video and pair, with the engine's keys already turned into our own ids. */
export interface ResolvedResult {
  videos: {
    submissionId: string;
    engineKey: string;
    ready: boolean;
    durationSeconds: number | null;
  }[];
  pairs: Omit<Prisma.VideoComparisonPairCreateManyInput, "comparisonId">[];
}

/**
 * Turns an engine result into rows, across the two hops it takes to get from
 * a pair back to a submission.
 *
 * **Hop one:** `result.videos[]` carries the URL we submitted beside the
 * engine's own key for it, and `entries` maps that URL back to a submission.
 * **Hop two:** `pairs[].a/b` are those keys, never URLs — the single most
 * common way to get this integration wrong is to treat them as URLs.
 *
 * Anything that cannot complete both hops is dropped rather than guessed at:
 * a URL we never submitted has no row to attach to, and a pair naming a key
 * no video declared cannot be placed against real videos.
 */
export function resolveResult(
  entries: readonly { submissionId: string; url: string }[],
  result: EngineResult,
): ResolvedResult {
  const submissionByUrl = new Map(
    entries.map((entry) => [entry.url, entry.submissionId]),
  );
  const submissionByKey = new Map<string, string>();
  const videos: ResolvedResult["videos"] = [];

  for (const video of result.videos) {
    const submissionId = submissionByUrl.get(video.url);
    if (submissionId === undefined) continue;
    submissionByKey.set(video.key, submissionId);
    videos.push({
      submissionId,
      engineKey: video.key,
      ready: video.ready,
      durationSeconds: video.durationSeconds,
    });
  }

  const seen = new Set<string>();
  const pairs: ResolvedResult["pairs"] = [];

  for (const pair of result.pairs) {
    const a = submissionByKey.get(pair.aKey);
    const b = submissionByKey.get(pair.bKey);
    // A pair of a video with itself says nothing, and would break the unique
    // constraint's assumption that a pair has two sides.
    if (a === undefined || b === undefined || a === b) continue;

    // Deduped on the unordered pair: score, verdict and containment are all
    // symmetric, so {a,b} and {b,a} are the same comparison. The stored order
    // stays the engine's, because `evidence` has an `a` side and a `b` side
    // that must keep pointing at the videos they describe — which is exactly
    // why the unordered identity needs a column of its own.
    const canonical = pairKeyOf(a, b);
    if (seen.has(canonical)) continue;
    seen.add(canonical);

    pairs.push({
      aSubmissionId: a,
      bSubmissionId: b,
      pairKey: canonical,
      score: pair.score,
      verdict: pair.verdict,
      containment: pair.containment,
      // Omitted rather than set to null: Prisma reads a literal `null` on a
      // Json column as "the JSON value null" and wants Prisma.DbNull for an
      // empty one. Leaving the field out says the same thing without the
      // ceremony.
      ...(pair.evidence === null || pair.evidence === undefined
        ? {}
        : { evidence: pair.evidence as Prisma.InputJsonValue }),
    });
  }

  // Appearing in a pair is proof of having been fingerprinted, whatever the
  // status string said. This is what keeps the "could not be read" warning
  // honest when the engine adds a status we do not recognise — a vocabulary
  // change can no longer turn a compared video into a reported failure.
  const compared = new Set(
    pairs.flatMap((pair) => [pair.aSubmissionId, pair.bSubmissionId]),
  );
  for (const video of videos) {
    if (compared.has(video.submissionId)) video.ready = true;
  }

  return { videos, pairs };
}

/**
 * Clusters videos that are related to each other.
 *
 * Connected components over every pair that is not NO_MATCH — the engine's own
 * rule (a score of 25 is exactly the NO_MATCH boundary), applied to the pairs
 * that were stored rather than read from its `summary.groups`. Same answer,
 * and it cannot drift out of step with the pairs the UI actually renders.
 *
 * Transitivity is intended: A-B and B-C put all three together even when A-C
 * was never strong, because that is usually one cut circulating in three
 * edits. `minScore` is the weakest edge holding the group together, and is
 * where to look when a group seems too generous.
 */
export function buildGroups(pairs: ComparisonPairDto[]): ComparisonGroupDto[] {
  const flagged = pairs.filter(
    (pair) => pair.verdict !== ComparisonVerdict.NO_MATCH,
  );
  if (flagged.length === 0) return [];

  const parent = new Map<string, string>();

  function find(id: string): string {
    const seen = parent.get(id);
    if (seen === undefined) {
      parent.set(id, id);
      return id;
    }
    if (seen === id) return id;
    const root = find(seen);
    parent.set(id, root); // Path compression.
    return root;
  }

  for (const pair of flagged) {
    const a = find(pair.aSubmissionId);
    const b = find(pair.bSubmissionId);
    if (a !== b) parent.set(a, b);
  }

  const members = new Map<string, string[]>();
  for (const id of parent.keys()) {
    const root = find(id);
    const group = members.get(root);
    if (group === undefined) members.set(root, [id]);
    else group.push(id);
  }

  const groups: ComparisonGroupDto[] = [];
  for (const [root, submissionIds] of members) {
    const scores = flagged
      .filter((pair) => find(pair.aSubmissionId) === root)
      .map((pair) => pair.score);

    groups.push({
      submissionIds,
      minScore: Math.min(...scores),
      maxScore: Math.max(...scores),
    });
  }

  // Biggest cluster first, then the most certain — the order an admin wants
  // to work through them in.
  return groups.sort(
    (left, right) =>
      right.submissionIds.length - left.submissionIds.length ||
      right.maxScore - left.maxScore,
  );
}

/**
 * Splits a campaign's videos into engine calls, keeping every pair covered.
 *
 * The engine takes at most `maxUrls` per call, so above that a run cannot be
 * one call — and naively chunking the list would silently stop comparing
 * videos in different chunks, which is the one thing this feature must not
 * do. Instead the videos are cut into blocks of `maxUrls / 2` and every
 * *pair of blocks* is submitted together: a pair of videos in the same block
 * travels together in every call that block appears in, and a pair in
 * different blocks travels together in the call that joins those two blocks.
 * So every pair is covered at least once, and none is missed.
 *
 * The cost is overlap — 5 videos need 3 calls of 4 rather than 1 of 5 — but
 * the engine caches per video URL, so the repeated videos are fingerprinted
 * once and only the pair comparisons are repeated.
 */
export function planBatches(
  submissionIds: readonly string[],
  maxUrls: number,
): string[][] {
  // Small enough to compare in one go: no overlap, no waste.
  if (submissionIds.length <= maxUrls) return [[...submissionIds]];

  // Two blocks have to fit in one call, so a block is at most half a call.
  const blockSize = Math.max(1, Math.floor(maxUrls / 2));
  const blocks: string[][] = [];
  for (let index = 0; index < submissionIds.length; index += blockSize) {
    blocks.push([...submissionIds.slice(index, index + blockSize)]);
  }

  const batches: string[][] = [];
  for (let left = 0; left < blocks.length; left += 1) {
    for (let right = left + 1; right < blocks.length; right += 1) {
      batches.push([...blocks[left]!, ...blocks[right]!]);
    }
  }
  return batches;
}

/**
 * Closes a run once every call it is made of has finished.
 *
 * The run's status is the *worst* outcome among its calls, not the last one:
 * if any batch failed, some pairs were never compared, and reporting
 * SUCCEEDED would claim a coverage the run does not have. PARTIAL says
 * exactly what happened — "some of this was checked".
 *
 * A free function rather than a method so it can be called from inside a
 * transaction with the transaction's own client.
 */
async function closeRunIfDone(
  tx: Prisma.TransactionClient,
  comparisonId: string,
  engineVersion: string | null,
  logger: Logger,
): Promise<void> {
  const run = await tx.videoComparison.findUnique({
    where: { id: comparisonId },
    include: { jobs: true },
  });
  if (run === null || isTerminal(run.status)) return;

  const pairs = await tx.videoComparisonPair.findMany({
    where: { comparisonId },
    select: { verdict: true },
  });
  const flagged = pairs.filter(
    (pair) => pair.verdict !== ComparisonVerdict.NO_MATCH,
  ).length;

  const unfinished = run.jobs.filter((job) => !isTerminal(job.status));
  if (unfinished.length > 0) {
    // Still going: keep the counters current so the bar advances as each call
    // lands, rather than jumping at the very end.
    await tx.videoComparison.update({
      where: { id: comparisonId },
      data: {
        status: ComparisonStatus.RUNNING,
        pairsDone: pairs.length,
        flaggedPairCount: flagged,
        ...(engineVersion === null ? {} : { engineVersion }),
      },
    });
    return;
  }

  const failed = run.jobs.filter(
    (job) => job.status !== ComparisonStatus.SUCCEEDED,
  );
  const status =
    failed.length === run.jobs.length
      ? ComparisonStatus.FAILED
      : failed.length > 0
        ? ComparisonStatus.PARTIAL
        : ComparisonStatus.SUCCEEDED;

  await tx.videoComparison.update({
    where: { id: comparisonId },
    data: {
      status,
      stage: "done",
      pairsDone: pairs.length,
      pairsTotal: Math.max(pairs.length, run.pairsTotal),
      flaggedPairCount: flagged,
      ...(engineVersion === null ? {} : { engineVersion }),
      errorMessage:
        failed.length === 0
          ? run.errorMessage
          : (run.errorMessage ??
            failed.find((job) => job.errorMessage !== null)?.errorMessage ??
            `${failed.length} of ${run.jobs.length} comparison batches did not finish.`),
      completedAt: new Date(),
    },
  });

  await applyDuplicationScores(tx, run.campaignId, comparisonId);

  logger.log(
    `Comparison ${comparisonId} finished as ${status} with ${pairs.length} pair(s) from ${run.jobs.length} engine call(s)`,
  );
}

/**
 * Rolls a finished run's pairs up into one score per submission.
 *
 * The run stores pairs; a feed, a threshold and a dashboard all need a single
 * number per video, which is what this writes.
 *
 * `duplicationScore` is the MAX rather than the mean: a video 95% identical to
 * one other and unrelated to eight more averages out to ~12% and would read as
 * clean. The mean is kept alongside it for display only.
 *
 * Every submission that went into the run is written, including those that
 * appear in no pair — they score 0 ("checked, matched nothing"), which is not
 * the same as the null they carried before ("never checked").
 */
async function applyDuplicationScores(
  tx: Prisma.TransactionClient,
  campaignId: string,
  comparisonId: string,
): Promise<void> {
  const [campaign, entries, pairs] = await Promise.all([
    tx.campaign.findUnique({
      where: { id: campaignId },
      select: { duplicationThreshold: true },
    }),
    tx.videoComparisonEntry.findMany({
      where: { comparisonId },
      select: { submissionId: true },
    }),
    tx.videoComparisonPair.findMany({
      where: { comparisonId },
      select: { aSubmissionId: true, bSubmissionId: true, score: true },
    }),
  ]);
  if (campaign === null || entries.length === 0) return;

  const scores = rollUpScores(
    entries.map((entry) => entry.submissionId),
    pairs,
    campaign.duplicationThreshold,
  );

  const checkedAt = new Date();
  for (const score of scores) {
    await tx.videoSubmission.update({
      where: { id: score.submissionId },
      data: {
        duplicationScore: score.duplicationScore,
        averageDuplicationScore: score.averageDuplicationScore,
        topMatchSubmissionId: score.topMatchSubmissionId,
        overThreshold: score.overThreshold,
        duplicationCheckedAt: checkedAt,
      },
    });
  }
}

export interface SubmissionDuplicationScore {
  submissionId: string;
  duplicationScore: number;
  averageDuplicationScore: number;
  topMatchSubmissionId: string | null;
  overThreshold: boolean;
}

/**
 * The per-submission roll-up, as a pure function over one run's pairs.
 *
 * Split out from the write so the arithmetic — which is the part with edge
 * cases — can be tested without a database.
 */
export function rollUpScores(
  submissionIds: readonly string[],
  pairs: readonly {
    aSubmissionId: string;
    bSubmissionId: string;
    score: number;
  }[],
  threshold: number,
): SubmissionDuplicationScore[] {
  const totals = new Map<
    string,
    { max: number; sum: number; count: number; topMatchId: string | null }
  >();
  for (const submissionId of submissionIds) {
    totals.set(submissionId, { max: 0, sum: 0, count: 0, topMatchId: null });
  }

  // A pair contributes to both of its sides, so walk each one twice.
  for (const pair of pairs) {
    for (const [selfId, otherId] of [
      [pair.aSubmissionId, pair.bSubmissionId],
      [pair.bSubmissionId, pair.aSubmissionId],
    ] as const) {
      const row = totals.get(selfId);
      if (row === undefined) continue;
      row.sum += pair.score;
      row.count += 1;
      if (pair.score > row.max) {
        row.max = pair.score;
        row.topMatchId = otherId;
      }
    }
  }

  return [...totals].map(([submissionId, row]) => ({
    submissionId,
    duplicationScore: round1(row.max),
    averageDuplicationScore: row.count === 0 ? 0 : round1(row.sum / row.count),
    topMatchSubmissionId: row.topMatchId,
    overThreshold: row.max >= threshold,
  }));
}

/** One decimal, matching how the engine reports scores. */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
