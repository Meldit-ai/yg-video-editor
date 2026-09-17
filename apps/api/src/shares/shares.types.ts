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
  createdAt: Date;
  recipients: VendorShareRecipientDto[];
}

/** A vendor as the share dialog sees them, with reachability resolved. */
export interface ShareableVendorDto {
  id: string;
  name: string;
  phoneNumber: string;
  /** False when the number cannot be resolved — the row is shown disabled. */
  reachable: boolean;
}
