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
  /**
   * A signed URL for the edit, so the pair can be watched rather than taken on
   * trust. Short-lived, which is why it is minted per read and never stored.
   */
  playbackUrl: string;

  reelId: string;
  username: string;
  permalink: string | null;
  /** When it went live on Instagram. Null when upstream sent nothing usable. */
  postedAt: Date | null;
  /** The reel's own file. Public on the tracker's storage, so unsigned. */
  reelUrl: string;

  /**
   * Which side is the original — the one that was published first.
   *
   * UNKNOWN when the reel has no post date: without it there is no claim to
   * being first, and guessing would name the wrong party as the copier.
   */
  origin: MatchOrigin;

  /**
   * The shared SHA-256, when the two are the very same file.
   *
   * Null for a match found by frame signatures: the videos are the same
   * footage re-encoded, so there is no shared hash to point at.
   */
  contentHash: string | null;

  /**
   * How much of the upload's footage the reel carries, 0-100.
   *
   * 100 for an identical file. Below that it is the share of sampled frames
   * the two have exactly in common — measured, a re-encode keeps around 92%
   * and an unrelated video 0%.
   */
  frameShare: number;

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
