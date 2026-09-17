import { ComparisonStatus, Uniqueness } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../prisma/prisma.service.js";
import { ReelTarget } from "./reel-target.js";

const reel = {
  findMany: vi.fn(),
  count: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
};
const campaign = { findFirst: vi.fn() };
const run = { create: vi.fn(), update: vi.fn(), updateMany: vi.fn() };

const client = { campaignReel: reel, campaign, reelMatchRun: run };
const prisma = { client } as unknown as PrismaService;

const T0 = new Date("2026-09-01T00:00:00Z");
const T1 = new Date("2026-09-02T00:00:00Z");

describe("ReelTarget", () => {
  let target: ReelTarget;

  beforeEach(() => {
    vi.clearAllMocks();
    target = new ReelTarget(prisma);
  });

  it("orders by Instagram post time, unknown last, then by import time, carrying the ETag as identity", async () => {
    reel.findMany.mockResolvedValueOnce([
      { id: "r1", mediaUrl: "https://ig/1.mp4", postedAt: T0, createdAt: T1, mediaEtag: '"4204a0"' },
      { id: "r2", mediaUrl: "https://ig/2.mp4", postedAt: null, createdAt: T0, mediaEtag: null },
    ]);

    await expect(target.loadPending("cmp_1")).resolves.toEqual([
      // The ETag's surrounding quotes are wire syntax, not identity.
      { id: "r1", url: "https://ig/1.mp4", arrivedAt: T0, identity: "etag:4204a0" },
      // No post time: the import time stands in, and it sorts after anyway.
      { id: "r2", url: "https://ig/2.mp4", arrivedAt: T0, identity: undefined },
    ]);
    expect(reel.findMany).toHaveBeenCalledWith({
      where: { campaignId: "cmp_1", active: true, uniqueness: null, checkedAt: null },
      select: { id: true, mediaUrl: true, postedAt: true, createdAt: true, mediaEtag: true },
      orderBy: [{ postedAt: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
    });
  });

  it("derives isOriginal from the label when writing an outcome", async () => {
    const checkedAt = new Date();
    await target.writeOutcome(
      "r2",
      { uniqueness: Uniqueness.UNIQUE, matchValue: 9, averageValue: 6, parentId: "r1" },
      checkedAt,
    );
    expect(reel.update).toHaveBeenCalledWith({
      where: { id: "r2" },
      data: {
        uniqueness: Uniqueness.UNIQUE,
        duplicationScore: 9,
        originalReelId: "r1",
        isOriginal: true,
        checkedAt,
      },
    });
  });

  it("re-labels on originalReelId, keeping isOriginal in step", async () => {
    const tx = { campaignReel: { updateMany: vi.fn() } };
    await target.relabelForThreshold(tx as never, "cmp_1", 90);

    const calls = tx.campaignReel.updateMany.mock.calls.map((call) => call[0]);
    expect(calls[0]).toMatchObject({
      where: { originalReelId: { not: null }, duplicationScore: { gte: 90 } },
      data: { uniqueness: Uniqueness.DUPLICATE, isOriginal: false },
    });
    expect(calls[2]).toMatchObject({
      data: { uniqueness: Uniqueness.UNIQUE, isOriginal: true },
    });
  });

  it("opens a run with the threshold snapshot and the trigger reel", async () => {
    run.create.mockResolvedValueOnce({ id: "rmr_1" });
    await expect(
      target.openRun("cmp_1", { triggerId: "r3", threshold: 90, candidateCount: 1 }),
    ).resolves.toBe("rmr_1");
    expect(run.create).toHaveBeenCalledWith({
      data: {
        campaignId: "cmp_1",
        status: ComparisonStatus.QUEUED,
        threshold: 90,
        triggerReelId: "r3",
        reelCount: 1,
      },
      select: { id: true },
    });
  });

  it("mirrors progress, including the copies found so far", async () => {
    await target.updateRun("rmr_1", {
      stage: "comparing",
      pairsDone: 3,
      pairsTotal: 6,
      videoCount: 4,
      matchCount: 2,
    });
    expect(run.update).toHaveBeenCalledWith({
      where: { id: "rmr_1" },
      data: {
        status: ComparisonStatus.RUNNING,
        pairsDone: 3,
        pairsTotal: 6,
        reelCount: 4,
        matchCount: 2,
      },
    });
  });

  it("records nothing per call — reel pair rows are a later addition", async () => {
    await target.recordCall("rmr_1", {
      candidate: { id: "r2", url: "u2", arrivedAt: T0 },
      slice: [],
      jobId: "j",
      status: ComparisonStatus.SUCCEEDED,
      errorMessage: null,
      resolved: { videos: [], pairs: [] },
    });
    expect(run.update).not.toHaveBeenCalled();
  });

  it("lists campaigns with pending reels", async () => {
    reel.findMany.mockResolvedValueOnce([{ campaignId: "cmp_2" }]);
    await expect(target.campaignsWithPending()).resolves.toEqual(["cmp_2"]);
    expect(reel.findMany).toHaveBeenCalledWith({
      where: { active: true, uniqueness: null, checkedAt: null, campaign: { active: true } },
      select: { campaignId: true },
      distinct: ["campaignId"],
    });
  });
});
