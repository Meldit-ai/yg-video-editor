import { handleFrom, type TrackerReel } from "../tracker/tracker.service.js";

/**
 * Turning rows read straight from the tracker's `VendorMessages` table into
 * the same `TrackerReel` shape the HTTP import produces — so a reel arrives
 * in our table identically whichever way it came in, and a later re-import
 * through the API updates it in place.
 */

/** The columns `import-tracker-reels` selects, as `pg` hands them back. */
export interface VendorMessageRow {
  id: string;
  /** The post's permalink. */
  message: string | null;
  /** `media_urls[1]` — a reel carries exactly one. */
  media_url: string | null;
  social_username: string | null;
  postDate: Date | null;
  post_counts: unknown;
  caption: string | null;
  invoice_approved: boolean | null;
}

export type SkipReason = "no-media" | "not-hetzner" | "no-handle";

/**
 * Only media the tracker has mirrored into Hetzner object storage is taken.
 * An Instagram CDN link expires within hours, so the engine would fetch a
 * 403 — and its cache identity is the URL string, which would never match
 * again anyway.
 */
const HETZNER_PREFIX = "https://fsn1.your-objectstorage.com/";

export function toTrackerReels(rows: readonly VendorMessageRow[]): {
  reels: TrackerReel[];
  skipped: { id: string; reason: SkipReason }[];
} {
  const reels: TrackerReel[] = [];
  const skipped: { id: string; reason: SkipReason }[] = [];

  for (const row of rows) {
    if (row.media_url === null || row.media_url.length === 0) {
      skipped.push({ id: row.id, reason: "no-media" });
      continue;
    }
    if (!row.media_url.startsWith(HETZNER_PREFIX)) {
      skipped.push({ id: row.id, reason: "not-hetzner" });
      continue;
    }
    const socialUsername = (row.social_username ?? "").trim();
    const username = handleFrom(socialUsername);
    if (username === null) {
      skipped.push({ id: row.id, reason: "no-handle" });
      continue;
    }

    reels.push({
      trackerPostId: row.id,
      socialUsername,
      username,
      permalink: row.message,
      mediaUrl: row.media_url,
      postedAt: row.postDate,
      postCounts: row.post_counts ?? null,
      caption: row.caption,
      invoiceApproved: row.invoice_approved === true,
    });
  }

  return { reels, skipped };
}
