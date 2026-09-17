/**
 * Wire types for cross-platform matching. Mirrored in
 * apps/web/src/lib/types.ts — keep the two in step.
 */

/** Which side of a match went public first. */
export type MatchOrigin = "EDITOR" | "REEL" | "UNKNOWN";

/** One editor upload and one Instagram reel carrying identical bytes. */
export interface CrossPlatformMatchDto {
  id: string;

  submissionId: string;
  fileName: string;
  editorName: string;
  /** When the editor handed it in. */
  uploadedAt: Date;

  reelId: string;
  username: string;
  permalink: string | null;
  /** When it went live on Instagram. Null when upstream sent nothing usable. */
  postedAt: Date | null;

  /**
   * Which side is the original — the one that was published first.
   *
   * UNKNOWN when the reel has no post date: without it there is no claim to
   * being first, and guessing would name the wrong party as the copier.
   */
  origin: MatchOrigin;

  /** The shared SHA-256, so a match can be traced back to the bytes. */
  contentHash: string;

  checkedAt: Date;
}

export interface MatchRunResultDto {
  campaignId: string;
  /** Editor uploads hashed by this run — the rest already had one. */
  hashedSubmissions: number;
  hashedReels: number;
  /** Reels on the campaign that still have no hash, after this run. */
  unhashedReels: number;
  matchCount: number;
  matches: CrossPlatformMatchDto[];
}
