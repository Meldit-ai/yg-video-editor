/**
 * Wire types for campaign reels and duplicate checking. Mirrored in
 * apps/web/src/lib/types.ts — keep the two in step.
 */

export interface CampaignReelDto {
  id: string;
  username: string;
  socialUsername: string;
  permalink: string | null;
  /** When it went live on Instagram. Null when upstream sent nothing usable. */
  postedAt: Date | null;
  caption: string | null;
  postCounts: unknown;

  /**
   * How duplicated this reel is, 0-100.
   *
   * Measured only against reels posted BEFORE it, so the earliest reel in a
   * group is the original at 0 and every later copy carries a score. Null
   * means it has not been checked yet.
   */
  duplicationScore: number | null;
  /** The earlier reel it scored highest against. */
  originalReelId: string | null;
  originalUsername: string | null;
  /** True when nothing earlier matched it — this is the original. */
  isOriginal: boolean;
  checkedAt: Date | null;
}

export interface ReelImportResultDto {
  campaignId: string;
  /** Reels now stored for this campaign, after the import. */
  totalReels: number;
  imported: number;
  updated: number;
  /** Posts skipped because they were not a single-video reel. */
  skipped: number;
}

export interface ReelCheckRunDto {
  id: string;
  campaignId: string;
  status: string;
  threshold: number;
  reelCount: number;
  pairsDone: number;
  pairsTotal: number;
  /** Reels found to be a copy of something earlier. */
  matchCount: number;
  errorMessage: string | null;
  createdAt: Date;
  completedAt: Date | null;
}
