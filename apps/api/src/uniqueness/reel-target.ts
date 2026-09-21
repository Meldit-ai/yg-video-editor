import { Injectable } from "@nestjs/common";
import { ComparisonStatus, Uniqueness, type Prisma } from "@repo/database";
import { PrismaService } from "../prisma/prisma.service.js";
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
const PENDING = { uniqueness: null, checkedAt: null } as const;

/**
 * The ETag as a content identity. Object storage returns it quoted, and a
 * multipart upload's ETag (`<md5>-<parts>`) is a hash of part hashes rather
 * than of the bytes — still identical for identical uploads, so it is kept.
 */
function identityFromEtag(etag: string | null): string | undefined {
  if (etag === null) return undefined;
  const bare = etag.trim().replace(/^W\//, "").replace(/^"|"$/g, "");
  return bare.length === 0 ? undefined : `etag:${bare}`;
}

/**
 * Oldest post first. A reel with no post time cannot claim to be anyone's
 * original, so it sorts after every reel that has one; import time breaks
 * ties either way.
 */
const ARRIVAL_ORDER = [
  { postedAt: { sort: "asc", nulls: "last" } },
  { createdAt: "asc" },
] satisfies Prisma.CampaignReelOrderByWithRelationInput[];

/**
 * The classifier's view of `CampaignReel`.
 *
 * The engine is given `mediaUrl` exactly as the tracker supplied it — the
 * engine's cache identity is the URL string, and normalising it would orphan
 * every fingerprint already stored. The audit trail is one `ReelMatchRun`
 * per batch with counters; per-call rows are not written, because the
 * existing `ReelMatchJob`/`ReelMatchPair` tables model a submission against
 * reels, not a reel against reels.
 */
@Injectable()
export class ReelTarget implements UniquenessTarget {
  readonly kind = "reel" as const;

  constructor(private readonly prisma: PrismaService) {}

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
    const rows = await this.prisma.client.campaignReel.findMany({
      where: {
        campaignId,
        active: true,
        originalReelId: parentId,
        uniqueness: { in: [Uniqueness.PARTIAL, Uniqueness.DUPLICATE] },
      },
      select: { id: true },
      orderBy: ARRIVAL_ORDER,
    });
    return rows.map((row) => row.id);
  }

  countActive(campaignId: string): Promise<number> {
    return this.prisma.client.campaignReel.count({
      where: { campaignId, active: true },
    });
  }

  async writeOutcome(id: string, outcome: Outcome, checkedAt: Date): Promise<void> {
    await this.prisma.client.campaignReel.update({
      where: { id },
      data: {
        uniqueness: outcome.uniqueness,
        duplicationScore: outcome.matchValue,
        originalReelId: outcome.parentId,
        isOriginal: outcome.uniqueness === Uniqueness.UNIQUE,
        checkedAt,
      },
    });
  }

  async markUnreadable(id: string, checkedAt: Date): Promise<void> {
    await this.prisma.client.campaignReel.update({
      where: { id },
      data: { uniqueness: null, isOriginal: false, checkedAt },
    });
  }

  async resetLabels(campaignId: string, ids?: readonly string[]): Promise<number> {
    const { count } = await this.prisma.client.campaignReel.updateMany({
      where: {
        campaignId,
        active: true,
        ...(ids === undefined ? {} : { id: { in: [...ids] } }),
      },
      data: { uniqueness: null, checkedAt: null, isOriginal: false },
    });
    return count;
  }

  /** See `SubmissionTarget.relabelForThreshold`; same three bands. */
  async relabelForThreshold(
    tx: Prisma.TransactionClient,
    campaignId: string,
    threshold: number,
  ): Promise<void> {
    const labelled = { campaignId, active: true, uniqueness: { not: null } };
    const uniqueCeiling = Math.min(threshold, PARTIAL_FLOOR);

    await tx.campaignReel.updateMany({
      where: {
        ...labelled,
        originalReelId: { not: null },
        duplicationScore: { gte: threshold },
      },
      data: { uniqueness: Uniqueness.DUPLICATE, isOriginal: false },
    });
    await tx.campaignReel.updateMany({
      where: {
        ...labelled,
        originalReelId: { not: null },
        duplicationScore: { gte: uniqueCeiling, lt: threshold },
      },
      data: { uniqueness: Uniqueness.PARTIAL, isOriginal: false },
    });
    await tx.campaignReel.updateMany({
      where: {
        ...labelled,
        OR: [{ originalReelId: null }, { duplicationScore: { lt: uniqueCeiling } }],
      },
      data: { uniqueness: Uniqueness.UNIQUE, isOriginal: true },
    });
  }

  /* ------------------------------------------------------------- audit */

  async openRun(campaignId: string, opening: RunOpening): Promise<string> {
    const row = await this.prisma.client.reelMatchRun.create({
      data: {
        campaignId,
        status: ComparisonStatus.QUEUED,
        threshold: opening.threshold,
        triggerReelId: opening.triggerId,
        reelCount: opening.candidateCount,
      },
      select: { id: true },
    });
    return row.id;
  }

  async recordCall(_runId: string, _call: CallRecord): Promise<void> {
    // Counters on the run are the whole record for reels today.
  }

  async updateRun(runId: string, progress: RunProgress): Promise<void> {
    await this.prisma.client.reelMatchRun.update({
      where: { id: runId },
      data: {
        status: ComparisonStatus.RUNNING,
        pairsDone: progress.pairsDone,
        pairsTotal: progress.pairsTotal,
        reelCount: progress.videoCount,
        matchCount: progress.matchCount,
      },
    });
  }

  async closeRun(runId: string, closing: RunClosing): Promise<void> {
    await this.prisma.client.reelMatchRun.update({
      where: { id: runId },
      data: {
        status: closing.status,
        errorMessage: closing.errorMessage,
        completedAt: new Date(),
      },
    });
  }

  /* -------------------------------------------------------------- boot */

  async failLiveRuns(reason: string): Promise<number> {
    const { count } = await this.prisma.client.reelMatchRun.updateMany({
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
    const rows = await this.prisma.client.campaignReel.findMany({
      where: { active: true, ...PENDING, campaign: { active: true } },
      select: { campaignId: true },
      distinct: ["campaignId"],
    });
    return rows.map((row) => row.campaignId);
  }

  private async candidates(
    where: Prisma.CampaignReelWhereInput,
  ): Promise<Candidate[]> {
    const rows = await this.prisma.client.campaignReel.findMany({
      where,
      select: { id: true, mediaUrl: true, postedAt: true, createdAt: true, mediaEtag: true },
      orderBy: ARRIVAL_ORDER,
    });
    return rows.map((row) => ({
      id: row.id,
      url: row.mediaUrl,
      arrivedAt: row.postedAt ?? row.createdAt,
      identity: identityFromEtag(row.mediaEtag),
    }));
  }
}
