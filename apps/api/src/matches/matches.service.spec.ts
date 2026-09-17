import { MatchOrigin } from "@repo/database";
import { describe, expect, it } from "vitest";
import { originOf } from "./matches.service.js";

const UPLOADED = new Date("2026-09-15T10:00:00Z");

describe("originOf", () => {
  it("names the reel the original when it was posted first", () => {
    // The finding the whole feature exists for: the video was on Instagram
    // before the editor handed it in.
    expect(originOf(UPLOADED, new Date("2026-06-23T13:14:07Z"))).toBe(
      MatchOrigin.REEL,
    );
  });

  it("names the editor the original when the upload came first", () => {
    expect(originOf(UPLOADED, new Date("2026-09-16T08:00:00Z"))).toBe(
      MatchOrigin.EDITOR,
    );
  });

  it("refuses to guess when the reel has no post date", () => {
    // Defaulting either way would accuse a real party of copying on no
    // evidence, so the pair is reported as undecided instead.
    expect(originOf(UPLOADED, null)).toBe(MatchOrigin.UNKNOWN);
  });

  it("treats an exact tie as the editor's, not the reel's", () => {
    // Only reachable when both timestamps are identical to the millisecond.
    // Someone has to win, and the upload is the side we actually observed.
    expect(originOf(UPLOADED, new Date(UPLOADED))).toBe(MatchOrigin.EDITOR);
  });
});
