/**
 * Wire types for the editor dashboard. Mirrored in apps/web/src/lib/types.ts —
 * keep the two in step.
 */

export interface DashboardCampaignStat {
  campaignId: string;
  campaignTitle: string;
  videos: number;
  /** Videos on this campaign that met its own threshold. */
  duplicates: number;
}

export interface EditorDashboardStats {
  videosUploaded: number;
  /** Videos flagged against their campaign's accepted-duplication level. */
  duplicateCount: number;
  /**
   * Mean `duplicationScore` over the videos that have been compared. Null when
   * none have — which is not the same as zero.
   */
  averageDuplicationScore: number | null;
  campaignsContributed: number;
  /**
   * rateCard x videosUploaded. Null when no rate is agreed yet, and the UI must
   * say so rather than showing 0 — nothing here models approval or payment, so
   * this is the value of work submitted, not money owed.
   */
  estimatedEarnings: number | null;
  rateCard: number | null;
  perCampaign: DashboardCampaignStat[];
}
