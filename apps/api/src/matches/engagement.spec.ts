import { describe, expect, it } from "vitest";
import { readEngagement, sumEngagement } from "./matches.service.js";

/** A real payload, copied from the tracker. */
const REAL = {
  likes: 499,
  reach: 20097,
  saves: 9,
  views: 26795,
  comments: 24,
  impressions: 26127,
  repost_count: 2,
  reshare_count: 36,
};

describe("readEngagement", () => {
  it("reads the tracker's own field names", () => {
    expect(readEngagement(REAL)).toEqual({
      views: 26795,
      likes: 499,
      comments: 24,
      shares: 36,
      viewsFromReach: false,
    });
  });

  it("falls back to reach when a post reports no views", () => {
    // Not the same measure, but for "how far did this travel" a stand-in
    // beats a blank — and the flag lets the UI say which it is showing.
    const result = readEngagement({ reach: 1000, likes: 5 });
    expect(result?.views).toBe(1000);
    expect(result?.viewsFromReach).toBe(true);
  });

  it("prefers views over reach when both are present", () => {
    expect(readEngagement(REAL)?.views).toBe(26795);
  });

  it("keeps a missing field null rather than zero", () => {
    // A zero would be added up later as though the post genuinely earned
    // nothing, which is a different claim from "the tracker did not say".
    const result = readEngagement({ views: 10 });
    expect(result?.likes).toBeNull();
    expect(result?.comments).toBeNull();
  });

  it("returns null when the blob carries nothing usable", () => {
    expect(readEngagement({ saves: 3, impressions: 9 })).toBeNull();
    expect(readEngagement(null)).toBeNull();
    expect(readEngagement("not an object")).toBeNull();
  });

  it("ignores non-numeric values", () => {
    expect(readEngagement({ views: "12000" })).toBeNull();
  });
});

describe("sumEngagement", () => {
  const a = readEngagement({ views: 100, likes: 10, comments: 1 })!;
  const b = readEngagement({ views: 200, likes: 20 })!;

  it("adds the reels that reported counts", () => {
    const total = sumEngagement([a, b]);
    expect(total.views).toBe(300);
    expect(total.likes).toBe(30);
  });

  it("sums the reels that have a field, not only those that have all", () => {
    // b reported no comments; a's single comment must still show.
    expect(sumEngagement([a, b]).comments).toBe(1);
  });

  it("stays null when no reel reported that field at all", () => {
    expect(sumEngagement([b, b]).comments).toBeNull();
  });

  it("says how many of the group actually reported", () => {
    const total = sumEngagement([a, null, b]);
    expect(total.countedReels).toBe(2);
    expect(total.totalReels).toBe(3);
  });

  it("handles a group where nothing reported", () => {
    const total = sumEngagement([null, null]);
    expect(total.views).toBeNull();
    expect(total.countedReels).toBe(0);
    expect(total.viewsFromReach).toBe(false);
  });

  it("only flags reach when every counted reel used it", () => {
    // Otherwise the caveat would sit on a number that is mostly real views.
    const reachOnly = readEngagement({ reach: 50 })!;
    expect(sumEngagement([a, reachOnly]).viewsFromReach).toBe(false);
    expect(sumEngagement([reachOnly, reachOnly]).viewsFromReach).toBe(true);
  });
});
