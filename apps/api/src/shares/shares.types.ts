/**
 * Wire types for vendor shares. Mirrored in apps/web/src/lib/types.ts —
 * keep the two in step.
 */

export type VendorShareStatus =
  | "PENDING"
  | "SENT"
  | "DELIVERED"
  | "FAILED"
  /** No usable WhatsApp number — never attempted. */
  | "UNREACHABLE";

export interface VendorShareRecipientDto {
  id: string;
  vendorId: string;
  vendorName: string;
  /** What was dialled, or null when the stored number could not be resolved. */
  waNumber: string | null;
  status: VendorShareStatus;
  /** True when the 24-hour window was shut and the template was used instead. */
  usedTemplate: boolean;
  errorMessage: string | null;
  sentAt: Date | null;
}

export interface VendorShareDto {
  id: string;
  campaignId: string;
  createdById: string;
  createdByName: string;
  /** What the admin typed, before the links were appended. */
  messageBody: string;
  submissionIds: string[];
  /**
   * The videos that went out, named.
   *
   * `submissionIds` alone cannot answer "which links did I send to whom" — the
   * question this view exists for — and a withdrawn video keeps its id here
   * with no row to look it up in, so the names are resolved server-side.
   */
  videos: { submissionId: string; fileName: string | null }[];
  createdAt: Date;
  recipients: VendorShareRecipientDto[];
  /** Post links vendors sent back in reply to this share. */
  replies: VendorReplyPostDto[];
}

/** One post link a vendor replied with, and what we made of it. */
export interface VendorReplyPostDto {
  id: string;
  vendorId: string | null;
  vendorName: string | null;
  /** The number it came from, when no vendor could be resolved. */
  fromNumber: string;
  /** What they actually typed, so a human can read what they meant. */
  messageBody: string;
  /** The post: canonical link, and the shortcode it is keyed by. */
  shortcode: string;
  canonicalLink: string;
  /** How confidently the reply was tied to this share. */
  matchedBy:
    | "REPLIED_TO_MESSAGE"
    | "SENDER_NUMBER"
    | "AMBIGUOUS_SENDER"
    | "UNMATCHED";
  /** Whether the tracker holds the post. */
  onTracker: "PENDING" | "FOUND" | "NOT_FOUND";
  /** Whether it carries a video this vendor was sent. */
  delivery:
    | "PENDING"
    | "SAME_FILE"
    | "SAME_FOOTAGE"
    | "DIFFERENT"
    | "NOT_FINGERPRINTED";
  /** The video it carries, named, when one was identified. */
  deliveredSubmissionId: string | null;
  deliveredFileName: string | null;
  deliveredFrameShare: number | null;
  sentAt: Date | null;
  createdAt: Date;
}

/** A vendor as the share dialog sees them, with reachability resolved. */
export interface ShareableVendorDto {
  id: string;
  name: string;
  phoneNumber: string;
  /** False when the number cannot be resolved — the row is shown disabled. */
  reachable: boolean;
}
