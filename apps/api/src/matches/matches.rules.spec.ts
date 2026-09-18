import { describe, expect, it } from "vitest";
import {
  frameShare,
  isSameFootage,
  MATCH_FRAME_SHARE,
  MIN_FRAMES,
} from "./matches.rules.js";

describe("frameShare", () => {
  it("reports the share of frames held in common", () => {
    expect(frameShare({ shared: 110, total: 127 })).toBe(86.6);
  });

  it("is zero for a video with no frames, rather than dividing by zero", () => {
    expect(frameShare({ shared: 0, total: 0 })).toBe(0);
  });
});

describe("isSameFootage", () => {
  it("accepts the re-encodes this exists to catch", () => {
    // Both measured on a real reel from this campaign: a CRF 28 re-encode and
    // the same video at CRF 34 resized to 480p.
    expect(isSameFootage({ shared: 117, total: 127 })).toBe(true);
    expect(isSameFootage({ shared: 93, total: 127 })).toBe(true);
  });

  it("rejects an unrelated video", () => {
    // Measured: a different reel shared none of the 127 frames.
    expect(isSameFootage({ shared: 0, total: 127 })).toBe(false);
  });

  it("rejects a video too short to be evidence", () => {
    // A clip yielding one sample would otherwise "share all its frames" with
    // anything containing that single still.
    expect(
      isSameFootage({ shared: MIN_FRAMES - 1, total: MIN_FRAMES - 1 }),
    ).toBe(false);
  });

  it("draws the line at the threshold itself", () => {
    const total = 100;
    expect(isSameFootage({ shared: MATCH_FRAME_SHARE, total })).toBe(true);
    expect(isSameFootage({ shared: MATCH_FRAME_SHARE - 1, total })).toBe(false);
  });

  it("keeps the threshold inside the gap the measurements left", () => {
    // Nothing was observed between 0% and 73.4%, so the bar has to sit in that
    // gap: high enough to exclude coincidence, low enough to keep a harsh
    // re-encode.
    expect(MATCH_FRAME_SHARE).toBeGreaterThan(0);
    expect(MATCH_FRAME_SHARE).toBeLessThan(73);
  });
});

describe("what a recorded match claims", () => {
  /**
   * A pair found by frame signatures is the same footage re-encoded, so the
   * two files differ by definition. Storing the upload's own hash on such a
   * pair made it read as byte-identical — 113 of 199 stored matches claimed
   * "identical file" while the two hashes were different.
   *
   * The hash belongs on the row only when both sides carry the same one.
   */
  function sharedHash(
    uploadHash: string | null,
    reelHash: string | null,
  ): string | null {
    return uploadHash !== null && uploadHash === reelHash ? uploadHash : null;
  }

  it("keeps the hash when both sides are the same file", () => {
    expect(sharedHash("abc123", "abc123")).toBe("abc123");
  });

  it("drops it when the files differ, however they matched", () => {
    expect(sharedHash("abc123", "def456")).toBeNull();
  });

  it("drops it when either side was never hashed", () => {
    expect(sharedHash("abc123", null)).toBeNull();
    expect(sharedHash(null, "abc123")).toBeNull();
  });
});
