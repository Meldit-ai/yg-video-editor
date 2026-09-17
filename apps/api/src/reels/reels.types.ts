/**
 * Wire types for campaign reels and duplicate checking. Mirrored in
 * apps/web/src/lib/types.ts — keep the two in step.
 */
import type { Uniqueness } from "@repo/database";

export interface CampaignReelDto {
  id: string;
  username: string;
  socialUsername: string;
  permalink: string | null;
  /**
   * The reel's own .mp4, public on the tracker's storage. Played directly in
   * a <video>; there is no signing to do, since it is not ours to sign.
   */
  mediaUrl: string;
  /** When it went live on Instagram. Null when upstream sent nothing usable. */
  postedAt: Date | null;
  caption: string | null;
  postCounts: unknown;

  /**
   * Where this reel stands against the reels posted before it — null while
   * it is still to be checked, or when the engine could not read it (then
   * `checkedAt` is set). See CampaignReel.uniqueness.
   */
  uniqueness: Uniqueness | null;
  /**
   * Match value, 0-100: the highest max(score, containment) against any
   * baseline reel posted before it. Null means not checked yet; 0 means
   * there was nothing to compare against.
   */
  duplicationScore: number | null;
  /** The earlier reel it scored highest against — its parent when not UNIQUE. */
  originalReelId: string | null;
  /** The parent's profile, when this reel is PARTIAL or DUPLICATE. */
  originalUsername: string | null;
  /** Derived: `uniqueness === "UNIQUE"`. Kept one release for the reels page. */
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
