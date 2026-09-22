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
  /**
   * Reels stored on the campaign at all.
   *
   * Zero means there was nothing to match against — either the campaign has no
   * tracker campaign linked, or its reels have not been imported. Without this
   * a run over an empty campaign reports "0 matches" exactly as a real check
   * that found none does, and the two mean very different things.
   */
  totalReels: number;
  /** Whether a tracker campaign is linked, which is what reels are pulled from. */
  trackerLinked: boolean;
  /** Edits that matched at least one reel. */
  matchCount: number;
  matches: MatchGroupDto[];
}

/** One reel carrying an edit's footage, inside a match group. */
/**
 * What one post earned on Instagram.
 *
 * Every field is optional because it comes from the tracker's own payload and
 * older reels carry fewer of them. `views` falls back to `reach` when a post
 * reports only the latter — they are not the same measure, but for ranking
 * "how far did this travel" the distinction matters less than having nothing.
 */
export interface ReelEngagement {
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  /** Saves. A strong signal: people keep what they mean to come back to. */
  saves: number | null;
  /**
   * Likes + comments + saves + shares — what people did, not how many saw it.
   *
   * Views measure reach; this measures response, and the two disagree often
   * enough to matter. On this campaign one account took 8% fewer views than
   * another and 60% more engagement, so ranking on views alone picks the
   * wrong account to push.
   *
   * Null when the payload carried none of the four.
   */
  engagement: number | null;
  /**
   * Engagement as a percentage of views, one decimal place.
   *
   * The comparable number: a small account at 9% is doing better with its
   * audience than a large one at 5%. Null when there is nothing to divide by.
   */
  engagementRate: number | null;
  /** True when `views` is standing in for a missing view count. */
  viewsFromReach: boolean;
}

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

  /** What this individual post earned. Null when the tracker sent no counts. */
  engagement: ReelEngagement | null;
}

/**
 * One edit and every reel found to carry the same video.
 *
 * Grouped rather than listed pair by pair: the same cut is often posted by
 * several accounts, and seeing them together is what shows how far it spread.
 * Every reel in a group is an exact match to the edit — the group is not a
 * ranking, and there is no weaker member.
 */
/** How the matched edits are ordered. */
export const MATCH_GROUP_SORTS = [
  "recent",
  "views",
  "engagement",
  "rate",
  "likes",
  "reels",
] as const;

export type MatchGroupSort = (typeof MATCH_GROUP_SORTS)[number];

export interface MatchGroupDto {
  submissionId: string;
  fileName: string;
  editorName: string;
  uploadedAt: Date;
  playbackUrl: string;

  /** Oldest post first, so the earliest publisher reads at the top. */
  reels: MatchedReelDto[];

  /**
   * Everything the reels carrying this edit earned, added up.
   *
   * The number the campaign is actually run for: one cut posted by nine
   * accounts is one piece of work with nine sets of counts, and the sum is
   * what says whether it was worth making.
   */
  totalEngagement: ReelEngagement & {
    /** Reels that reported any counts, out of the group. */
    countedReels: number;
    totalReels: number;
  };

  /**
   * Which side published first, taken over the whole group: REEL when any reel
   * predates the edit, EDITOR when the edit predates all of them, UNKNOWN when
   * no reel carries a date to judge by.
   */
  origin: MatchOrigin;

  checkedAt: Date;
}

/**
 * How one of an editor's own videos performed on Instagram.
 *
 * A deliberately separate shape from MatchGroupDto rather than a filtered copy
 * of it. An editor is shown that their work was posted and what it earned;
 * they are not shown how we know. So this carries no reelId (our tracker's
 * key), no contentHash (the matching method), no origin (a duplication
 * finding about their own hand-in), and no reelUrl (the tracker's media file).
 * The permalink is the public Instagram post, which anyone can open anyway.
 *
 * Building it as its own type means a field added to the admin DTO later
 * cannot leak here by default — it has to be added twice, on purpose.
 */
export interface EditorPostedVideoDto {
  submissionId: string;
  fileName: string;
  uploadedAt: Date;
  playbackUrl: string;

  /** Where it was posted, and what each post earned. */
  posts: {
    /** The account that posted it. */
    username: string;
    /** The public Instagram post. Null when the tracker has no link. */
    permalink: string | null;
    postedAt: Date | null;
    engagement: ReelEngagement | null;
  }[];

  /** Everything those posts earned, added up. */
  totalEngagement: ReelEngagement & {
    countedPosts: number;
    totalPosts: number;
  };
}
