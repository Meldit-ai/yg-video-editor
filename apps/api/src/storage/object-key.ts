/**
 * The object key inside our own bucket that a URL points at, or null when the
 * URL belongs to somebody else.
 *
 * The tracker stores a campaign's reels in the same bucket this app uploads
 * to, so a reel already *is* one of our objects. Recognising that is what lets
 * adoption reference the existing bytes instead of downloading and re-uploading
 * them under a second key — measured on one campaign, copying turned 82
 * distinct files into 195 objects and 402MB of duplicate storage.
 */
export function ownObjectKey(
  url: string,
  endpoint: string,
  bucket: string,
): string | null {
  const host = hostOf(endpoint);
  if (host === null) return null;

  // Both addressing styles reach the same object. The tracker writes path
  // style (`host/bucket/key`) while this app mints virtual-hosted style
  // (`bucket.host/key`), and a reel has to be recognised either way.
  const bases = [
    `https://${host}/${bucket}/`,
    `https://${bucket}.${host}/`,
  ];
  const base = bases.find((candidate) => url.startsWith(candidate));
  if (base === undefined) return null;

  const key = url.slice(base.length);
  // A key is required, and a query string means the URL is doing something
  // more than naming an object — a presigned read, say, which expires.
  if (key.length === 0 || key.includes("?")) return null;
  return key;
}

/** The host of a configured endpoint, or null when it is not a usable URL. */
function hostOf(endpoint: string): string | null {
  try {
    return new URL(endpoint).host;
  } catch {
    return null;
  }
}
