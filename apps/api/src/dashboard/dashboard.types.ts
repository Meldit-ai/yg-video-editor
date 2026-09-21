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

/** One campaign's shape, for the admin overview. */
export interface AdminCampaignStat {
  campaignId: string;
  campaignTitle: string;
  videos: number;
  duplicates: number;
  unique: number;
  unchecked: number;
  editors: number;
}

/**
 * The whole operation at a glance, for an admin.
 *
 * Separate from EditorDashboardStats, which is deliberately one person's own
 * work: an admin opening that sees their own (usually empty) submissions,
 * which is honest but useless as a landing page.
 */
export interface AdminDashboardStats {
  activeCampaigns: number;
  editors: number;
  videos: number;
  duplicates: number;
  unique: number;
  unchecked: number;
  /** Rate asks waiting on an admin — something to act on, not just a number. */
  pendingRates: number;
  /** Campaigns by size, largest first. */
  perCampaign: AdminCampaignStat[];

  /**
   * How each editor's work is landing. The number an admin is really asking
   * for is what share of someone's hand-ins is original, which a raw count of
   * videos cannot answer.
   */
  perEditor: {
    editorId: string;
    editorName: string;
    videos: number;
    unique: number;
    duplicates: number;
    /** Unique as a share of what was checked. Null when nothing has been. */
    originalRate: number | null;
  }[];

  /**
   * Things that are failing, and so want attention.
   *
   * Both are counted because a number nobody can act on is decoration: a
   * failed vendor send means work did not reach the vendor, and a failed
   * comparison run means videos are sitting unchecked.
   */
  attention: {
    /** Vendor sends that never arrived. */
    failedShares: number;
    totalShareRecipients: number;
    /** Comparison runs that ended FAILED, against those that succeeded. */
    failedRuns: number;
    succeededRuns: number;
  };
}
