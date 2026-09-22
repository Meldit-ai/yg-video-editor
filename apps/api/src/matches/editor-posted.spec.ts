import { describe, expect, it, vi } from "vitest";
import { MatchesService } from "./matches.service.js";
import type { PrismaService } from "../prisma/prisma.service.js";
import type { StorageService } from "../storage/storage.service.js";

/** One stored match row, as the include in findForEditor shapes it. */
function matchRow(options: {
  submissionId: string;
  username: string;
  views?: number;
}) {
  return {
    submissionId: options.submissionId,
    uploadedAt: new Date("2026-09-01"),
    postedAt: new Date("2026-09-02"),
    submission: {
      fileName: "cut.mp4",
      objectKey: "key",
      contentType: "video/mp4",
      createdAt: new Date("2026-09-01"),
    },
    reel: {
      username: options.username,
      permalink: `https://instagram.com/p/${options.username}`,
      postCounts:
        options.views === undefined ? null : { views: options.views, likes: 10 },
    },
  };
}

function serviceWith(rows: ReturnType<typeof matchRow>[]) {
  const findMany = vi.fn().mockResolvedValue(rows);
  const prisma = {
    client: { crossPlatformMatch: { findMany } },
  } as unknown as PrismaService;
  const storage = {
    presignPlaybackUrl: vi.fn().mockResolvedValue("https://signed/cut.mp4"),
  } as unknown as StorageService;
  return { service: new MatchesService(prisma, storage), findMany };
}

describe("findForEditor", () => {
  it("reads only the caller's own active submissions", async () => {
    // Scoped in the where, not filtered after: this must never be able to
    // return another editor's work.
    const { service, findMany } = serviceWith([]);
    await service.findForEditor("c1", "editor_1");
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          campaignId: "c1",
          active: true,
          submission: { editorId: "editor_1", active: true },
        },
      }),
    );
  });

  /**
   * An editor is shown that their work was posted and what it earned — never
   * how we know. Anything naming the tracker, the hash, or a duplication
   * verdict about their own hand-in stays on the admin route.
   */
  it("tells the editor nothing about how the match was made", async () => {
    const { service } = serviceWith([
      matchRow({ submissionId: "s1", username: "someone", views: 100 }),
    ]);
    const [video] = await service.findForEditor("c1", "editor_1");
    const asText = JSON.stringify(video);

    expect(asText).not.toContain("reelId");
    expect(asText).not.toContain("contentHash");
    expect(asText).not.toContain("origin");
    expect(asText).not.toContain("reelUrl");
    expect(asText).not.toContain("frameShare")
    // "reel" is the tracker's word for these; the editor payload says "post".
    expect(asText).not.toContain("countedReels")
    expect(asText).not.toContain("totalReels");
    // What it does carry: the public post, and what it earned.
    expect(video?.posts[0]?.permalink).toContain("instagram.com");
    expect(video?.totalEngagement.views).toBe(100);
  });

  it("groups every post of one video together", async () => {
    const { service } = serviceWith([
      matchRow({ submissionId: "s1", username: "one", views: 100 }),
      matchRow({ submissionId: "s1", username: "two", views: 50 }),
    ]);
    const videos = await service.findForEditor("c1", "editor_1");
    expect(videos).toHaveLength(1);
    expect(videos[0]?.posts).toHaveLength(2);
    expect(videos[0]?.totalEngagement.views).toBe(150);
    expect(videos[0]?.totalEngagement.totalPosts).toBe(2);
  });

  it("puts the best performing video first", async () => {
    // An editor opening this wants to know which cut travelled, not which was
    // handed in most recently.
    const { service } = serviceWith([
      matchRow({ submissionId: "quiet", username: "a", views: 10 }),
      matchRow({ submissionId: "loud", username: "b", views: 9000 }),
    ]);
    const videos = await service.findForEditor("c1", "editor_1");
    expect(videos.map((one) => one.submissionId)).toEqual(["loud", "quiet"]);
  });

  it("says how many posts reported counts", async () => {
    const { service } = serviceWith([
      matchRow({ submissionId: "s1", username: "one", views: 100 }),
      matchRow({ submissionId: "s1", username: "two" }),
    ]);
    const [video] = await service.findForEditor("c1", "editor_1");
    expect(video?.totalEngagement.countedPosts).toBe(1);
    expect(video?.totalEngagement.totalPosts).toBe(2);
  });
});
