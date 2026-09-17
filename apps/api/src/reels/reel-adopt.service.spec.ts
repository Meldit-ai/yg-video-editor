import { Role } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../prisma/prisma.service.js";
import type { StorageService } from "../storage/storage.service.js";
import type { UniquenessService } from "../uniqueness/uniqueness.service.js";
import { ReelAdoptService } from "./reel-adopt.service.js";

const prismaClient = {
  campaign: { findFirst: vi.fn() },
  user: { findFirst: vi.fn() },
  campaignReel: { findMany: vi.fn() },
  videoSubmission: { findMany: vi.fn(), count: vi.fn() },
};
const prisma = { client: prismaClient } as unknown as PrismaService;
const storage = {} as unknown as StorageService;
const uniquenessMock = { onArrival: vi.fn() };
const uniqueness = uniquenessMock as unknown as UniquenessService;

describe("ReelAdoptService", () => {
  let service: ReelAdoptService;

  beforeEach(() => {
    vi.clearAllMocks();
    prismaClient.campaign.findFirst.mockResolvedValue({ id: "cmp_1" });
    prismaClient.user.findFirst.mockResolvedValue({ id: "usr_1", role: Role.EDITOR });
    prismaClient.campaignReel.findMany.mockResolvedValue([
      { id: "r1", username: "creator", mediaUrl: "https://cdn/r1.mp4", postedAt: null },
    ]);
    prismaClient.videoSubmission.count.mockResolvedValue(1);
    service = new ReelAdoptService(prisma, storage, uniqueness);
    // The copy itself streams bytes into the bucket; not what is under test.
    vi.spyOn(
      service as unknown as { adoptOne: () => Promise<void> },
      "adoptOne",
    ).mockResolvedValue(undefined);
  });

  it("hands adopted reels to the classifier as submissions", async () => {
    prismaClient.videoSubmission.findMany.mockResolvedValue([]);

    await service.adoptAll("cmp_1", "usr_1");

    expect(uniquenessMock.onArrival).toHaveBeenCalledWith("submission", "cmp_1");
  });

  it("does not start a check when nothing new was adopted", async () => {
    prismaClient.videoSubmission.findMany.mockResolvedValue([
      { fileName: "creator [reel r1].mp4" },
    ]);

    const result = await service.adoptAll("cmp_1", "usr_1");

    expect(result.alreadyAdopted).toBe(1);
    expect(uniquenessMock.onArrival).not.toHaveBeenCalled();
  });
});
