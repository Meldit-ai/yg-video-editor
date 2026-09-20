import { MatchOrigin } from "@repo/database";
import { describe, expect, it } from "vitest";
import { groupOrigin, originOf } from "./matches.service.js";

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

describe("groupOrigin", () => {
  it("calls it the reel's when any one of them predates the edit", () => {
    // One earlier reel settles it: the footage was already public, and what
    // the later accounts did changes nothing about that.
    expect(
      groupOrigin([MatchOrigin.EDITOR, MatchOrigin.REEL, MatchOrigin.EDITOR]),
    ).toBe(MatchOrigin.REEL);
  });

  it("calls it the editor's when the edit came before every reel", () => {
    expect(groupOrigin([MatchOrigin.EDITOR, MatchOrigin.EDITOR])).toBe(
      MatchOrigin.EDITOR,
    );
  });

  it("stays undecided only when no reel carries a date", () => {
    expect(groupOrigin([MatchOrigin.UNKNOWN, MatchOrigin.UNKNOWN])).toBe(
      MatchOrigin.UNKNOWN,
    );
  });

  it("prefers a dated reel over an undated one", () => {
    // An unknown date is absence of evidence, so it must not outvote a reel
    // whose date is known.
    expect(groupOrigin([MatchOrigin.UNKNOWN, MatchOrigin.EDITOR])).toBe(
      MatchOrigin.EDITOR,
    );
  });
});
