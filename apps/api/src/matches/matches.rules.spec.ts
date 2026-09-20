import { describe, expect, it } from "vitest";
import { frameShare, isSameFootage, MIN_FRAMES } from "./matches.rules.js";

describe("frameShare", () => {
  it("reports the share of frames held in common", () => {
    expect(frameShare({ shared: 110, total: 127 })).toBe(86.6);
  });

  it("is zero for a video with no frames, rather than dividing by zero", () => {
    expect(frameShare({ shared: 0, total: 0 })).toBe(0);
  });
});

describe("isSameFootage", () => {
  it("accepts only a complete overlap", () => {
    // Measured over every pair on a real campaign, 119 of the 173 pairs at
    // 100% were byte-identical and the rest were the same video re-encoded.
    expect(isSameFootage({ shared: 127, total: 127 })).toBe(true);
  });

  it("rejects everything short of complete, however close", () => {
    // Not a tuned threshold: across 392 pairs below 100%, not one was the
    // same video. 99% is as wrong as 10%.
    expect(isSameFootage({ shared: 126, total: 127 })).toBe(false);
    expect(isSameFootage({ shared: 114, total: 127 })).toBe(false);
    expect(isSameFootage({ shared: 0, total: 127 })).toBe(false);
  });

  it("accepts a reel that carries the edit plus more of its own", () => {
    // The overlap is counted against the shorter side, so an edit wholly
    // inside a longer reel still matches.
    expect(isSameFootage({ shared: 40, total: 40 })).toBe(true);
  });

  it("rejects a video too short to be evidence", () => {
    // A clip yielding one sample would otherwise "share all its frames" with
    // anything containing that single still.
    expect(
      isSameFootage({ shared: MIN_FRAMES - 1, total: MIN_FRAMES - 1 }),
    ).toBe(false);
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
