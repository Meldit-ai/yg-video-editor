import type { ComparisonStatus, ComparisonVerdict } from "@repo/database";

/**
 * Wire types for duplicate detection. Mirrored in apps/web/src/lib/types.ts —
 * keep the two in step.
 *
 * The shape follows the engine's own: a roster of the videos that went in,
 * and a flat list of pairs that reference them by submission id. Names are
 * carried once on the roster rather than repeated on both sides of every
 * pair — N videos produce N*(N-1)/2 pairs, so the redundancy grows quadratic
 * while the roster does not.
 */

/** One video that was submitted to the engine as part of a run. */
export interface ComparisonVideoDto {
  submissionId: string;
  fileName: string;
  editorId: string;
  editorName: string;
  /**
   * When the video was handed in. Carried because file names are not unique —
   * the same cut re-uploaded keeps its name, which is exactly the case this
   * feature exists to surface, and two identically-labelled matches are
   * unreadable without it.
   */
  submittedAt: Date;
  /**
   * Whether the engine got far enough to fingerprint it. False means this
   * video contributed to no pair at all — which is not the same as "matched
   * nothing", and the UI must not present it as such.
   */
  ready: boolean;
  /** Probed from the normalised media, in seconds. */
  durationSeconds: number | null;
}

/** The comparison of two of those videos. */
export interface ComparisonPairDto {
  id: string;
  aSubmissionId: string;
  bSubmissionId: string;
  /** 0-100, floored at 1 by the engine. 1 means "no signal", not "1%". */
  score: number;
  verdict: ComparisonVerdict;
  /** 0-100. High with a modest score means one video is cut from the other. */
  containment: number;
  /** The engine's evidence block verbatim, for the detail view. */
  evidence: unknown;
}

/**
 * A cluster of related videos: connected components over the pairs that are
 * not NO_MATCH.
 *
 * Transitive, and deliberately so — the engine groups the same way. A-B and
 * B-C put all three together even if A-C was never strong, because in
 * practice that is one cut circulating in three edits.
 */
export interface ComparisonGroupDto {
  submissionIds: string[];
  /** Weakest and strongest edge inside the group, for a "how sure" readout. */
  minScore: number;
  maxScore: number;
}

/** A run without its pairs — what the history list needs. */
export interface ComparisonSummaryDto {
  id: string;
  campaignId: string;
  status: ComparisonStatus;
  /** Live progress. Frozen once the run is terminal. */
  stage: string | null;
  pairsDone: number;
  pairsTotal: number;
  videoCount: number;
  /** Pairs that came back as anything other than NO_MATCH. */
  flaggedPairCount: number;
  engineVersion: string | null;
  /** Why it failed, for FAILED and TIMEOUT. Null otherwise. */
  errorMessage: string | null;
  /** The upload that started it, or null when an admin asked by hand. */
  triggerSubmissionId: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

/** A run with everything it produced. */
export interface ComparisonDto extends ComparisonSummaryDto {
  videos: ComparisonVideoDto[];
  /** Every pair the engine returned, NO_MATCH included, strongest first. */
  pairs: ComparisonPairDto[];
  groups: ComparisonGroupDto[];
}
