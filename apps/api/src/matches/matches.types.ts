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
  /** Edits that matched at least one reel. */
  matchCount: number;
  matches: MatchGroupDto[];
}

/** One reel carrying an edit's footage, inside a match group. */
export interface MatchedReelDto {
  reelId: string;
  username: string;
  permalink: string | null;
  postedAt: Date | null;
  reelUrl: string;
  /** Whether this reel went live before the edit was handed in. */
  origin: MatchOrigin;
  /** Set when this reel is the very same file as the edit. */
  contentHash: string | null;
}

/**
 * One edit and every reel found to carry the same video.
 *
 * Grouped rather than listed pair by pair: the same cut is often posted by
 * several accounts, and seeing them together is what shows how far it spread.
 * Every reel in a group is an exact match to the edit — the group is not a
 * ranking, and there is no weaker member.
 */
export interface MatchGroupDto {
  submissionId: string;
  fileName: string;
  editorName: string;
  uploadedAt: Date;
  playbackUrl: string;

  /** Oldest post first, so the earliest publisher reads at the top. */
  reels: MatchedReelDto[];

  /**
   * Which side published first, taken over the whole group: REEL when any reel
   * predates the edit, EDITOR when the edit predates all of them, UNKNOWN when
   * no reel carries a date to judge by.
   */
  origin: MatchOrigin;

  checkedAt: Date;
}
