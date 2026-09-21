import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  SIGNATURE_TOLERANCE_S,
  verifyEngineSignature,
} from "./engine-callback.signature.js";

const SECRET = "engine-shared-secret";

function signHeader(
  rawBody: Buffer,
  secret: string,
  timestampS: number,
): string {
  const digest = createHmac("sha256", secret)
    .update(`${timestampS}.`)
    .update(rawBody)
    .digest("hex");
  return `t=${timestampS},v1=${digest}`;
}

describe("verifyEngineSignature", () => {
  const rawBody = Buffer.from(JSON.stringify({ jobId: "job-1" }));
  const nowMs = 1_700_000_000_000;

  it("accepts a valid signature", () => {
    const header = signHeader(rawBody, SECRET, Math.floor(nowMs / 1000));
    expect(verifyEngineSignature(rawBody, header, SECRET, nowMs)).toBe(true);
  });

  it("accepts a header with unknown keys interspersed, order-independent", () => {
    const t = Math.floor(nowMs / 1000);
    const digest = createHmac("sha256", SECRET)
      .update(`${t}.`)
      .update(rawBody)
      .digest("hex");
    const header = `foo=bar,v1=${digest},t=${t}`;
    expect(verifyEngineSignature(rawBody, header, SECRET, nowMs)).toBe(true);
  });

  it("rejects a wrong secret", () => {
    const header = signHeader(rawBody, SECRET, Math.floor(nowMs / 1000));
    expect(verifyEngineSignature(rawBody, header, "wrong-secret", nowMs)).toBe(
      false,
    );
  });

  it("rejects a timestamp older than the tolerance", () => {
    const t = Math.floor(nowMs / 1000) - SIGNATURE_TOLERANCE_S - 1;
    const header = signHeader(rawBody, SECRET, t);
    expect(verifyEngineSignature(rawBody, header, SECRET, nowMs)).toBe(false);
  });

  it("rejects a timestamp in the future beyond the tolerance", () => {
    const t = Math.floor(nowMs / 1000) + SIGNATURE_TOLERANCE_S + 1;
    const header = signHeader(rawBody, SECRET, t);
    expect(verifyEngineSignature(rawBody, header, SECRET, nowMs)).toBe(false);
  });

  it("accepts a timestamp exactly at the tolerance boundary", () => {
    const t = Math.floor(nowMs / 1000) - SIGNATURE_TOLERANCE_S;
    const header = signHeader(rawBody, SECRET, t);
    expect(verifyEngineSignature(rawBody, header, SECRET, nowMs)).toBe(true);
  });

  it("rejects an undefined header", () => {
    expect(verifyEngineSignature(rawBody, undefined, SECRET, nowMs)).toBe(
      false,
    );
  });

  it("rejects a header missing v1", () => {
    const header = `t=${Math.floor(nowMs / 1000)}`;
    expect(verifyEngineSignature(rawBody, header, SECRET, nowMs)).toBe(false);
  });

  it("rejects a header missing t", () => {
    const digest = createHmac("sha256", SECRET)
      .update(`.`)
      .update(rawBody)
      .digest("hex");
    const header = `v1=${digest}`;
    expect(verifyEngineSignature(rawBody, header, SECRET, nowMs)).toBe(false);
  });

  it("rejects a non-integer t", () => {
    const header = `t=not-a-number,v1=${"a".repeat(64)}`;
    expect(verifyEngineSignature(rawBody, header, SECRET, nowMs)).toBe(false);
  });

  it("rejects a non-hex v1", () => {
    const t = Math.floor(nowMs / 1000);
    const header = `t=${t},v1=${"z".repeat(64)}`;
    expect(verifyEngineSignature(rawBody, header, SECRET, nowMs)).toBe(false);
  });

  it("rejects a v1 of the wrong length, without throwing", () => {
    const t = Math.floor(nowMs / 1000);
    const header = `t=${t},v1=${"ab".repeat(10)}`;
    expect(() =>
      verifyEngineSignature(rawBody, header, SECRET, nowMs),
    ).not.toThrow();
    expect(verifyEngineSignature(rawBody, header, SECRET, nowMs)).toBe(false);
  });

  it("rejects a body that differs by one byte", () => {
    const t = Math.floor(nowMs / 1000);
    const header = signHeader(rawBody, SECRET, t);
    const tampered = Buffer.from(rawBody);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    expect(verifyEngineSignature(tampered, header, SECRET, nowMs)).toBe(
      false,
    );
  });
});
