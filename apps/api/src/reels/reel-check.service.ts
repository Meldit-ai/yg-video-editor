import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { ComparisonStatus } from "@repo/database";
import { ComparisonEngineClient } from "../comparisons/comparison-engine.client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import type { ReelCheckRunDto } from "./reels.types.js";

/** URLs the engine takes per call. Its own cap is 10. */
const MAX_URLS_PER_CALL = 10;

/** How long to wait on one engine job before giving up on it. */
const MAX_WAIT_MS = 30 * 60 * 1000;
const POLL_MS = 4_000;

/**
 * Checking a campaign's reels against each other.
 *
 * The rule is "whoever posted first is the original": every reel is compared
 * only against reels posted BEFORE it, so the earliest in a matching group
 * keeps a score of 0 and each later copy carries a score against it. That
 * ordering is the whole point — comparing both ways would leave two reels each
 * claiming the other was the copy.
 *
 * Runs to completion in the caller's request rather than in a background
 * poller: a check is an explicit "go and look" that an admin waits on, and the
 * engine's fingerprint cache makes every run after the first one quick.
 */
@Injectable()
export class ReelCheckService {
  private readonly logger = new Logger(ReelCheckService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: ComparisonEngineClient,
  ) {}

  /** The most recent check on a campaign, or null if none has run. */
  async findLatest(campaignId: string): Promise<ReelCheckRunDto | null> {
    const row = await this.prisma.client.reelMatchRun.findFirst({
      where: { campaignId, active: true },
      orderBy: { createdAt: "desc" },
    });
    return row === null ? null : toDto(row);
  }

  /**
   * Marks any run left mid-flight by a restart as failed.
   *
   * A check lives in a background task, not a database queue, so a restart
   * ends it with the row still saying RUNNING. Left alone that row blocks the
   * next check forever and reads as "still working" to anyone watching.
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      const { count } = await this.prisma.client.reelMatchRun.updateMany({
        where: { status: ComparisonStatus.RUNNING },
        data: {
          status: ComparisonStatus.FAILED,
          errorMessage: "The server restarted while this check was running.",
          completedAt: new Date(),
        },
      });
      if (count > 0) {
        this.logger.warn(`Marked ${count} interrupted reel check(s) as failed`);
      }
    } catch (caught) {
      // A database that is not up yet must not stop the app booting.
      const reason = caught instanceof Error ? caught.message : String(caught);
      this.logger.warn(`Could not sweep interrupted reel checks: ${reason}`);
    }
  }

  /**
   * Starts a check and returns immediately.
   *
   * The work runs in the background because a first pass takes the better part
   * of an hour — far longer than any HTTP timeout between here and a browser.
   * Progress is read back from the run row, which is written as each reel
   * finishes.
   */
  async start(campaignId: string): Promise<ReelCheckRunDto> {
    const running = await this.prisma.client.reelMatchRun.findFirst({
      where: { campaignId, status: ComparisonStatus.RUNNING },
    });
    // One at a time: a second run would compare the same pairs concurrently
    // and race the first one writing its scores.
    if (running !== null) return toDto(running);

    // Created here so the caller gets a row to poll immediately; the work
    // itself is fire-and-forget. It never throws — a failure is recorded on
    // the row, which is the only place anyone will look for it.
    const created = await this.createRun(campaignId);
    void this.execute(created.id, campaignId).catch((caught: unknown) => {
      const reason = caught instanceof Error ? caught.message : String(caught);
      this.logger.error(`Reel check ${created.id} failed: ${reason}`);
      void this.prisma.client.reelMatchRun.update({
        where: { id: created.id },
        data: {
          status: ComparisonStatus.FAILED,
          errorMessage: reason,
          completedAt: new Date(),
        },
      });
    });
    return toDto(created);
  }

  private async execute(runId: string, campaignId: string): Promise<void> {
    const [campaign, reels] = await Promise.all([
      this.prisma.client.campaign.findFirst({
        where: { id: campaignId, active: true },
        select: { duplicationThreshold: true, title: true },
      }),
      this.prisma.client.campaignReel.findMany({
        where: { campaignId, active: true },
        select: { id: true, mediaUrl: true, postedAt: true, username: true },
        // Oldest first: position in this list IS the claim to being original.
        orderBy: [{ postedAt: "asc" }, { createdAt: "asc" }],
      }),
    ]);

    if (campaign === null) throw new BadRequestException("Campaign not found");
    if (reels.length < 2) {
      throw new BadRequestException(
        "At least 2 reels are needed to check for duplicates. Import some first.",
      );
    }

    const threshold = campaign.duplicationThreshold;
    const pairsTotal = (reels.length * (reels.length - 1)) / 2;

    await this.prisma.client.reelMatchRun.update({
      where: { id: runId },
      data: { threshold, reelCount: reels.length, pairsTotal },
    });
    const run = { id: runId };

    this.logger.log(
      `Checking ${reels.length} reel(s) on "${campaign.title}" — ${pairsTotal} pair(s), threshold ${threshold}`,
    );

    // The best (highest) score each reel reached against anything earlier, and
    // which earlier reel that was.
    const best = new Map<string, { score: number; againstId: string }>();
    const idByUrl = new Map(reels.map((reel) => [reel.mediaUrl, reel.id]));

    let pairsDone = 0;
    let failed = 0;
    let matchCount = 0;

    // Each reel against everything before it, in slices the engine will take.
    // The candidate is pinned in every call, so a slice of size N covers N
    // pairs with no overlap — unlike the all-against-all case, which needs
    // overlapping batches to cover every pair.
    for (let index = 1; index < reels.length; index += 1) {
      const candidate = reels[index]!;
      const earlier = reels.slice(0, index);

      for (let start = 0; start < earlier.length; start += MAX_URLS_PER_CALL - 1) {
        const slice = earlier.slice(start, start + MAX_URLS_PER_CALL - 1);
        const urls = [candidate.mediaUrl, ...slice.map((reel) => reel.mediaUrl)];

        try {
          const scores = await this.comparePinned(urls, candidate.mediaUrl);
          for (const [otherUrl, score] of scores) {
            const otherId = idByUrl.get(otherUrl);
            if (otherId === undefined) continue;
            const current = best.get(candidate.id);
            if (current === undefined || score > current.score) {
              best.set(candidate.id, { score, againstId: otherId });
            }
          }
        } catch (caught) {
          failed += 1;
          const reason = caught instanceof Error ? caught.message : String(caught);
          this.logger.warn(`Reel check call failed: ${reason}`);
        }

        pairsDone += slice.length;
        await this.prisma.client.reelMatchRun.update({
          where: { id: run.id },
          data: { pairsDone },
        });
      }

      // Written as each reel finishes rather than all at the end: a first run
      // takes the better part of an hour, and a list that stays empty until
      // the last pair lands reads as broken rather than busy.
      const match = best.get(candidate.id);
      const isCopy = match !== undefined && match.score >= threshold;
      if (isCopy) matchCount += 1;
      await this.writeScore(candidate.id, match, threshold);
      await this.prisma.client.reelMatchRun.update({
        where: { id: run.id },
        data: { matchCount },
      });
    }

    // The earliest reel had nothing before it to be a copy of, so it is the
    // original by definition. Written last because nothing above touches it.
    await this.writeScore(reels[0]!.id, undefined, threshold);

    await this.prisma.client.reelMatchRun.update({
      where: { id: run.id },
      data: {
        status:
          failed === 0 ? ComparisonStatus.SUCCEEDED : ComparisonStatus.PARTIAL,
        pairsDone,
        matchCount,
        errorMessage:
          failed === 0 ? null : `${failed} engine call(s) did not finish.`,
        completedAt: new Date(),
      },
    });

    this.logger.log(
      `Reel check finished: ${matchCount} of ${reels.length} reel(s) are copies of something earlier`,
    );
  }

  /** The row a caller polls, created before any work starts. */
  private async createRun(campaignId: string) {
    return this.prisma.client.reelMatchRun.create({
      data: { campaignId, status: ComparisonStatus.RUNNING, threshold: 0 },
    });
  }

  /**
   * Scores every URL in `urls` against `pinned`, ignoring pairs between the
   * others — they are earlier reels, and their own comparison happened when
   * each of them was the candidate.
   */
  private async comparePinned(
    urls: string[],
    pinned: string,
  ): Promise<Map<string, number>> {
    const jobId = await this.engine.submit(urls);
    const startedAt = Date.now();

    for (;;) {
      const job = await this.engine.fetchJob(jobId);

      if (
        job.status === ComparisonStatus.SUCCEEDED ||
        job.status === ComparisonStatus.PARTIAL
      ) {
        const scores = new Map<string, number>();
        const urlByKey = new Map(
          (job.result?.videos ?? []).map((video) => [video.key, video.url]),
        );
        for (const pair of job.result?.pairs ?? []) {
          const aUrl = urlByKey.get(pair.aKey);
          const bUrl = urlByKey.get(pair.bKey);
          if (aUrl === undefined || bUrl === undefined) continue;
          // Only pairs involving the pinned reel matter here.
          const other =
            aUrl === pinned ? bUrl : bUrl === pinned ? aUrl : null;
          if (other === null) continue;
          scores.set(other, pair.score);
        }
        return scores;
      }

      if (
        job.status === ComparisonStatus.FAILED ||
        job.status === ComparisonStatus.TIMEOUT
      ) {
        throw new Error(job.errorMessage ?? `engine job ${job.status}`);
      }

      if (Date.now() - startedAt > MAX_WAIT_MS) {
        throw new Error("engine job did not finish in time");
      }
      await sleep(POLL_MS);
    }
  }

  /**
   * Writes one reel's verdict.
   *
   * A reel with no earlier match scores 0 and is the original — including the
   * very first, which had nothing before it to be a copy of.
   */
  private async writeScore(
    reelId: string,
    match: { score: number; againstId: string } | undefined,
    threshold: number,
  ): Promise<void> {
    const score = match?.score ?? 0;
    const isCopy = match !== undefined && score >= threshold;

    await this.prisma.client.campaignReel.update({
      where: { id: reelId },
      data: {
        duplicationScore: score,
        originalReelId: isCopy ? match.againstId : null,
        isOriginal: !isCopy,
        checkedAt: new Date(),
      },
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toDto(row: {
  id: string;
  campaignId: string;
  status: ComparisonStatus;
  threshold: number;
  reelCount: number;
  pairsDone: number;
  pairsTotal: number;
  matchCount: number;
  errorMessage: string | null;
  createdAt: Date;
  completedAt: Date | null;
}): ReelCheckRunDto {
  return {
    id: row.id,
    campaignId: row.campaignId,
    status: row.status,
    threshold: row.threshold,
    reelCount: row.reelCount,
    pairsDone: row.pairsDone,
    pairsTotal: row.pairsTotal,
    matchCount: row.matchCount,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
  };
}
