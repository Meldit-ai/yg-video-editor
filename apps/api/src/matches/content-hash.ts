import { createHash } from "node:crypto";
import { Readable } from "node:stream";

/** Long enough for a large video on a slow link, short enough to fail a stall. */
const FETCH_TIMEOUT_MS = 180_000;

/**
 * SHA-256 of whatever is at a URL, lowercase hex — or null if it cannot be read.
 *
 * Streamed rather than buffered. A campaign's videos run to tens of megabytes
 * each and thousands of rows, and holding one in memory per hash is the
 * difference between this running on a small box and not.
 *
 * Null rather than throwing: a single unreachable object should cost its own
 * row a hash, not abandon the run that was hashing a thousand of them.
 */
export async function hashUrl(url: string): Promise<string | null> {
  let response: Response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (!response.ok || response.body === null) return null;

  const digest = createHash("sha256");
  try {
    for await (const chunk of Readable.fromWeb(
      response.body as Parameters<typeof Readable.fromWeb>[0],
    )) {
      digest.update(chunk as Buffer);
    }
  } catch {
    // A connection dropped mid-body would otherwise hash a truncated file and
    // record it as that video's identity, which is worse than no hash at all.
    return null;
  }
  return digest.digest("hex");
}
