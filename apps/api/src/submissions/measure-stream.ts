import { createHash, type Hash } from "node:crypto";
import { Transform } from "node:stream";

/**
 * A pass-through that measures the bytes crossing it: the count, and their
 * SHA-256. Used wherever a video streams into the bucket — an editor's
 * upload, an adopted reel — so the row can carry the file's identity without
 * a second read. Two videos with the same digest are the same file, and the
 * classifier labels them duplicates of each other without the engine.
 */
export function measureStream(): {
  stream: Transform;
  /** Valid once the stream has ended. */
  result: () => { sizeBytes: number; sha256: string };
} {
  let sizeBytes = 0;
  const hash: Hash = createHash("sha256");
  let digest: string | null = null;

  const stream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      sizeBytes += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    },
  });

  return {
    stream,
    result: () => {
      digest ??= hash.digest("hex");
      return { sizeBytes, sha256: digest };
    },
  };
}
