/**
 * What object storage will say about a file without sending it.
 *
 * A reel's media lives on Hetzner object storage (S3-compatible, public
 * read). A HEAD costs one round trip and yields the byte count and the ETag,
 * which for a single-part object is the MD5 of the bytes — enough to tell
 * two reels are the same file without fingerprinting either.
 */

/** A reel's media is a few MB behind a CDN; this is generous. */
const HEAD_TIMEOUT_MS = 20_000;

export interface MediaHead {
  sizeBytes: number | null;
  etag: string | null;
}

const UNKNOWN: MediaHead = { sizeBytes: null, etag: null };

/** Never throws: a HEAD that fails leaves the identity unknown, not wrong. */
export async function headMedia(url: string): Promise<MediaHead> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "HEAD",
      signal: AbortSignal.timeout(HEAD_TIMEOUT_MS),
    });
  } catch {
    return UNKNOWN;
  }
  if (!response.ok) return UNKNOWN;

  const length = Number(response.headers.get("content-length"));
  return {
    sizeBytes: Number.isInteger(length) && length > 0 ? length : null,
    etag: response.headers.get("etag"),
  };
}

/** `headMedia` over many URLs, at most `concurrency` at a time, in order. */
export async function headMediaAll(
  urls: readonly string[],
  concurrency = 16,
): Promise<MediaHead[]> {
  const results: MediaHead[] = new Array<MediaHead>(urls.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= urls.length) return;
      results[index] = await headMedia(urls[index]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, urls.length)) }, worker),
  );
  return results;
}
