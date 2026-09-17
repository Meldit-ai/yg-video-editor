import { Injectable } from "@nestjs/common";
import { Role } from "@repo/database";
import type { AuthenticatedUser } from "../auth/auth.types.js";
import { PrismaService } from "../prisma/prisma.service.js";
import type {
  DashboardCampaignStat,
  EditorDashboardStats,
} from "./dashboard.types.js";

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * One editor's own numbers, read from their active submissions.
   *
   * Scoped to `editorId` rather than filtered afterwards, so this can never
   * report someone else's work — the same rule SubmissionsService follows.
   */
  async statsFor(user: AuthenticatedUser): Promise<EditorDashboardStats> {
    const rows = await this.prisma.client.videoSubmission.findMany({
      where: { editorId: user.id, active: true },
      select: {
        campaignId: true,
        duplicationScore: true,
        overThreshold: true,
        campaign: { select: { title: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    // Admins never carry a rate card, so their earnings are null by the same
    // rule as an editor whose rate is not agreed yet.
    const rateCard = user.role === Role.EDITOR ? user.rateCard : null;

    const perCampaign = new Map<string, DashboardCampaignStat>();
    let scoreSum = 0;
    let scoredCount = 0;

    for (const row of rows) {
      const stat = perCampaign.get(row.campaignId) ?? {
        campaignId: row.campaignId,
        campaignTitle: row.campaign.title,
        videos: 0,
        duplicates: 0,
      };
      stat.videos += 1;
      if (row.overThreshold) stat.duplicates += 1;
      perCampaign.set(row.campaignId, stat);

      // Only videos a run has actually reached carry a score; a null one has
      // not been compared, and averaging it in as 0 would flatter the number.
      if (row.duplicationScore !== null) {
        scoreSum += row.duplicationScore;
        scoredCount += 1;
      }
    }

    return {
      videosUploaded: rows.length,
      duplicateCount: rows.filter((row) => row.overThreshold).length,
      averageDuplicationScore:
        scoredCount === 0 ? null : round1(scoreSum / scoredCount),
      campaignsContributed: perCampaign.size,
      estimatedEarnings:
        rateCard === null ? null : round2(rateCard * rows.length),
      rateCard,
      perCampaign: [...perCampaign.values()].sort(
        (left, right) => right.videos - left.videos,
      ),
    };
  }
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Rupees and paise — matches the two decimal places a rate card allows. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
