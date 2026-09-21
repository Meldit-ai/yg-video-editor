import { Injectable } from "@nestjs/common";
import { Role, SubmissionSource, Uniqueness } from "@repo/database";
import type { AuthenticatedUser } from "../auth/auth.types.js";
import { PrismaService } from "../prisma/prisma.service.js";
import type {
  AdminCampaignStat,
  AdminDashboardStats,
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
        // `uniqueness`, not the deprecated `overThreshold`: the schema notes
        // that boolean was kept one release for the feed and dashboard, and
        // the feed has since moved. Reading it here was why this page reported
        // a different duplicate count from every other screen.
        uniqueness: true,
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

    let duplicateCount = 0;
    let uniqueCount = 0;
    let uncheckedCount = 0;

    for (const row of rows) {
      const stat = perCampaign.get(row.campaignId) ?? {
        campaignId: row.campaignId,
        campaignTitle: row.campaign.title,
        videos: 0,
        duplicates: 0,
        unique: 0,
        unchecked: 0,
      };
      stat.videos += 1;

      // PARTIAL counts as neither. It means "shares something with an earlier
      // video, below the line the admin drew" — calling that a duplicate
      // accuses the editor on a score the campaign itself accepted, and
      // calling it unique hides it. It stays in `videos` and in the average.
      if (row.uniqueness === Uniqueness.DUPLICATE) {
        stat.duplicates += 1;
        duplicateCount += 1;
      } else if (row.uniqueness === Uniqueness.UNIQUE) {
        stat.unique += 1;
        uniqueCount += 1;
      } else if (row.uniqueness === null) {
        stat.unchecked += 1;
        uncheckedCount += 1;
      }
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
      duplicateCount,
      uniqueCount,
      uncheckedCount,
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

  /**
   * Everything an admin needs to start the day, across every campaign.
   *
   * Counts the editors' hand-ins only (`source: EDITOR`). Reels adopted from
   * the tracker are a separate pipeline with its own screens, and blending
   * them here would report numbers that disagree with the campaign feed.
   */
  async adminStats(): Promise<AdminDashboardStats> {
    const editorWork = {
      active: true,
      source: SubmissionSource.EDITOR,
    } as const;

    const [
      activeCampaigns,
      editors,
      pendingRates,
      byLabel,
      campaigns,
      recentRows,
    ] = await Promise.all([
      this.prisma.client.campaign.count({ where: { active: true } }),
      this.prisma.client.user.count({
        where: { role: Role.EDITOR, active: true },
      }),
      this.prisma.client.campaignRate.count({ where: { status: "PENDING" } }),
      // One grouped read rather than a count per label.
      this.prisma.client.videoSubmission.groupBy({
        by: ["campaignId", "uniqueness"],
        where: editorWork,
        _count: { _all: true },
      }),
      this.prisma.client.campaign.findMany({
        where: { active: true },
        select: { id: true, title: true },
      }),
      this.prisma.client.videoSubmission.findMany({
        where: editorWork,
        orderBy: { createdAt: "desc" },
        take: 8,
        select: {
          id: true,
          campaignId: true,
          fileName: true,
          uniqueness: true,
          duplicationScore: true,
          createdAt: true,
          campaign: { select: { title: true } },
          editor: { select: { name: true } },
        },
      }),
    ]);

    // Distinct editors per campaign needs its own grouping: the label
    // grouping above counts rows, not people.
    const editorsByCampaign = await this.prisma.client.videoSubmission.groupBy({
      by: ["campaignId", "editorId"],
      where: editorWork,
      _count: { _all: true },
    });

    const titleById = new Map(campaigns.map((row) => [row.id, row.title]));
    const perCampaign = new Map<string, AdminCampaignStat>();
    const blank = (campaignId: string): AdminCampaignStat => ({
      campaignId,
      campaignTitle: titleById.get(campaignId) ?? "Deleted campaign",
      videos: 0,
      duplicates: 0,
      unique: 0,
      unchecked: 0,
      editors: 0,
    });

    let videos = 0;
    let duplicates = 0;
    let unique = 0;
    let unchecked = 0;

    for (const row of byLabel) {
      const stat = perCampaign.get(row.campaignId) ?? blank(row.campaignId);
      const count = row._count._all;
      stat.videos += count;
      videos += count;
      // PARTIAL is counted in `videos` and nowhere else, as on the editor
      // dashboard: it is neither an accusation nor a clean bill.
      if (row.uniqueness === Uniqueness.DUPLICATE) {
        stat.duplicates += count;
        duplicates += count;
      } else if (row.uniqueness === Uniqueness.UNIQUE) {
        stat.unique += count;
        unique += count;
      } else if (row.uniqueness === null) {
        stat.unchecked += count;
        unchecked += count;
      }
      perCampaign.set(row.campaignId, stat);
    }

    for (const row of editorsByCampaign) {
      const stat = perCampaign.get(row.campaignId) ?? blank(row.campaignId);
      stat.editors += 1;
      perCampaign.set(row.campaignId, stat);
    }

    return {
      activeCampaigns,
      editors,
      videos,
      duplicates,
      unique,
      unchecked,
      pendingRates,
      perCampaign: [...perCampaign.values()].sort(
        (left, right) => right.videos - left.videos,
      ),
      recent: recentRows.map((row) => ({
        submissionId: row.id,
        campaignId: row.campaignId,
        campaignTitle: row.campaign.title,
        fileName: row.fileName,
        editorName: row.editor.name,
        uniqueness: row.uniqueness,
        duplicationScore: row.duplicationScore,
        createdAt: row.createdAt.toISOString(),
      })),
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
