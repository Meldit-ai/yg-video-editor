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
  /**
   * Videos that earn a fee: the editor's own work, plus anything that reached
   * Instagram. A video that is both counts once.
   */
  payableCount: number;
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
  /**
   * What this campaign owes, at each editor's rate card.
   *
   * Null when no editor who worked on it has a rate agreed — which is not the
   * same as zero. Counts only payable videos: the editor's own work, and
   * anything that reached Instagram. See `payableVideos`.
   */
  spend: number | null;
  /** Payable videos that carried a rate, out of `payableVideos`. */
  pricedVideos: number;
  /**
   * Videos that earn a fee: UNIQUE, or matched to a tracker reel.
   *
   * A cut handed in twice is one piece of work, so an unposted copy earns
   * nothing — but a copy that got posted is paid for the posting. A video that
   * is both unique and posted counts once.
   */
  payableVideos: number;
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
  /** Every campaign's spend added up. Null when nothing could be priced. */
  totalSpend: number | null;
  /**
   * What is paid for repeated cuts that were posted anyway.
   *
   * Not every duplicate — an unposted one earns nothing — so this is the cost
   * of the same footage reaching Instagram more than once.
   */
  duplicateSpend: number | null;
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
   * Repeated work: how many distinct cuts were handed in more than once, and
   * the worst offender.
   *
   * The number an admin can act on. "64 duplicates" is a tally; "one cut was
   * handed in 15 times" is a conversation with an editor.
   */
  repetition: {
    /** Cuts that came in more than once. */
    clusters: number;
    /** Videos sitting inside those clusters — the repeated work itself. */
    repeatedVideos: number;
    /** The most-copied cut, if there is one. */
    worst: {
      submissionId: string;
      campaignId: string;
      campaignTitle: string;
      fileName: string;
      copies: number;
    } | null;
  };

  /**
   * What is wrong *now*, per campaign — not a lifetime tally.
   *
   * Counting every failure ever recorded showed 19 failed runs on a system
   * whose last run succeeded, because each dev restart had marked one failed.
   * A panel that is permanently red is a panel nobody reads, so this reports
   * only the latest run per campaign and videos still awaiting a check.
   */
  health: {
    campaignId: string;
    campaignTitle: string;
    /** Status of the most recent run, or null if none has ever run. */
    lastRunStatus: string | null;
    lastRunAt: string | null;
    /** Videos with no label yet on this campaign. */
    unchecked: number;
  }[];
}
