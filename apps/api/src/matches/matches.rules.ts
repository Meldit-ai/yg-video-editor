/**
 * Frames a video must yield before it can match anything.
 *
 * A two-second clip produces one sample, which would then "share all of its
 * frames" with anything containing that one still. Requiring several makes a
 * match evidence of shared footage rather than of a shared moment.
 */
export const MIN_FRAMES = 4;

/** One video's overlap with another, as counted from the signature index. */
export interface FrameOverlap {
  /** Distinct signatures of the shorter video that appear in the longer one. */
  shared: number;
  /** Distinct signatures the shorter video has at all. */
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
 * **Every** frame of the shorter video must appear in the longer one. Not a
 * tuned threshold — measured over every pair on a real campaign, the split is
 * total:
 *
 *   | overlap of the shorter video | pairs | actually the same file |
 *   |------------------------------|-------|------------------------|
 *   | 100%                         |   173 |                    119 |
 *   | 90-99%                       |   112 |                      0 |
 *   | 80-89%                       |   109 |                      0 |
 *   | 70-79%                       |    54 |                      0 |
 *   | below 70%                    |   117 |                      0 |
 *
 * Nothing below 100% was ever the same video, so there is no number to tune
 * and no band where a judgement call is needed. The pairs at 100% that are not
 * byte-identical were checked by hand and are genuine — the same video
 * re-encoded by two accounts, which is exactly what a file hash cannot see.
 *
 * Measuring against the *shorter* side is deliberate: a reel carrying the edit
 * plus a long outro still contains the edit, and dividing by the longer side
 * would hide that.
 */
export function isSameFootage(overlap: FrameOverlap): boolean {
  if (overlap.total < MIN_FRAMES) return false;
  return overlap.shared >= overlap.total;
}
