/**
 * Wire types for the editor dashboard. Mirrored in apps/web/src/lib/types.ts —
 * keep the two in step.
 */

export interface DashboardCampaignStat {
  campaignId: string;
  campaignTitle: string;
  videos: number;
  /** Videos on this campaign labelled DUPLICATE. */
  duplicates: number;
  /** Videos on this campaign labelled UNIQUE. */
  unique: number;
  /** Videos on this campaign no run has reached yet. */
  unchecked: number;
}

export interface EditorDashboardStats {
  videosUploaded: number;
  /**
   * Videos labelled DUPLICATE by the classifier.
   *
   * Read from `uniqueness`, not the deprecated `overThreshold` boolean, so this
   * agrees with the campaign feed and the reels view rather than reporting its
   * own separate number.
   */
  duplicateCount: number;
  /** Videos labelled UNIQUE — the editor's own original work. */
  uniqueCount: number;
  /**
   * Videos no comparison run has reached yet.
   *
   * Kept apart from the clean count on purpose: "not yet checked" is not the
   * same finding as "checked and original", and folding the two together
   * flatters the dashboard on a campaign mid-run.
   */
  uncheckedCount: number;
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
