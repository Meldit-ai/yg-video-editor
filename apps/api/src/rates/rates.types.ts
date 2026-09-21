import type { RateStatus } from "@repo/database";

/**
 * Wire types for per-campaign rates. Mirrored in apps/web/src/lib/types.ts —
 * keep the two in step.
 */

export interface CampaignRateDto {
  id: string;
  campaignId: string;
  campaignTitle: string;
  editorId: string;
  editorName: string;
  /** The rate being asked for, or the one agreed once APPROVED. */
  amount: number;
  status: RateStatus;
  /** What was paying when this was proposed. Null when nothing was. */
  previousAmount: number | null;
  editorNote: string | null;
  adminNote: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * What an editor earns per video on one campaign, and why.
 *
 * `effective` is the number that actually pays. It is never the pending
 * proposal: an editor asking for more does not change what is owed until an
 * admin approves, which is the whole point of the propose-approve cycle.
 */
export interface EffectiveRate {
  campaignId: string;
  campaignTitle: string;
  effective: number | null;
  /** Where `effective` came from, so the UI can say so plainly. */
  source: "APPROVED_CAMPAIGN_RATE" | "CAMPAIGN_DEFAULT" | "USER_RATE_CARD" | "NONE";
  /** The editor's own ask, when one is awaiting a decision. */
  pending: CampaignRateDto | null;
}
