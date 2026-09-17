import { Uniqueness } from "@repo/database";

/**
 * The rules of the uniqueness classifier, as pure functions.
 *
 * Nothing here touches the database or the engine: this file is the part of
 * the design with edge cases, and it is kept free of I/O so those can be
 * pinned down in tests with plain numbers. `UniquenessService` is the loop
 * that feeds it. The design is in
 * docs/superpowers/specs/2026-09-17-incremental-duplicate-detection-design.md.
 */

/**
 * The line between UNIQUE and PARTIAL.
 *
 * The engine's own NO_MATCH edge: below 25 it reports no resemblance at all.
 * Not an admin setting — the campaign threshold is the only knob, and it
 * draws the DUPLICATE line. An admin who sets the threshold *below* this
 * floor still gets what they asked for (see `labelFor`).
 */
export const PARTIAL_FLOOR = 25;

/** A video the classifier can hand to the engine. Submission or reel. */
export interface Candidate {
  id: string;
  /** What the engine is given — its cache identity, so it must be stable. */
  url: string;
  /** Position in the campaign's queue. Earlier is the original. */
  arrivedAt: Date;
  /**
   * An identity of the *bytes*, when known: `etag:<md5>` for a reel on
   * object storage, `sha256:<hex>` for an upload. Two videos with the same
   * identity are the same file, whatever their URLs, and need no engine.
   * Absent when it was never measured — and an absence never matches.
   */
  identity?: string;
}

/** One engine pair, seen from the candidate's side. */
export interface CandidateMatch {
  otherId: string;
  score: number;
  containment: number;
}

/** What classifying one candidate decides. */
export interface Outcome {
  uniqueness: Uniqueness;
  /** The highest `pairValue` against the baseline; 0 with no baseline. */
  matchValue: number;
  /** Mean `pairValue` over the baseline. Display only. */
  averageValue: number;
  /**
   * The baseline video behind `matchValue`. Set whenever there was one, even
   * for UNIQUE, so a later threshold edit can re-label without the engine.
   */
  parentId: string | null;
}

/**
 * How much one pair counts, 0-100.
 *
 * `containment` is what catches a clip lifted out of a longer video: most of
 * the long video is unmatched, so `score` stays modest, while nearly all of
 * the clip is inside it. Either signal on its own is enough to call a copy.
 */
export function pairValue(score: number, containment: number): number {
  return round1(Math.max(score, containment));
}

/**
 * The label for a match value.
 *
 * `hasParent` is false when the baseline was empty — the first video on a
 * campaign, or a candidate whose every call failed. That is UNIQUE by
 * definition, whatever the number says.
 *
 * Checked top-down so a threshold below the floor still wins: the floor is
 * the engine's idea of "no resemblance", the threshold is the admin's idea of
 * "a copy", and when the admin sets the bar lower than the engine's noise
 * floor the admin is the one who gets to be wrong.
 */
export function labelFor(
  matchValue: number,
  threshold: number,
  hasParent: boolean,
): Uniqueness {
  if (!hasParent) return Uniqueness.UNIQUE;
  if (matchValue >= threshold) return Uniqueness.DUPLICATE;
  if (matchValue >= PARTIAL_FLOOR) return Uniqueness.PARTIAL;
  return Uniqueness.UNIQUE;
}

/**
 * Folds every pair a candidate was part of into one outcome.
 *
 * The highest pair decides — max, not mean: a video 95% identical to one
 * baseline video and unrelated to eight more averages to ~12% and would read
 * as clean. Ties go to the earlier match, which with the baseline in arrival
 * order is the older video.
 */
export function classifyMatches(
  matches: readonly CandidateMatch[],
  threshold: number,
): Outcome {
  let best: { value: number; otherId: string } | null = null;
  let sum = 0;

  for (const match of matches) {
    const value = pairValue(match.score, match.containment);
    sum += value;
    if (best === null || value > best.value) {
      best = { value, otherId: match.otherId };
    }
  }

  const matchValue = best?.value ?? 0;
  return {
    uniqueness: labelFor(matchValue, threshold, best !== null),
    matchValue,
    averageValue: matches.length === 0 ? 0 : round1(sum / matches.length),
    parentId: best?.otherId ?? null,
  };
}

/** The columns of a resolved pair that the rules read. */
export interface PairSides {
  aSubmissionId: string;
  bSubmissionId: string;
  score: number;
  /** Absent on a row shape that leaves it to the column default of 0. */
  containment?: number;
}

/**
 * The pairs of one engine call that involve the candidate, oriented from it.
 *
 * A call is `[candidate, ...baseline slice]`, and the engine scores every
 * pair among them — including baseline-against-baseline, which was decided
 * when each of those was the candidate. Those are dropped here, not stored.
 */
export function matchesOf(
  candidateId: string,
  pairs: readonly PairSides[],
): CandidateMatch[] {
  const matches: CandidateMatch[] = [];
  for (const pair of pairs) {
    const otherId =
      pair.aSubmissionId === candidateId
        ? pair.bSubmissionId
        : pair.bSubmissionId === candidateId
          ? pair.aSubmissionId
          : null;
    if (otherId === null) continue;
    matches.push({
      otherId,
      score: pair.score,
      containment: pair.containment ?? 0,
    });
  }
  return matches;
}

/** The engine calls that check one candidate against a baseline. */
export interface PinnedPlan {
  /** Each call is the candidate first, then a slice of the baseline. */
  calls: Candidate[][];
  /**
   * Baseline videos that are the same file as the candidate — same URL, or
   * the same content identity. The engine refuses a job naming one URL
   * twice, and has nothing to add about identical bytes, so these are left
   * out of every call; the caller treats them as a perfect match instead,
   * which is what they are.
   */
  twins: Candidate[];
}

/** Same URL, or both sides know their bytes and they agree. */
export function isTwin(a: Candidate, b: Candidate): boolean {
  if (a.url === b.url) return true;
  return (
    a.identity !== undefined &&
    b.identity !== undefined &&
    a.identity === b.identity
  );
}

/**
 * Slices a baseline into engine calls with the candidate pinned in each.
 *
 * `cap` is the engine's URLs-per-job limit, so each call carries the
 * candidate and `cap - 1` baseline videos. Pinning the candidate in every
 * call is what makes a slice of size N cover exactly N useful pairs — unlike
 * all-against-all, which needs overlapping batches to cover every pair.
 */
export function planPinnedCalls(
  candidate: Candidate,
  baseline: readonly Candidate[],
  cap: number,
): PinnedPlan {
  const twins = baseline.filter((video) => isTwin(candidate, video));
  const others = baseline.filter((video) => !isTwin(candidate, video));

  const perCall = Math.max(1, cap - 1);
  const calls: Candidate[][] = [];
  for (let start = 0; start < others.length; start += perCall) {
    calls.push([candidate, ...others.slice(start, start + perCall)]);
  }
  return { calls, twins };
}

/** One decimal, matching how the engine reports scores. */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
