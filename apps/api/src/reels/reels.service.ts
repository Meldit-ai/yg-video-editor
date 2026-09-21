import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { Uniqueness, type Prisma } from "@repo/database";
import { PrismaService } from "../prisma/prisma.service.js";
import { TrackerService, type TrackerReel } from "../tracker/tracker.service.js";
import { UniquenessService } from "../uniqueness/uniqueness.service.js";
import { headMediaAll } from "./media-head.js";
import type { CampaignReelDto, ReelImportResultDto } from "./reels.types.js";

const WITH_ORIGINAL = {
  select: {
    id: true,
    username: true,
    socialUsername: true,
    permalink: true,
    mediaUrl: true,
    postedAt: true,
    caption: true,
    postCounts: true,
    uniqueness: true,
    duplicationScore: true,
    originalReelId: true,
    isOriginal: true,
    checkedAt: true,
  },
} satisfies Prisma.CampaignReelDefaultArgs;

type ReelRow = Prisma.CampaignReelGetPayload<typeof WITH_ORIGINAL>;

/**
 * Instagram reels pulled from the external tracker for a campaign.
 *
 * An import takes the campaign whole. Holding a subset is not a cheaper version
 * of the same thing: originality is decided by post date, so a missing earlier
 * reel silently promotes a copy. Whatever bound the classifier wants belongs on
 * the classifier — this only decides what is on record.
 *
 * Instagram only, by `post_type`. The same campaign carries Twitter, Reddit and
 * Facebook posts, including Facebook reels, and none of them belong here.
 */
@Injectable()
export class ReelsService {
  private readonly logger = new Logger(ReelsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tracker: TrackerService,
    private readonly uniqueness: UniquenessService,
  ) {}

  /**
   * Pulls every Instagram reel on the campaign from the tracker and stores it.
   *
   * The whole campaign, not a window. Which reel is the original is decided by
   * post date, so holding a subset would crown whichever copy happened to be
   * the oldest one imported — the earliest reel has to be present for any of
   * the later ones to be classified correctly.
   *
   * Ordering is the tracker's, by post date ascending; the local sort below is
   * what guarantees it rather than assuming upstream honoured the request.
   */
  async importFromTracker(campaignId: string): Promise<ReelImportResultDto> {
    const campaign = await this.prisma.client.campaign.findFirst({
      where: { id: campaignId, active: true },
      select: { trackerCampaignId: true, title: true },
    });
    if (campaign === null) {
      throw new BadRequestException("Campaign not found");
    }
    if (campaign.trackerCampaignId === null) {
      throw new BadRequestException(
        "This campaign is not linked to a tracker campaign, so there are no reels to import.",
      );
    }

    const fetched = await this.tracker.listReels(campaign.trackerCampaignId);

    // Oldest first, and reels with no date last: a reel whose posting time is
    // unknown cannot be shown to precede anything, so it must not be allowed
    // to claim the original's place.
    const ordered = [...fetched].sort(compareByPostedAt);
    // One read for the whole campaign instead of one per reel. At a few
    // thousand reels the per-row lookup this replaces was the slowest part of
    // an import that otherwise only writes.
    const existing = await this.prisma.client.campaignReel.findMany({
      where: { campaignId },
      select: { trackerPostId: true },
    });
    const known = new Set(existing.map((row) => row.trackerPostId));

    // Size and ETag for every reel, from a HEAD apiece. Hetzner's ETag is the
    // MD5 of a single-part object, so this tells two reels apart — or proves
    // them the same file — without downloading either.
    const withIdentity = withMediaIdentity(
      ordered,
      await headMediaAll(ordered.map((reel) => reel.mediaUrl)),
    );

    let imported = 0;
    let updated = 0;

    for (const batch of chunk(withIdentity, UPSERT_BATCH)) {
      // Batched rather than one transaction over the lot: a single transaction
      // holding thousands of writes is a long lock, and an import that fails
      // halfway has still stored what it read.
      await this.prisma.client.$transaction(
        batch.map((reel) =>
          this.prisma.client.campaignReel.upsert({
            where: {
              campaignId_trackerPostId: {
                campaignId,
                trackerPostId: reel.trackerPostId,
              },
            },
            create: { campaignId, ...reelRowFrom(reel) },
            // Labels are deliberately not cleared on re-import: re-running an
            // import must not throw away a classification that already ran.
            update: reelRowFrom(reel),
          }),
        ),
      );

      for (const reel of batch) {
        if (known.has(reel.trackerPostId)) updated += 1;
        else imported += 1;
      }
    }

    const totalReels = await this.prisma.client.campaignReel.count({
      where: { campaignId, active: true },
    });

    this.logger.log(
      `Imported ${imported} new and updated ${updated} reel(s) for "${campaign.title}" (${totalReels} stored)`,
    );

    // New reels arrive unlabelled and are classified in the background, in
    // post order, against what the campaign already holds. A re-imported reel
    // keeps its label (`toRow` never touches it), so only new ones are work.
    if (imported > 0) this.uniqueness.onArrival("reel", campaignId);

    return {
      campaignId,
      totalReels,
      imported,
      updated,
      // Nothing is held back any more, so this is only ever the reels the
      // tracker offered that were not usable — no media URL, no handle.
      skipped: 0,
    };
  }

  /**
   * A campaign's stored reels, most original first: by label (the enum is
   * declared UNIQUE, PARTIAL, DUPLICATE), then by match value within it.
   *
   * Unchecked reels sort last rather than first: Postgres orders nulls first
   * ascending, which would open the list with reels nobody has looked at,
   * presented as the most original ones.
   */
  async findAll(campaignId: string): Promise<CampaignReelDto[]> {
    const rows = await this.prisma.client.campaignReel.findMany({
      where: { campaignId, active: true },
      ...WITH_ORIGINAL,
      orderBy: [
        { uniqueness: { sort: "asc", nulls: "last" } },
        { duplicationScore: { sort: "asc", nulls: "last" } },
        { postedAt: "asc" },
      ],
    });

    // One lookup for every original referenced, so a row can name the profile
    // it was copied from rather than an opaque id.
    const originalIds = rows
      .map((row) => row.originalReelId)
      .filter((id): id is string => id !== null);
    const originals =
      originalIds.length === 0
        ? []
        : await this.prisma.client.campaignReel.findMany({
            where: { id: { in: originalIds } },
            select: { id: true, username: true },
          });
    const usernameById = new Map(
      originals.map((original) => [original.id, original.username]),
    );

    return rows.map((row) => toDto(row, usernameById));
  }
}

/** Upserts per transaction. Small enough that no single lock is long. */
const UPSERT_BATCH = 100;

/** Splits a list into fixed-size runs, the last one short. */
function chunk<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push([...items.slice(index, index + size)]);
  }
  return batches;
}

/**
 * Attaches what object storage said about each reel's media. A HEAD that
 * failed leaves the fields absent, so the row keeps whatever it had.
 */
export function withMediaIdentity(
  reels: readonly TrackerReel[],
  heads: readonly { sizeBytes: number | null; etag: string | null }[],
): TrackerReel[] {
  return reels.map((reel, index) => {
    const head = heads[index];
    if (head === undefined || (head.sizeBytes === null && head.etag === null)) {
      return reel;
    }
    return { ...reel, mediaSizeBytes: head.sizeBytes, mediaEtag: head.etag };
  });
}

/** Oldest Instagram post first; unknown dates last. */
function compareByPostedAt(left: TrackerReel, right: TrackerReel): number {
  if (left.postedAt === null && right.postedAt === null) return 0;
  if (left.postedAt === null) return 1;
  if (right.postedAt === null) return -1;
  return left.postedAt.getTime() - right.postedAt.getTime();
}

/**
 * The columns an import writes, shared by create and update — and by the
 * `import-tracker-reels` script, so a reel looks the same whichever way it
 * came in. Deliberately never includes a label or score: a re-import must not
 * throw away a check that already ran.
 */
export function reelRowFrom(reel: TrackerReel) {
  return {
    trackerPostId: reel.trackerPostId,
    socialUsername: reel.socialUsername,
    username: reel.username,
    permalink: reel.permalink,
    mediaUrl: reel.mediaUrl,
    postedAt: reel.postedAt,
    postCounts: reel.postCounts as Prisma.InputJsonValue,
    caption: reel.caption,
    invoiceApproved: reel.invoiceApproved,
    // Only when a HEAD was made: `undefined` is "leave it" to Prisma, and a
    // re-import that skipped the HEAD must not erase a known identity.
    ...(reel.mediaSizeBytes === undefined ? {} : { mediaSizeBytes: reel.mediaSizeBytes }),
    ...(reel.mediaEtag === undefined ? {} : { mediaEtag: reel.mediaEtag }),
  };
}

function toDto(
  row: ReelRow,
  usernameById: Map<string, string>,
): CampaignReelDto {
  return {
    id: row.id,
    username: row.username,
    socialUsername: row.socialUsername,
    permalink: row.permalink,
    mediaUrl: row.mediaUrl,
    postedAt: row.postedAt,
    caption: row.caption,
    postCounts: row.postCounts,
    uniqueness: row.uniqueness,
    duplicationScore: row.duplicationScore,
    originalReelId: row.originalReelId,
    // A UNIQUE reel may still carry its best match — bookkeeping for a later
    // threshold edit — but it was not copied from anyone.
    originalUsername:
      row.originalReelId === null || row.uniqueness === Uniqueness.UNIQUE
        ? null
        : (usernameById.get(row.originalReelId) ?? null),
    isOriginal: row.isOriginal,
    checkedAt: row.checkedAt,
  };
}
