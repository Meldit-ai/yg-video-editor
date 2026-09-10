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
