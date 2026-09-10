/**
 * Shapes returned by the API. These mirror the Prisma models in
 * packages/database; `DateTime` columns arrive over JSON as ISO strings.
 */

export type Role = "ADMIN" | "EDITOR"

export type CampaignStatus = "ACTIVE" | "INACTIVE"

/** Selectable values, for <Select> options and the like. */
export const ROLES = ["ADMIN", "EDITOR"] as const satisfies readonly Role[]

export const CAMPAIGN_STATUSES = [
  "ACTIVE",
  "INACTIVE",
] as const satisfies readonly CampaignStatus[]

export interface User {
  id: string
  mobile: string
  name: string
  role: Role
  /**
   * What this editor charges per video, in rupees. Always null for an ADMIN
   * — the server clears it on promotion — and null on an editor means the
   * rate has not been agreed yet.
   */
  rateCard: number | null
  /** Soft-delete flag: false means the account was deleted. */
  active: boolean
  createdAt: string
  updatedAt: string
}

export interface Campaign {
  id: string
  title: string
  briefText: string | null
  guidanceNote: string | null
  /** Business state of the campaign — unrelated to `active`. */
  status: CampaignStatus
  trackerCampaignId: string | null
  /**
   * Display name for `trackerCampaignId`, denormalised at write time. The
   * tracker feed only lists *active* campaigns, so a linked campaign can drop
   * out of it — this keeps the label readable when that happens.
   */
  trackerCampaignName: string | null
  /** Soft-delete flag: false means the campaign was deleted. */
  active: boolean
  createdAt: string
  updatedAt: string
}

/**
 * A video an editor has handed in against a campaign brief. Mirrors
 * apps/api/src/submissions/submissions.types.ts.
 */
export interface VideoSubmission {
  id: string
  campaignId: string
  /** The uploader's own file name, for display. */
  fileName: string
  contentType: string
  sizeBytes: number
  createdAt: string
  editorId: string
  /** Who submitted it. An editor only ever sees their own rows. */
  editorName: string
  /**
   * Time-limited URL for a <video> element. Signed per response — it is not a
   * stable address, and it stops working at `playbackExpiresAt`.
   */
  playbackUrl: string
  playbackExpiresAt: string
}

/* Duplicate detection — mirrors apps/api/src/comparisons/comparisons.types.ts. */

/**
 * Outcome band for one compared pair. The engine's own bands: MATCH ≥ 90,
 * LIKELY_MATCH 60–89.9, UNCERTAIN 25–59.9, NO_MATCH < 25. This is the field
 * to branch on — `score` is the number behind it.
 */
export type ComparisonVerdict =
  | "MATCH"
  | "LIKELY_MATCH"
  | "UNCERTAIN"
  | "NO_MATCH"

export type ComparisonStatus =
  | "QUEUED"
  | "RUNNING"
  | "SUCCEEDED"
  /** Some videos failed to prepare; the rest were still compared. */
  | "PARTIAL"
  | "FAILED"
  | "TIMEOUT"
  /** A newer run replaced this one mid-flight. */
  | "SUPERSEDED"

/** Statuses that are still moving, and so worth polling for. */
export const LIVE_COMPARISON_STATUSES = [
  "QUEUED",
  "RUNNING",
] as const satisfies readonly ComparisonStatus[]

export function isComparisonLive(status: ComparisonStatus): boolean {
  return (LIVE_COMPARISON_STATUSES as readonly string[]).includes(status)
}

/** One video that went into a run. */
export interface ComparisonVideo {
  submissionId: string
  fileName: string
  editorId: string
  editorName: string
  /**
   * When it was handed in. File names are not unique — the same cut
   * re-uploaded keeps its name — so this is what tells two otherwise
   * identical match rows apart.
   */
  submittedAt: string
  /**
   * Whether the engine got far enough to fingerprint it. False means this
   * video is in no pair at all — which is not "matched nothing", and must not
   * be shown as such.
   */
  ready: boolean
  durationSeconds: number | null
}

/**
 * The engine's `evidence` block. Every field is optional because it is
 * diagnostic detail the engine is free to reshape between versions — it is
 * read to explain a score, never to decide anything.
 */
export interface ComparisonEvidence {
  tiers?: {
    /** "pdq_sw" (hashes) or "sscd" (neural). */
    winning_tier?: string
    pdq_sw?: number | null
    sscd?: number | null
    audio_boost?: number | null
  }
  visual?: {
    /** Where the match is, in seconds. Empty means nothing aligned at all. */
    matched_spans?: { a_start: number; a_end: number; b_start: number; b_end: number }[]
    coverage?: { a?: number; b?: number }
    /** Mean per-frame similarity along the path. */
    quality?: number
    offset_s?: number
    speed_ratio?: number
    /** Matched under horizontal mirroring — a common re-upload evasion. */
    flipped?: boolean
    /** Matched spans are out of order: a re-cut. */
    reordered?: boolean
  }
  audio?: {
    verdict?: string
    conf?: number
    boost_applied?: boolean
    reason?: string
  }
  mpeg7?: { status?: string; reason?: string }
  composite?: { winning_combo?: string[] }
}

/** The comparison of two videos from one run. */
export interface ComparisonPair {
  id: string
  aSubmissionId: string
  bSubmissionId: string
  /** 0–100, floored at 1 by the engine. 1 means "no signal", not "1%". */
  score: number
  verdict: ComparisonVerdict
  /** 0–100. High with a modest score means one video is cut from the other. */
  containment: number
  evidence: ComparisonEvidence | null
}

/**
 * A cluster of related videos. Transitive: A–B and B–C put all three together
 * even if A–C was never strong, because that is usually one cut circulating
 * in three edits. `minScore` is the weakest edge holding it together.
 */
export interface ComparisonGroup {
  submissionIds: string[]
  minScore: number
  maxScore: number
}

/** A run without its pairs — enough for a history row. */
export interface ComparisonSummary {
  id: string
  campaignId: string
  status: ComparisonStatus
  stage: string | null
  pairsDone: number
  pairsTotal: number
  videoCount: number
  /** Pairs that came back as anything other than NO_MATCH. */
  flaggedPairCount: number
  engineVersion: string | null
  errorMessage: string | null
  triggerSubmissionId: string | null
  createdAt: string
  completedAt: string | null
}

/** A run with everything it produced. */
export interface Comparison extends ComparisonSummary {
  videos: ComparisonVideo[]
  /** Every pair, NO_MATCH included, strongest first. */
  pairs: ComparisonPair[]
  groups: ComparisonGroup[]
}

/**
 * One entry from the external tracker's active-campaign feed, flattened by the
 * API into our own casing. Names are *not* unique — two live campaigns are
 * both called "Airbnb" — so `id` is the only safe key.
 */
export interface TrackerCampaign {
  id: string
  name: string
}

/**
 * A vendor in the directory: the video editors and other suppliers the team
 * works with. A contact record, NOT a login account — accounts are `User`
 * rows, and `Role.EDITOR` there is unrelated to this.
 */
export interface Vendor {
  id: string
  name: string
  email: string | null
  phoneNumber: string
  instagram: string | null
  twitter: string | null
  linkedin: string | null
  /**
   * Visible status toggle, *not* a soft-delete flag: inactive vendors stay in
   * the list and are re-activated from there. There is no delete endpoint.
   */
  active: boolean
  createdAt: string
  updatedAt: string
}

/* Bulk import — mirrors apps/api/src/vendors/import/vendor-import.types.ts. */

export type VendorImportRowStatus = "created" | "duplicate" | "error"

export interface VendorImportRowResult {
  /** 1-based Excel row number: the header is row 1, the first data row is 2. */
  row: number
  status: VendorImportRowStatus
  name: string | null
  phoneNumber: string | null
  message: string | null
}

export interface VendorImportResult {
  fileName: string
  /** Non-blank data rows. created + duplicates + errors === totalRows. */
  totalRows: number
  created: number
  duplicates: number
  errors: number
  /** Every non-blank row, in sheet order. */
  rows: VendorImportRowResult[]
}
