import type { ComparisonStatus, Prisma } from "@repo/database";
import type { ResolvedResult } from "../comparisons/engine-result.js";
import type { Candidate, Outcome } from "./uniqueness.rules.js";

/**
 * The two kinds of video the classifier labels. Same rule, different tables:
 * an editor's submission is ordered by upload time, a reel by when it went
 * live on Instagram.
 */
export type TargetKind = "submission" | "reel";

/** What a run row is opened with. */
export interface RunOpening {
  /** The one video whose arrival caused this run, when there was exactly one. */
  triggerId: string | null;
  threshold: number;
  /** Candidates waiting when the run opened — a lower bound for a rebuild. */
  candidateCount: number;
}

/** One engine call, as the audit trail records it. */
export interface CallRecord {
  candidate: Candidate;
  /** The baseline videos in the call, in the order they were sent. */
  slice: Candidate[];
  /** The engine's job id; null when the request never became a job. */
  jobId: string | null;
  status: ComparisonStatus;
  errorMessage: string | null;
  /**
   * The call's videos and its candidate-vs-baseline pairs, resolved to our
   * ids. Pairs among the baseline videos are already gone. Null when the
   * call ended without a result.
   */
  resolved: ResolvedResult | null;
}

/** Counters mirrored onto the run row as the batch progresses. */
export interface RunProgress {
  stage: string | null;
  pairsDone: number;
  pairsTotal: number;
  /** Distinct videos the run has touched: candidates and baseline alike. */
  videoCount: number;
  /** Candidates labelled DUPLICATE so far. */
  matchCount: number;
}

export interface RunClosing {
  status: ComparisonStatus;
  errorMessage: string | null;
  engineVersion: string | null;
  /** Candidate pairs at or above the partial floor — worth a human's look. */
  flaggedPairCount: number;
}

/**
 * Everything the classifier needs from a table, so the loop in
 * `UniquenessService` is written once and `SubmissionTarget` / `ReelTarget`
 * supply the rows. Every list comes back in arrival order.
 *
 * "Pending" is a row with no label and no checked-at; "unreadable" has a
 * checked-at but still no label. See `VideoSubmission.uniqueness`.
 */
export interface UniquenessTarget {
  readonly kind: TargetKind;

  /** The campaign's threshold, or null when the campaign is gone. */
  loadThreshold(campaignId: string): Promise<number | null>;
  /** Active rows still to be classified, oldest first. */
  loadPending(campaignId: string): Promise<Candidate[]>;
  /** Active UNIQUE and PARTIAL rows, oldest first. */
  loadBaseline(campaignId: string): Promise<Candidate[]>;
  /** Ids of active PARTIAL and DUPLICATE rows whose parent is `parentId`. */
  loadDependants(campaignId: string, parentId: string): Promise<string[]>;
  /** Active rows on the campaign, whatever their state. */
  countActive(campaignId: string): Promise<number>;

  writeOutcome(id: string, outcome: Outcome, checkedAt: Date): Promise<void>;
  markUnreadable(id: string, checkedAt: Date): Promise<void>;
  /** Back to pending: the given rows, or every active row on the campaign. */
  resetLabels(campaignId: string, ids?: readonly string[]): Promise<number>;
  /** Re-labels every labelled row from its stored match value. No engine. */
  relabelForThreshold(
    tx: Prisma.TransactionClient,
    campaignId: string,
    threshold: number,
  ): Promise<void>;

  /* Audit trail: one run per batch, one call record per engine request. */
  openRun(campaignId: string, opening: RunOpening): Promise<string>;
  recordCall(runId: string, call: CallRecord): Promise<void>;
  updateRun(runId: string, progress: RunProgress): Promise<void>;
  closeRun(runId: string, closing: RunClosing): Promise<void>;

  /* Boot. */
  /** Marks runs left live by a previous process as failed. Returns the count. */
  failLiveRuns(reason: string): Promise<number>;
  /** Campaigns with at least one pending row. */
  campaignsWithPending(): Promise<string[]>;
}
