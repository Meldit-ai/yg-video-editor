import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { ComparisonStatus } from "@repo/database";
import { PrismaService } from "../prisma/prisma.service.js";
import { UniquenessService } from "../uniqueness/uniqueness.service.js";
import type { ReelCheckRunDto } from "./reels.types.js";

/**
 * The admin's "check the reels" button.
 *
 * The rule is "whoever posted first is the original", and it is the
 * classifier's rule: every reel is labelled against the reels posted before
 * it — only the UNIQUE and PARTIAL ones, since a copy adds nothing to compare
 * against. Reels are classified as they are imported, so this button is a
 * *rebuild*: every label on the campaign is thrown away and the whole
 * campaign replayed in post order under the current threshold. That is what
 * lets a threshold change ripple forward, and it is the same code path an
 * import goes down, so the two cannot disagree.
 *
 * Returns as soon as the run row exists; the page polls `findLatest`.
 */
@Injectable()
export class ReelCheckService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly uniqueness: UniquenessService,
  ) {}

  /** The most recent check on a campaign, or null if none has run. */
  async findLatest(campaignId: string): Promise<ReelCheckRunDto | null> {
    const row = await this.prisma.client.reelMatchRun.findFirst({
      where: { campaignId, active: true },
      orderBy: { createdAt: "desc" },
    });
    return row === null ? null : toDto(row);
  }

  /** Starts a rebuild and returns the run to poll. */
  async start(campaignId: string): Promise<ReelCheckRunDto> {
    const reels = await this.prisma.client.campaignReel.count({
      where: { campaignId, active: true },
    });
    if (reels < 2) {
      throw new BadRequestException(
        "At least 2 reels are needed to check for duplicates. Import some first.",
      );
    }

    const runId = await this.uniqueness.rebuild("reel", campaignId);
    const row = await this.prisma.client.reelMatchRun.findFirst({
      where: { id: runId },
    });
    if (row === null) throw new NotFoundException(`Run ${runId} not found`);
    return toDto(row);
  }
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
