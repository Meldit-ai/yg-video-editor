import { describe, expect, it } from "vitest";
import { toTrackerReels, type VendorMessageRow } from "./tracker-rows.js";

const POSTED = new Date("2026-08-01T10:00:00Z");

function row(overrides: Partial<VendorMessageRow> = {}): VendorMessageRow {
  return {
    id: "vm_1",
    message: "https://www.instagram.com/reel/abc/",
    media_url: "https://fsn1.your-objectstorage.com/meldit/videos/abc.mp4",
    social_username: "https://instagram.com/creator_one",
    postDate: POSTED,
    post_counts: { likes: 10, views: 200 },
    caption: "hello",
    invoice_approved: false,
    ...overrides,
  };
}

describe("toTrackerReels", () => {
  it("maps a Hetzner-hosted reel onto the same shape the tracker API import uses", () => {
    const { reels, skipped } = toTrackerReels([row()]);
    expect(skipped).toEqual([]);
    expect(reels).toEqual([
      {
        trackerPostId: "vm_1",
        socialUsername: "https://instagram.com/creator_one",
        username: "creator_one",
        permalink: "https://www.instagram.com/reel/abc/",
        mediaUrl: "https://fsn1.your-objectstorage.com/meldit/videos/abc.mp4",
        postedAt: POSTED,
        postCounts: { likes: 10, views: 200 },
        caption: "hello",
        invoiceApproved: false,
      },
    ]);
  });

  it("skips a reel whose media is not on Hetzner, naming it", () => {
    const { reels, skipped } = toTrackerReels([
      row({
        id: "vm_cdn",
        media_url: "https://scontent-lga3-2.cdninstagram.com/v/t.mp4?oe=1",
      }),
    ]);
    expect(reels).toEqual([]);
    expect(skipped).toEqual([{ id: "vm_cdn", reason: "not-hetzner" }]);
  });

  it("skips a reel with no media at all", () => {
    const { reels, skipped } = toTrackerReels([row({ id: "vm_none", media_url: null })]);
    expect(reels).toEqual([]);
    expect(skipped).toEqual([{ id: "vm_none", reason: "no-media" }]);
  });

  it("skips a reel whose profile field yields no handle", () => {
    const { reels, skipped } = toTrackerReels([
      row({ id: "vm_bad", social_username: "   " }),
    ]);
    expect(reels).toEqual([]);
    expect(skipped).toEqual([{ id: "vm_bad", reason: "no-handle" }]);
  });

  it("does not invent a size or ETag — those come from a HEAD later", () => {
    const { reels } = toTrackerReels([row()]);
    expect(reels[0]).not.toHaveProperty("mediaEtag");
    expect(reels[0]).not.toHaveProperty("mediaSizeBytes");
  });

  it("keeps the input order — it is the arrival order", () => {
    const { reels } = toTrackerReels([
      row({ id: "first" }),
      row({ id: "second", postDate: new Date("2026-08-02T00:00:00Z") }),
      row({ id: "third", postDate: new Date("2026-08-03T00:00:00Z") }),
    ]);
    expect(reels.map((reel) => reel.trackerPostId)).toEqual(["first", "second", "third"]);
  });

  it("tolerates nulls in the optional columns", () => {
    const { reels } = toTrackerReels([
      row({ message: null, post_counts: null, caption: null, invoice_approved: null, postDate: null }),
    ]);
    expect(reels[0]).toMatchObject({
      permalink: null,
      postCounts: null,
      caption: null,
      invoiceApproved: false,
      postedAt: null,
    });
  });
});
