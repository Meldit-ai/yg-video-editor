import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * How far a callback's timestamp may drift from now, in either direction,
 * before it is refused as stale (or suspiciously future-dated).
 */
export const SIGNATURE_TOLERANCE_S = 300;

/** Splits a Stripe-style `k=v,k=v` header into its last value per key. */
function parseHeader(header: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const pair of header.split(",")) {
    const separatorIndex = pair.indexOf("=");
    if (separatorIndex === -1) continue;
    const key = pair.slice(0, separatorIndex).trim();
    const value = pair.slice(separatorIndex + 1).trim();
    if (key.length > 0) fields.set(key, value);
  }
  return fields;
}

/**
 * Verifies the engine's callback signature: `t=<unix-seconds>,v1=<hex hmac>`,
 * where the hmac covers `"<t>." + rawBody` under the shared secret.
 *
 * Never throws — a malformed header, a bad timestamp, or a wrong-length
 * digest all fall through to `false` rather than raising, since this runs on
 * an unauthenticated, internet-facing route.
 */
export function verifyEngineSignature(
  rawBody: Buffer,
  header: string | undefined,
  secret: string,
  nowMs: number,
): boolean {
  if (header === undefined) return false;

  const fields = parseHeader(header);
  const timestampRaw = fields.get("t");
  const signature = fields.get("v1");
  if (timestampRaw === undefined || signature === undefined) return false;
  if (!/^-?\d+$/.test(timestampRaw)) return false;

  const timestampS = Number(timestampRaw);
  if (!Number.isInteger(timestampS)) return false;
  if (Math.abs(nowMs / 1000 - timestampS) > SIGNATURE_TOLERANCE_S) {
    return false;
  }

  const expected = createHmac("sha256", secret)
    .update(`${timestampS}.`)
    .update(rawBody)
    .digest();

  let provided: Buffer;
  try {
    provided = Buffer.from(signature, "hex");
  } catch {
    return false;
  }
  // A malformed hex string (odd length, non-hex characters) yields a short
  // or empty buffer rather than throwing, so the length check below is what
  // actually screens it out.
  if (
    provided.length !== expected.length ||
    !/^[0-9a-fA-F]+$/.test(signature)
  ) {
    return false;
  }

  return timingSafeEqual(provided, expected);
}
