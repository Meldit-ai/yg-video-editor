import { randomUUID } from "node:crypto";

/**
 * Upload limits and naming rules for video submissions. The size cap and the
 * accepted extensions are mirrored in the browser (campaign-submissions.tsx)
 * so an obviously wrong file is rejected before it costs an upload — the
 * checks here are the ones that count.
 */

/**
 * Hard cap per upload: 2^31 - 1 bytes, one byte under 2 GiB.
 *
 * The number is the largest value a Postgres `int` holds, which is exactly why
 * VideoSubmission.sizeBytes can be an Int rather than a BigInt (a BigInt would
 * not survive JSON serialisation without extra handling). It is also a round
 * 2 GB in the binary units `fileSize` prints in, so the limit the UI states
 * and the sizes it shows are measured the same way.
 */
export const MAX_VIDEO_BYTES = 2_147_483_647;

/** How that cap is written for people. Mirrored in the browser. */
export const MAX_VIDEO_SIZE_LABEL = "2 GB";

/** Multipart field name the browser must use. */
export const VIDEO_FIELD_NAME = "file";

/**
 * Containers we accept, and the MIME type each one really is.
 *
 * This is the fallback path: the primary signal is what the browser reports,
 * and these catch the files (.mkv especially) that some browsers hand over
 * untyped. The MIME is not just for the check — an object stored as
 * application/octet-stream is served back that way too, and a browser will
 * offer to download it instead of playing it.
 */
export const VIDEO_MIME_BY_EXTENSION: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  mpg: "video/mpeg",
  mpeg: "video/mpeg",
  m2ts: "video/mp2t",
  mts: "video/mp2t",
  wmv: "video/x-ms-wmv",
};

export const ACCEPTED_VIDEO_EXTENSIONS = Object.keys(VIDEO_MIME_BY_EXTENSION);

/** What a browser sends when it does not recognise the container. */
const UNTYPED_MIME = new Set([
  "",
  "application/octet-stream",
  "binary/octet-stream",
]);

/** Lower-case extension without the dot, or "" when the name carries none. */
export function extensionOf(fileName: string): string {
  const match = /\.([a-z0-9]{1,8})$/i.exec(fileName.trim());
  return match ? match[1]!.toLowerCase() : "";
}

/**
 * Whether this upload looks like a video.
 *
 * MIME first, extension second. Trusting the extension alone would let any
 * file through under a renamed .mp4; trusting the MIME alone would reject
 * legitimate .mkv files that arrive untyped — so an untyped upload has to earn
 * it with a known extension.
 */
export function isAcceptedVideo(mimeType: string, fileName: string): boolean {
  const mime = mimeType.trim().toLowerCase();
  if (mime.startsWith("video/")) return true;
  if (!UNTYPED_MIME.has(mime)) return false;
  return extensionOf(fileName) in VIDEO_MIME_BY_EXTENSION;
}

/**
 * The type the file is stored and served as.
 *
 * The browser's own answer wins when it gave one. When it did not — Windows
 * and Safari both hand .mkv over as application/octet-stream — the extension
 * decides, because the stored type is replayed on the playback URL: leaving it
 * as octet-stream would turn a submitted video into a download prompt.
 */
export function resolveContentType(mimeType: string, fileName: string): string {
  const mime = mimeType.trim().toLowerCase();
  if (mime.startsWith("video/")) return mime;
  return VIDEO_MIME_BY_EXTENSION[extensionOf(fileName)] ?? "video/mp4";
}

/**
 * Where the object lives in the bucket.
 *
 * The uploader's file name is never part of the key: it is client-controlled
 * text that would have to be defended against traversal, unicode and length
 * limits, and two editors uploading "final.mp4" must not collide. A random
 * uuid does all of that for free, the original name is kept in the row for
 * display, and the campaign prefix keeps the bucket browsable by hand.
 */
export function buildObjectKey(campaignId: string, fileName: string): string {
  const extension = extensionOf(fileName);
  return `campaigns/${campaignId}/${randomUUID()}${extension ? `.${extension}` : ""}`;
}

/**
 * The stored display name: the last path segment, stripped of control
 * characters and capped, so one absurd file name cannot bloat every list
 * response. Never used to build a key.
 */
export function displayFileName(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return cleaned.slice(0, 180) || "video";
}
