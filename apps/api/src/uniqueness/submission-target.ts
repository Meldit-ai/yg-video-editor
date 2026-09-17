import { Injectable } from "@nestjs/common";
import { ComparisonStatus, Uniqueness, type Prisma } from "@repo/database";
import { PrismaService } from "../prisma/prisma.service.js";
import { StorageService } from "../storage/storage.service.js";
import { PARTIAL_FLOOR, type Candidate, type Outcome } from "./uniqueness.rules.js";
import type {
  CallRecord,
  RunClosing,
  RunOpening,
  RunProgress,
  UniquenessTarget,
} from "./uniqueness.types.js";

const LIVE: ComparisonStatus[] = [
  ComparisonStatus.QUEUED,
  ComparisonStatus.RUNNING,
];

/** A row with no label and no checked-at: still to be classified. */
const PENDING = { uniqueness: null, duplicationCheckedAt: null } as const;

/**
 * The classifier's view of `VideoSubmission`.
 *
 * Arrival order is upload time. The engine is given the unsigned public
 * object URL: the engine caches by URL, and a presigned one would carry a
 * timestamp and look like a new file on every run.
 *
 * The audit trail is the `VideoComparison` family: one run per batch, one
 * `VideoComparisonJob` per engine call with the candidate first in
 * `submissionIds`, entries for every video sent, and pairs for the
 * candidate's side only.
 */
@Injectable()
export class SubmissionTarget implements UniquenessTarget {
  readonly kind = "submission" as const;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async loadThreshold(campaignId: string): Promise<number | null> {
    const row = await this.prisma.client.campaign.findFirst({
      where: { id: campaignId, active: true },
      select: { duplicationThreshold: true },
    });
    return row?.duplicationThreshold ?? null;
  }

  loadPending(campaignId: string): Promise<Candidate[]> {
    return this.candidates({ campaignId, active: true, ...PENDING });
  }

  loadBaseline(campaignId: string): Promise<Candidate[]> {
    return this.candidates({
      campaignId,
      active: true,
      uniqueness: { in: [Uniqueness.UNIQUE, Uniqueness.PARTIAL] },
    });
  }

  async loadDependants(campaignId: string, parentId: string): Promise<string[]> {
    const rows = await this.prisma.client.videoSubmission.findMany({
      where: {
        campaignId,
        active: true,
        topMatchSubmissionId: parentId,
        uniqueness: { in: [Uniqueness.PARTIAL, Uniqueness.DUPLICATE] },
      },
      select: { id: true },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((row) => row.id);
  }

  countActive(campaignId: string): Promise<number> {
    return this.prisma.client.videoSubmission.count({
      where: { campaignId, active: true },
    });
  }

  async writeOutcome(id: string, outcome: Outcome, checkedAt: Date): Promise<void> {
    await this.prisma.client.videoSubmission.update({
      where: { id },
      data: {
        uniqueness: outcome.uniqueness,
        duplicationScore: outcome.matchValue,
        averageDuplicationScore: outcome.averageValue,
        topMatchSubmissionId: outcome.parentId,
        overThreshold: outcome.uniqueness === Uniqueness.DUPLICATE,
        duplicationCheckedAt: checkedAt,
      },
    });
  }

  async markUnreadable(id: string, checkedAt: Date): Promise<void> {
    await this.prisma.client.videoSubmission.update({
      where: { id },
      data: { uniqueness: null, duplicationCheckedAt: checkedAt },
    });
  }

  async resetLabels(campaignId: string, ids?: readonly string[]): Promise<number> {
    const { count } = await this.prisma.client.videoSubmission.updateMany({
      where: {
        campaignId,
        active: true,
        ...(ids === undefined ? {} : { id: { in: [...ids] } }),
      },
      data: { uniqueness: null, duplicationCheckedAt: null, overThreshold: false },
    });
    return count;
  }

  /**
   * The three bands of `labelFor`, as three `updateMany`s over the rows that
   * already have a label. Top-down like the function: a threshold below the
   * floor leaves the PARTIAL band empty and pulls UNIQUE's ceiling down to
   * the threshold, so the admin's number wins over the engine's floor.
   */
  async relabelForThreshold(
    tx: Prisma.TransactionClient,
    campaignId: string,
    threshold: number,
  ): Promise<void> {
    const labelled = { campaignId, active: true, uniqueness: { not: null } };
    const uniqueCeiling = Math.min(threshold, PARTIAL_FLOOR);

    await tx.videoSubmission.updateMany({
      where: {
        ...labelled,
        topMatchSubmissionId: { not: null },
        duplicationScore: { gte: threshold },
      },
      data: { uniqueness: Uniqueness.DUPLICATE, overThreshold: true },
    });
    await tx.videoSubmission.updateMany({
      where: {
        ...labelled,
        topMatchSubmissionId: { not: null },
        duplicationScore: { gte: uniqueCeiling, lt: threshold },
      },
      data: { uniqueness: Uniqueness.PARTIAL, overThreshold: false },
    });
    await tx.videoSubmission.updateMany({
      where: {
        ...labelled,
        OR: [
          { topMatchSubmissionId: null },
          { duplicationScore: { lt: uniqueCeiling } },
        ],
      },
      data: { uniqueness: Uniqueness.UNIQUE, overThreshold: false },
    });
  }

  /* ------------------------------------------------------------- audit */

  async openRun(campaignId: string, opening: RunOpening): Promise<string> {
    const row = await this.prisma.client.videoComparison.create({
      data: {
        campaignId,
        triggerSubmissionId: opening.triggerId,
        status: ComparisonStatus.QUEUED,
        videoCount: opening.candidateCount,
      },
      select: { id: true },
    });
    return row.id;
  }

  async recordCall(runId: string, call: CallRecord): Promise<void> {
    const sent = [call.candidate, ...call.slice];
    await this.prisma.client.videoComparisonJob.create({
      data: {
        comparisonId: runId,
        jobId: call.jobId,
        status: call.status,
        submissionIds: sent.map((video) => video.id),
        stage: "done",
        errorMessage: call.errorMessage,
        completedAt: new Date(),
      },
    });
    if (call.resolved === null) return;

    // skipDuplicates: a baseline video is sent again for every candidate in
    // the batch, and its entry row from the first call is the one to keep.
    await this.prisma.client.videoComparisonEntry.createMany({
      data: sent.map((video) => ({
        comparisonId: runId,
        submissionId: video.id,
        url: video.url,
      })),
      skipDuplicates: true,
    });
    for (const video of call.resolved.videos) {
      await this.prisma.client.videoComparisonEntry.updateMany({
        where: { comparisonId: runId, submissionId: video.submissionId },
        data: {
          engineKey: video.engineKey,
          ready: video.ready,
          durationSeconds: video.durationSeconds,
        },
      });
    }
    if (call.resolved.pairs.length > 0) {
      await this.prisma.client.videoComparisonPair.createMany({
        data: call.resolved.pairs.map((pair) => ({ comparisonId: runId, ...pair })),
        skipDuplicates: true,
      });
    }
  }

  async updateRun(runId: string, progress: RunProgress): Promise<void> {
    await this.prisma.client.videoComparison.update({
      where: { id: runId },
      data: {
        status: ComparisonStatus.RUNNING,
        stage: progress.stage,
        pairsDone: progress.pairsDone,
        pairsTotal: progress.pairsTotal,
        videoCount: progress.videoCount,
      },
    });
  }

  async closeRun(runId: string, closing: RunClosing): Promise<void> {
    await this.prisma.client.videoComparison.update({
      where: { id: runId },
      data: {
        status: closing.status,
        stage: "done",
        errorMessage: closing.errorMessage,
        engineVersion: closing.engineVersion,
        flaggedPairCount: closing.flaggedPairCount,
        completedAt: new Date(),
      },
    });
  }

  /* -------------------------------------------------------------- boot */

  async failLiveRuns(reason: string): Promise<number> {
    const { count } = await this.prisma.client.videoComparison.updateMany({
      where: { active: true, status: { in: LIVE } },
      data: {
        status: ComparisonStatus.FAILED,
        errorMessage: reason,
        completedAt: new Date(),
      },
    });
    return count;
  }

  async campaignsWithPending(): Promise<string[]> {
    const rows = await this.prisma.client.videoSubmission.findMany({
      where: { active: true, ...PENDING, campaign: { active: true } },
      select: { campaignId: true },
      distinct: ["campaignId"],
    });
    return rows.map((row) => row.campaignId);
  }

  /** Rows matching `where`, oldest first, as what the engine needs. */
  private async candidates(
    where: Prisma.VideoSubmissionWhereInput,
  ): Promise<Candidate[]> {
    const rows = await this.prisma.client.videoSubmission.findMany({
      where,
      select: { id: true, objectKey: true, createdAt: true, contentSha256: true },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((row) => ({
      id: row.id,
      url: this.storage.publicObjectUrl(row.objectKey),
      arrivedAt: row.createdAt,
      identity:
        row.contentSha256 === null ? undefined : `sha256:${row.contentSha256}`,
    }));
  }
}
