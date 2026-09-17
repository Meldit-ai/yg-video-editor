import { spawn } from "node:child_process";

/**
 * Frames sampled per second.
 *
 * Halved from one after measuring: a re-encode shared 92.2% of its signatures
 * at 0.5 and 91.3% at 1, so the extra frames cost decode time and bought
 * nothing. A two-minute reel still yields around sixty samples.
 */
const SAMPLE_FPS = 0.5;

/**
 * Thumbnail edge, in cells. The signature is one bit per cell, so this is
 * fixed at 8 to make 64 bits.
 *
 * Deliberately not larger. Measured on this campaign, 16x16 fell to 2.4% on a
 * harsh re-encode where 8x8 held 75.6%: finer cells resolve compression noise
 * as if it were picture, which is the opposite of what a fingerprint wants.
 */
const GRID = 8;
const CELLS = GRID * GRID;

/** Long enough to decode a long video, short enough to fail a stalled read. */
const DECODE_TIMEOUT_MS = 180_000;

/**
 * A video reduced to one 64-bit signature per sampled frame.
 *
 * Each bit says "is this cell brighter than the middle of its own frame".
 * Comparing against the frame's own median rather than a fixed level is what
 * makes it survive re-encoding: compression shifts brightness, but it does not
 * reorder which parts of a picture are lighter than the rest.
 *
 * Returns an empty array when the video cannot be read, rather than throwing —
 * one unreadable file should cost its own row a fingerprint, not abandon a run
 * fingerprinting thousands.
 */
export async function frameSignatures(url: string): Promise<bigint[]> {
  const raw = await decodeThumbnails(url);
  if (raw === null) return [];

  const signatures: bigint[] = [];
  for (let start = 0; start + CELLS <= raw.length; start += CELLS) {
    signatures.push(signatureOf(raw.subarray(start, start + CELLS)));
  }
  return signatures;
}

/**
 * One frame's 64 bits.
 *
 * The threshold is the frame's median, not its mean: a single blown-out
 * highlight drags a mean far enough to flip most cells, while the median is
 * unmoved. Measured, that was 91.3% against 86.6% on a re-encode.
 */
export function signatureOf(cells: Uint8Array): bigint {
  const sorted = [...cells].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;

  let bits = 0n;
  for (const cell of cells) {
    bits = (bits << 1n) | (cell > median ? 1n : 0n);
  }
  // Postgres has no unsigned 64-bit type and the value is only ever compared
  // for equality, so the top bit is reinterpreted as sign rather than lost.
  return BigInt.asIntN(64, bits);
}

/** Greyscale thumbnails of a video, as raw bytes, or null if it cannot be read. */
function decodeThumbnails(url: string): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    const ffmpeg = spawn(
      process.env.FFMPEG_PATH ?? "ffmpeg",
      [
        "-v", "error",
        // Let ffmpeg read the URL itself: piping the download through Node
        // would hold the whole video in memory for no gain.
        "-i", url,
        "-vf", `fps=${SAMPLE_FPS},scale=${GRID}:${GRID},format=gray`,
        "-f", "rawvideo",
        "-",
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );

    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (value: Uint8Array | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const timer = setTimeout(() => {
      ffmpeg.kill("SIGKILL");
      finish(null);
    }, DECODE_TIMEOUT_MS);

    ffmpeg.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    ffmpeg.on("error", () => finish(null));
    ffmpeg.on("close", (code) => {
      finish(code === 0 ? new Uint8Array(Buffer.concat(chunks)) : null);
    });
  });
}
