/**
 * Instagram post links, as a vendor actually sends them on WhatsApp.
 *
 * The identifier is the shortcode — the segment after /reel/, /p/ or /tv/ —
 * because everything around it varies: a share sheet appends ?igsh=…, the host
 * may or may not carry www., the path may say reel or reels (both appear in our
 * own tracker data), and the trailing slash comes and goes. Two links to the
 * same post rarely arrive as the same string, so comparing strings would miss
 * matches the shortcode catches.
 */

/**
 * One Instagram post found in a message.
 */
export interface PostLink {
  /** The link exactly as the vendor sent it, for the record. */
  raw: string;
  /** The stable identifier: what /reel/<this>/ names. */
  shortcode: string;
  /** Rebuilt canonically, so two spellings of one post compare equal. */
  canonical: string;
  /** Which kind of post the path said: a reel, a feed post, or IGTV. */
  kind: "reel" | "post" | "tv";
}

/**
 * Anything that looks like a URL. Deliberately broad — narrowing to Instagram
 * happens after, so a vendor sending a YouTube link is *recognised and
 * rejected* rather than silently ignored.
 */
const URL_PATTERN = /https?:\/\/[^\s<>"'\])]+/gi;

/** instagram.com, and the share-sheet shortener. */
const INSTAGRAM_HOSTS = new Set([
  "instagram.com",
  "www.instagram.com",
  "m.instagram.com",
  "instagr.am",
  "www.instagr.am",
]);

/** The path segments that introduce a post, and what each one means. */
const KINDS: Record<string, PostLink["kind"]> = {
  reel: "reel",
  // Plural appears in our own tracker rows, so it is not a typo to reject.
  reels: "reel",
  p: "post",
  tv: "tv",
};

/** Instagram shortcodes are base64url-ish and 5-30 characters in practice. */
const SHORTCODE_PATTERN = /^[A-Za-z0-9_-]{5,30}$/;

/**
 * Reads one URL into a post link, or null when it is not an Instagram post.
 *
 * A profile link (instagram.com/someone) is not a post and returns null: a
 * vendor sending their profile has not told us which video they posted.
 */
export function parsePostLink(raw: string): PostLink | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!INSTAGRAM_HOSTS.has(url.hostname.toLowerCase())) return null;

  const segments = url.pathname.split("/").filter((part) => part.length > 0);
  // Two shapes: /reel/<code> and /<username>/reel/<code>. Scan for the marker
  // rather than assuming a position, so both read the same way.
  for (let index = 0; index < segments.length - 1; index += 1) {
    const kind = KINDS[segments[index]!.toLowerCase()];
    if (kind === undefined) continue;
    const shortcode = segments[index + 1]!;
    if (!SHORTCODE_PATTERN.test(shortcode)) continue;
    return {
      raw,
      shortcode,
      // The path segment is normalised to the singular, and the query string
      // dropped: ?igsh= is a share-sheet tracking token, not part of identity.
      canonical: `https://www.instagram.com/${kind === "post" ? "p" : kind}/${shortcode}/`,
      kind,
    };
  }
  return null;
}

/**
 * Every Instagram post link in a message, deduplicated by shortcode.
 *
 * A vendor pasting the same post twice, or sending both the share-sheet link
 * and a cleaned one, is reporting one post — not two.
 */
export function findPostLinks(text: string): PostLink[] {
  const found = new Map<string, PostLink>();
  for (const match of text.matchAll(URL_PATTERN)) {
    // Trailing punctuation is part of the sentence, not the URL: "posted!
    // https://…/abc/." would otherwise carry the full stop into the shortcode.
    const cleaned = match[0].replace(/[.,;:!?]+$/, "");
    const link = parsePostLink(cleaned);
    if (link !== null && !found.has(link.shortcode)) {
      found.set(link.shortcode, link);
    }
  }
  return [...found.values()];
}

/**
 * URLs in a message that are not Instagram posts.
 *
 * Kept apart from the posts so a reply carrying only a YouTube link reads as
 * "they sent something, but not a post" rather than as an empty message. That
 * is a different conversation with the vendor.
 */
export function findOtherLinks(text: string): string[] {
  const other: string[] = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    const cleaned = match[0].replace(/[.,;:!?]+$/, "");
    if (parsePostLink(cleaned) === null) other.push(cleaned);
  }
  return other;
}

/**
 * The shortcode inside a stored permalink, for matching against the tracker.
 *
 * Our own reel rows hold permalinks in several spellings, so they are read
 * through the same parser rather than compared as strings.
 */
export function shortcodeOf(permalink: string | null): string | null {
  if (permalink === null) return null;
  return parsePostLink(permalink)?.shortcode ?? null;
}

/**
 * The storage object key inside a media URL.
 *
 * A playback link is presigned: the signature and expiry are regenerated every
 * time one is handed out, so the same video yields a different URL on every
 * send and comparing whole URLs would never match. The path is the stable part.
 *
 * Our storage produces both addressing styles — the bucket as a host label
 * (`meldit.fsn1.…/instagram/x.mp4`) and as a first path segment
 * (`fsn1.…/meldit/instagram/x.mp4`) — and both appear in stored rows. The
 * bucket name is read from the environment so the two give one key; without
 * it, only the host style can be recognised.
 *
 * Returns null for anything that is not a URL.
 */
export function objectKeyOf(mediaUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(mediaUrl);
  } catch {
    return null;
  }
  const path = url.pathname.replace(/^\/+/, "");
  if (path.length === 0) return null;

  const segments = path.split("/");
  if (segments.length < 2) return path;

  // Either spelling of the bucket, stripped so both yield the same key.
  const bucket = process.env.HETZNER_BUCKET_NAME;
  const hostLabel = url.hostname.split(".")[0];
  if (segments[0] === hostLabel || (bucket !== undefined && segments[0] === bucket)) {
    return segments.slice(1).join("/");
  }
  return path;
}
