import { Uniqueness } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../prisma/prisma.service.js";
import type { TrackerReel, TrackerService } from "../tracker/tracker.service.js";
import type { UniquenessService } from "../uniqueness/uniqueness.service.js";
import { ReelsService } from "./reels.service.js";

vi.mock("./media-head.js", () => ({
  headMediaAll: vi.fn(async (urls: string[]) =>
    urls.map((url) => ({ sizeBytes: 4242, etag: `"etag-of-${url.slice(-6)}"` })),
  ),
}));

const reelDelegate = {
  findUnique: vi.fn(),
  upsert: vi.fn(),
  count: vi.fn(),
  findMany: vi.fn(),
};
const campaignDelegate = { findFirst: vi.fn() };
const prisma = {
  client: {
    campaignReel: reelDelegate,
    campaign: campaignDelegate,
    // The import batches its upserts, so it hands the client an array of
    // promises rather than calling upsert and awaiting it one at a time.
    $transaction: (work: unknown) =>
      Array.isArray(work) ? Promise.all(work) : Promise.resolve([]),
  },
} as unknown as PrismaService;

const trackerMock = { listReels: vi.fn() };
const tracker = trackerMock as unknown as TrackerService;

const uniquenessMock = { onArrival: vi.fn() };
const uniqueness = uniquenessMock as unknown as UniquenessService;

function trackerReel(id: string): TrackerReel {
  return {
    trackerPostId: id,
    socialUsername: `https://instagram.com/${id}`,
    username: id,
    permalink: null,
    mediaUrl: `https://cdn/${id}.mp4`,
    postedAt: new Date("2026-09-01T00:00:00Z"),
    postCounts: null,
    caption: null,
    invoiceApproved: false,
  };
}

function reelRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "r1",
    username: "creator",
    socialUsername: "https://instagram.com/creator",
    permalink: null,
    mediaUrl: "https://cdn/r1.mp4",
    postedAt: new Date("2026-09-01T00:00:00Z"),
    caption: null,
    postCounts: null,
    uniqueness: null,
    duplicationScore: null,
    originalReelId: null,
    isOriginal: false,
    checkedAt: null,
    ...overrides,
  };
}

describe("ReelsService", () => {
  let service: ReelsService;

  beforeEach(() => {
    vi.clearAllMocks();
    campaignDelegate.findFirst.mockResolvedValue({
      trackerCampaignId: "trk_1",
      title: "Summer",
    });
    reelDelegate.upsert.mockResolvedValue({});
    reelDelegate.count.mockResolvedValue(1);
    service = new ReelsService(prisma, tracker, uniqueness);
  });

  describe("importFromTracker", () => {
    it("hands newly imported reels to the classifier", async () => {
      trackerMock.listReels.mockResolvedValue([trackerReel("p1")]);
      // Nothing stored for this campaign yet, so p1 is new.
      reelDelegate.findMany.mockResolvedValue([]);

      await service.importFromTracker("cmp_1");

      expect(uniquenessMock.onArrival).toHaveBeenCalledWith("reel", "cmp_1");
    });

    it("records each imported reel's size and ETag from a HEAD on its media", async () => {
      trackerMock.listReels.mockResolvedValue([trackerReel("p1")]);
      reelDelegate.findUnique.mockResolvedValue(null);

      await service.importFromTracker("cmp_1");

      expect(reelDelegate.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ mediaSizeBytes: 4242, mediaEtag: '"etag-of-p1.mp4"' }),
          update: expect.objectContaining({ mediaSizeBytes: 4242, mediaEtag: '"etag-of-p1.mp4"' }),
        }),
      );
    });

    it("leaves the classifier alone when every reel was already known", async () => {
      trackerMock.listReels.mockResolvedValue([trackerReel("p1")]);
      // p1 is already on record, so the import updates it and nothing is new.
      reelDelegate.findMany.mockResolvedValue([{ trackerPostId: "p1" }]);

      await service.importFromTracker("cmp_1");

      expect(uniquenessMock.onArrival).not.toHaveBeenCalled();
    });
  });

  describe("findAll", () => {
    it("orders by label, then match value, then post time — unchecked last", async () => {
      reelDelegate.findMany.mockResolvedValue([]);

      await service.findAll("cmp_1");

      expect(reelDelegate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [
            { uniqueness: { sort: "asc", nulls: "last" } },
            { duplicationScore: { sort: "asc", nulls: "last" } },
            { postedAt: "asc" },
          ],
        }),
      );
    });

    it("names the original's profile only for a reel that is not itself UNIQUE", async () => {
      reelDelegate.findMany
        .mockResolvedValueOnce([
          reelRow({ id: "r2", uniqueness: Uniqueness.DUPLICATE, originalReelId: "r1" }),
          // UNIQUE with a stored best match: the match is bookkeeping for a
          // later threshold edit, not something to show as "copied from".
          reelRow({ id: "r3", uniqueness: Uniqueness.UNIQUE, originalReelId: "r1", isOriginal: true }),
        ])
        .mockResolvedValueOnce([{ id: "r1", username: "first" }]);

      const [copy, original] = await service.findAll("cmp_1");

      expect(copy).toMatchObject({ uniqueness: "DUPLICATE", originalUsername: "first" });
      expect(original).toMatchObject({ uniqueness: "UNIQUE", originalUsername: null });
    });
  });
});
