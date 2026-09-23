/**
 * Shapes returned by the API. These mirror the Prisma models in
 * packages/database; `DateTime` columns arrive over JSON as ISO strings.
 */

/**
 * A page of a list route. Mirrors apps/api/src/common/pagination.ts.
 *
 * `total` is the whole filtered list, so a screen can say "24 of 97" and
 * decide whether an action applies to the campaign rather than to what has
 * been scrolled to. `nextSkip` is null on the last page — and on a response
 * to a request that asked for no page at all, which is how a caller that
 * wants everything gets it.
 */
export interface Page<T> {
  items: T[]
  total: number
  nextSkip: number | null
}

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
  /** Accepted duplication %. A submission at or above it is flagged, not blocked. */
  duplicationThreshold: number
  /** Soft-delete flag: false means the campaign was deleted. */
  active: boolean
  createdAt: string
  updatedAt: string
}

/**
 * A video an editor has handed in against a campaign brief. Mirrors
 * apps/api/src/submissions/submissions.types.ts.
 */
/**
 * A video's label against everything that arrived on its campaign before it.
 * UNIQUE: nothing resembled it. PARTIAL: resembles a baseline video, below the
 * campaign threshold. DUPLICATE: at or above it. Mirrors the Prisma enum.
 */
export type Uniqueness = "UNIQUE" | "PARTIAL" | "DUPLICATE"

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
   * Where this video stands against the campaign's baseline. Read with
   * `duplicationCheckedAt`: null + null is "still to be checked", null with a
   * checked-at is "the engine could not read it", and a label is a label.
   */
  uniqueness: Uniqueness | null
  /**
   * Match value: the highest max(score, containment) against any baseline
   * video. Null means not checked yet; 0 means there was nothing to compare
   * against — the two are different states, so do not coalesce them.
   */
  duplicationScore: number | null
  averageDuplicationScore: number | null
  /** The baseline video it scored highest against — the parent when not UNIQUE. */
  topMatchSubmissionId: string | null
  /** Derived: `uniqueness === "DUPLICATE"`. Prefer `uniqueness`. */
  overThreshold: boolean
  duplicationCheckedAt: string | null
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

/* ---------------------------------------------------------- dashboard */

/** Mirrors apps/api/src/dashboard/dashboard.types.ts. */
export interface DashboardCampaignStat {
  campaignId: string
  campaignTitle: string
  videos: number
  duplicates: number
  unique: number
  unchecked: number
}

export interface EditorDashboardStats {
  videosUploaded: number
  /** Labelled DUPLICATE. Read from `uniqueness`, as every other view is. */
  duplicateCount: number
  uniqueCount: number
  /**
   * Not yet reached by a run. Kept apart from the clean count on purpose:
   * "unchecked" is not "checked and original".
   */
  uncheckedCount: number
  /** Null when nothing has been compared yet — not the same as zero. */
  averageDuplicationScore: number | null
  campaignsContributed: number
  /**
   * Null when no rate is agreed. Render that as "Rate not set", never as 0:
   * nothing models approval or payment, so this is the value of work
   * submitted rather than money owed.
   */
  estimatedEarnings: number | null
  /** Videos that earn a fee: UNIQUE, or matched on the tracker. Counted once. */
  payableCount: number
  rateCard: number | null
  perCampaign: DashboardCampaignStat[]
}

/* ------------------------------------------------------ vendor shares */

/** Mirrors apps/api/src/shares/shares.types.ts. */
export type VendorShareStatus =
  | "PENDING"
  | "SENT"
  | "DELIVERED"
  | "FAILED"
  /** No usable WhatsApp number — never attempted. */
  | "UNREACHABLE"

export interface VendorShareRecipient {
  id: string
  vendorId: string
  vendorName: string
  waNumber: string | null
  status: VendorShareStatus
  /** True when the 24-hour window was shut and the template was used. */
  usedTemplate: boolean
  errorMessage: string | null
  sentAt: string | null
}

export interface VendorShare {
  id: string
  campaignId: string
  createdById: string
  createdByName: string
  messageBody: string
  submissionIds: string[]
  createdAt: string
  recipients: VendorShareRecipient[]
}

/** A vendor in the share picker, with reachability already resolved. */
export interface ShareableVendor {
  id: string
  name: string
  phoneNumber: string
  /** False when the stored number cannot be dialled — shown disabled. */
  reachable: boolean
}

/* ------------------------------------------------------ campaign reels */

/** Mirrors apps/api/src/reels/reels.types.ts. */
export interface CampaignReel {
  id: string
  username: string
  socialUsername: string
  permalink: string | null
  /** The reel's own .mp4 — public, so it plays without signing. */
  mediaUrl: string
  /** When it went live on Instagram — half the evidence of who posted first. */
  postedAt: string | null
  caption: string | null
  postCounts: {
    likes?: number
    views?: number
    reach?: number
    comments?: number
  } | null
  /**
   * 0-100, measured only against reels posted BEFORE it. Null means it has
   * not been checked yet — which is not the same as 0.
   */
  duplicationScore: number | null
  originalReelId: string | null
  /** The profile it was copied from, when it was. */
  originalUsername: string | null
  isOriginal: boolean
  checkedAt: string | null
}

export interface ReelImportResult {
  campaignId: string
  totalReels: number
  imported: number
  updated: number
  /** Reels the tracker offered beyond the window that was asked for. */
  skipped: number
}

export interface ReelCheckRun {
  id: string
  campaignId: string
  status: ComparisonStatus
  threshold: number
  reelCount: number
  pairsDone: number
  pairsTotal: number
  /** Reels found to be a copy of something earlier. */
  matchCount: number
  errorMessage: string | null
  createdAt: string
  completedAt: string | null
}

/**
 * Share limits. Mirrors create-share.dto.ts — keep the two in step.
 *
 * Both come from WhatsApp's own ceilings rather than taste: the body it will
 * accept is 4096 characters, which is about 24 links once the note has had its
 * room, and the recipient cap is Meta's messaging tier for an unverified
 * business. The server checks the tier against what has actually been sent in
 * the last 24 hours, which the browser cannot know — so a share inside these
 * numbers can still be refused, and the dialog reports that when it happens.
 */
export const MAX_SHARE_MEDIA = 24
export const MAX_SHARE_VENDORS = 250

/* ------------------------------------------------------ campaign reels */

/** Mirrors apps/api/src/reels/reels.types.ts. */
export interface CampaignReel {
  id: string
  username: string
  socialUsername: string
  permalink: string | null
  /** The reel's own .mp4 — public, so it plays without signing. */
  mediaUrl: string
  /** When it went live on Instagram — half the evidence of who posted first. */
  postedAt: string | null
  caption: string | null
  postCounts: {
    likes?: number
    views?: number
    reach?: number
    comments?: number
  } | null
  /** Where this reel stands against the reels posted before it. See VideoSubmission. */
  uniqueness: Uniqueness | null
  /**
   * Match value, 0-100, against the baseline of reels posted BEFORE it. Null
   * means it has not been checked yet — which is not the same as 0.
   */
  duplicationScore: number | null
  originalReelId: string | null
  /** The profile it was copied from — set for PARTIAL and DUPLICATE only. */
  originalUsername: string | null
  /** Derived: `uniqueness === "UNIQUE"`. Prefer `uniqueness`. */
  isOriginal: boolean
  checkedAt: string | null
}

export interface ReelImportResult {
  campaignId: string
  totalReels: number
  imported: number
  updated: number
  /** Reels the tracker offered beyond the window that was asked for. */
  skipped: number
}

export interface ReelCheckRun {
  id: string
  campaignId: string
  status: ComparisonStatus
  threshold: number
  reelCount: number
  pairsDone: number
  pairsTotal: number
  /** Reels found to be a copy of something earlier. */
  matchCount: number
  errorMessage: string | null
  createdAt: string
  completedAt: string | null
}

/** Mirrors apps/api/src/matches/matches.types.ts. */
export type MatchOrigin = "EDITOR" | "REEL" | "UNKNOWN"

/** One editor upload and one Instagram reel carrying identical bytes. */
export interface CrossPlatformMatch {
  id: string
  submissionId: string
  fileName: string
  editorName: string
  uploadedAt: string
  /** Signed URL for the edit; expires, so it is not cached client-side. */
  playbackUrl: string
  reelId: string
  username: string
  permalink: string | null
  postedAt: string | null
  /** The reel's own file, public on the tracker's storage. */
  reelUrl: string
  /** Which side was published first. UNKNOWN when the reel has no date. */
  origin: MatchOrigin
  /** Null when the match came from frame signatures rather than the bytes. */
  contentHash: string | null
  /** How much of the upload's footage the reel carries, 0-100. */
  frameShare: number
  checkedAt: string
}

export interface MatchRunResult {
  campaignId: string
  hashedSubmissions: number
  hashedReels: number
  /** Reels still without a hash, so the caller knows to run again. */
  unhashedReels: number
  /** Reels on the campaign at all. Zero means there was nothing to match. */
  totalReels: number
  /** Whether a tracker campaign is linked — reels are pulled from it. */
  trackerLinked: boolean
  /** Edits that matched at least one reel. */
  matchCount: number
  matches: MatchGroup[]
}

/** One reel carrying an edit's footage, inside a match group. */
/** What one post earned. Every field is nullable: the tracker's payload varies. */
export interface ReelEngagement {
  views: number | null
  likes: number | null
  comments: number | null
  shares: number | null
  saves: number | null
  /** likes + comments + saves + shares — what people did, not who saw it. */
  engagement: number | null
  /** Engagement as a percentage of views, one decimal place. */
  engagementRate: number | null
  /** True when `views` is standing in for a missing view count. */
  viewsFromReach: boolean
}

export interface MatchedReel {
  reelId: string
  username: string
  permalink: string | null
  postedAt: string | null
  reelUrl: string
  origin: MatchOrigin
  /** Set when this reel is the very same file as the edit. */
  contentHash: string | null
  /** What this individual post earned. Null when the tracker sent nothing. */
  engagement: ReelEngagement | null
}

/**
 * One edit and every reel carrying the same video.
 *
 * Every reel in a group is an exact match; the group is not a ranking.
 */
export interface MatchGroup {
  submissionId: string
  fileName: string
  editorName: string
  uploadedAt: string
  playbackUrl: string
  /** Oldest post first. */
  reels: MatchedReel[]
  /** Everything the reels carrying this edit earned, added up. */
  totalEngagement: ReelEngagement & {
    countedReels: number
    totalReels: number
  }
  origin: MatchOrigin
  checkedAt: string
}

/** How the matched edits are ordered. */
export const MATCH_GROUP_SORTS = [
  { value: "views", label: "Most viewed", hint: "Total views across every post of this cut" },
  {
    value: "engagement",
    label: "Most engagement",
    hint: "Likes, comments, saves and shares added up",
  },
  {
    value: "rate",
    label: "Best engagement rate",
    // "Best rate" said nothing about what was being rated.
    hint: "Engagement as a share of views — how hard the cut worked for the reach it got",
  },
  { value: "reels", label: "Most posted", hint: "Posted by the most accounts" },
  { value: "recent", label: "Newest", hint: "Most recently handed in" },
] as const

export type MatchGroupSort = (typeof MATCH_GROUP_SORTS)[number]["value"]

/** Mirrors apps/api/src/dashboard/dashboard.types.ts. */
export interface AdminCampaignStat {
  campaignId: string
  campaignTitle: string
  videos: number
  duplicates: number
  unique: number
  unchecked: number
  editors: number
  /** What this campaign owes at each editor's rate. Null if unpriced. */
  spend: number | null
  /** Payable videos that carried a rate, out of `payableVideos`. */
  pricedVideos: number
  /** Videos that earn a fee: UNIQUE, or matched to a tracker reel. */
  payableVideos: number
}

export interface AdminDashboardStats {
  activeCampaigns: number
  editors: number
  videos: number
  duplicates: number
  unique: number
  unchecked: number
  /** Every campaign's spend added up. Null when nothing could be priced. */
  totalSpend: number | null
  /** What the duplicates alone are worth — the cost of repeated work. */
  duplicateSpend: number | null
  perCampaign: AdminCampaignStat[]
  perEditor: {
    editorId: string
    editorName: string
    videos: number
    unique: number
    duplicates: number
    /** Unique as a share of what was checked. Null when nothing has been. */
    originalRate: number | null
  }[]
  repetition: {
    clusters: number
    repeatedVideos: number
    worst: {
      submissionId: string
      campaignId: string
      campaignTitle: string
      fileName: string
      copies: number
    } | null
  }
  health: {
    campaignId: string
    campaignTitle: string
    /** Null when no run has ever happened — not the same as a failure. */
    lastRunStatus: string | null
    lastRunAt: string | null
    unchecked: number
  }[]
}

/**
 * One of the editor's own videos that reached Instagram.
 *
 * Mirrors apps/api/src/matches/matches.types.ts. Deliberately carries nothing
 * about how the match was made — no tracker ids, no hashes, no duplication
 * verdicts. An editor is shown that their work was posted and what it earned.
 */
export interface EditorPostedVideo {
  submissionId: string
  fileName: string
  uploadedAt: string
  playbackUrl: string
  posts: {
    username: string
    permalink: string | null
    postedAt: string | null
    engagement: ReelEngagement | null
  }[]
  totalEngagement: ReelEngagement & {
    countedPosts: number
    totalPosts: number
  }
}

/** Mirrors apps/api/src/shares/shares.types.ts. */
export type ReplyMatchedBy =
  | "REPLIED_TO_MESSAGE"
  | "SENDER_NUMBER"
  | "AMBIGUOUS_SENDER"
  | "UNMATCHED"

export type TrackerPresence = "PENDING" | "FOUND" | "NOT_FOUND"

export type DeliveryCheck =
  | "PENDING"
  | "SAME_FILE"
  | "SAME_FOOTAGE"
  | "DIFFERENT"
  | "NOT_FINGERPRINTED"

export interface VendorReplyPost {
  id: string
  vendorId: string | null
  vendorName: string | null
  fromNumber: string
  messageBody: string
  shortcode: string
  canonicalLink: string
  matchedBy: ReplyMatchedBy
  onTracker: TrackerPresence
  delivery: DeliveryCheck
  deliveredSubmissionId: string | null
  deliveredFileName: string | null
  deliveredFrameShare: number | null
  sentAt: string | null
  createdAt: string
}

export interface VendorShareRecipientRow {
  id: string
  vendorId: string
  vendorName: string
  waNumber: string | null
  status: "PENDING" | "SENT" | "FAILED" | "UNREACHABLE"
  usedTemplate: boolean
  errorMessage: string | null
  sentAt: string | null
}

export interface VendorShareRow {
  id: string
  campaignId: string
  createdById: string
  createdByName: string
  messageBody: string
  submissionIds: string[]
  /** The videos that went out, named. Null name means since withdrawn. */
  videos: { submissionId: string; fileName: string | null }[]
  createdAt: string
  recipients: VendorShareRecipientRow[]
  replies: VendorReplyPost[]
}
