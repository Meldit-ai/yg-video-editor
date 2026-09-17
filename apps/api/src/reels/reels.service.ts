import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import type { Prisma } from "@repo/database";
import { PrismaService } from "../prisma/prisma.service.js";
import { TrackerService, type TrackerReel } from "../tracker/tracker.service.js";
import { DEFAULT_REEL_LIMIT } from "./dto/import-reels.dto.js";
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
 * Import is bounded and explicit rather than "fetch the campaign": a real
 * campaign carries over ten thousand reels, and checking them is quadratic, so
 * an unbounded import is weeks of work nobody asked for.
 */
@Injectable()
export class ReelsService {
  private readonly logger = new Logger(ReelsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tracker: TrackerService,
  ) {}

  /**
   * Pulls the campaign's reels from the tracker and stores them.
   *
   * Takes the OLDEST reels by Instagram post date, not the newest. The check
   * that follows treats the earliest reel in a matching group as the original,
   * so a window that excluded it would crown a copy instead — every later reel
   * would be measured against something that was itself taken from elsewhere.
   */
  async importFromTracker(
    campaignId: string,
    limit = DEFAULT_REEL_LIMIT,
  ): Promise<ReelImportResultDto> {
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
    const chosen = ordered.slice(0, limit);

    let imported = 0;
    let updated = 0;

    for (const reel of chosen) {
      const existing = await this.prisma.client.campaignReel.findUnique({
        where: {
          campaignId_trackerPostId: {
            campaignId,
            trackerPostId: reel.trackerPostId,
          },
        },
        select: { id: true },
      });

      await this.prisma.client.campaignReel.upsert({
        where: {
          campaignId_trackerPostId: {
            campaignId,
            trackerPostId: reel.trackerPostId,
          },
        },
        create: { campaignId, ...toRow(reel) },
        // Scores are deliberately not cleared on re-import: re-running an
        // import must not throw away a check that already ran.
        update: toRow(reel),
      });

      if (existing === null) imported += 1;
      else updated += 1;
    }

    const totalReels = await this.prisma.client.campaignReel.count({
      where: { campaignId, active: true },
    });

    this.logger.log(
      `Imported ${imported} new and updated ${updated} reel(s) for "${campaign.title}" (${totalReels} stored)`,
    );

    return {
      campaignId,
      totalReels,
      imported,
      updated,
      // Everything the tracker offered beyond what we took. Reported so a
      // caller can see the campaign is bigger than the window they asked for.
      skipped: Math.max(0, fetched.length - chosen.length),
    };
  }

  /**
   * A campaign's stored reels, most original first.
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

/** Oldest Instagram post first; unknown dates last. */
function compareByPostedAt(left: TrackerReel, right: TrackerReel): number {
  if (left.postedAt === null && right.postedAt === null) return 0;
  if (left.postedAt === null) return 1;
  if (right.postedAt === null) return -1;
  return left.postedAt.getTime() - right.postedAt.getTime();
}

/** The columns an import writes, shared by create and update. */
function toRow(reel: TrackerReel) {
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
    duplicationScore: row.duplicationScore,
    originalReelId: row.originalReelId,
    originalUsername:
      row.originalReelId === null
        ? null
        : (usernameById.get(row.originalReelId) ?? null),
    isOriginal: row.isOriginal,
    checkedAt: row.checkedAt,
  };
}
