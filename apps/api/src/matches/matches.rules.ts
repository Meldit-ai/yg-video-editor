/**
 * The share of an upload's frames that must also appear in a reel before the
 * two are called the same footage.
 *
 * Measured on this campaign, on a real reel and re-encodes of it:
 *
 *   | case                              | frames shared |
 *   |-----------------------------------|---------------|
 *   | same video, re-encoded (CRF 28)   |         92.2% |
 *   | same video, CRF 34 + 480p resize  |         73.4% |
 *   | a different video                 |          0.0% |
 *
 * Nothing lands between 0% and 73%, so the exact number is not delicate; 40
 * sits in the middle of an empty gap. It is deliberately not higher: the
 * harsher re-encode is the case this exists to catch, and a bar above 73 would
 * reject it.
 */
export const MATCH_FRAME_SHARE = 40;

/**
 * Frames a video must yield before it can match anything.
 *
 * A two-second clip produces one sample, which would then "share 100% of its
 * frames" with anything containing that one still. Requiring several makes a
 * match evidence of shared footage rather than of a shared moment.
 */
export const MIN_FRAMES = 4;

/** One video's overlap with another, as counted from the signature index. */
export interface FrameOverlap {
  /** Distinct signatures of this video that also appear in the other. */
  shared: number;
  /** Distinct signatures this video has at all. */
  total: number;
}

/** The share of frames in common, 0-100, rounded to one decimal. */
export function frameShare(overlap: FrameOverlap): number {
  if (overlap.total === 0) return 0;
  return Math.round((overlap.shared / overlap.total) * 1000) / 10;
}

/**
 * Whether two videos are the same footage.
 *
 * Both sides of the test matter. A short video is excluded outright, and the
 * share is measured against the *upload's* frame count rather than the reel's:
 * a reel that contains the upload plus a long outro should still match, and
 * measuring against the longer side would hide it.
 */
export function isSameFootage(overlap: FrameOverlap): boolean {
  if (overlap.total < MIN_FRAMES) return false;
  return frameShare(overlap) >= MATCH_FRAME_SHARE;
}
