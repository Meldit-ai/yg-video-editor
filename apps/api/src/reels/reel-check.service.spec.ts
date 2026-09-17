import { ComparisonStatus } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../prisma/prisma.service.js";
import type { UniquenessService } from "../uniqueness/uniqueness.service.js";
import { ReelCheckService } from "./reel-check.service.js";

const runDelegate = { findFirst: vi.fn() };
const reelDelegate = { count: vi.fn() };
const prisma = {
  client: { reelMatchRun: runDelegate, campaignReel: reelDelegate },
} as unknown as PrismaService;

const uniquenessMock = { rebuild: vi.fn() };
const uniqueness = uniquenessMock as unknown as UniquenessService;

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "rmr_1",
    campaignId: "cmp_1",
    status: ComparisonStatus.QUEUED,
    threshold: 90,
    reelCount: 3,
    pairsDone: 0,
    pairsTotal: 0,
    matchCount: 0,
    errorMessage: null,
    createdAt: new Date("2026-09-17T00:00:00Z"),
    completedAt: null,
    ...overrides,
  };
}

describe("ReelCheckService", () => {
  let service: ReelCheckService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new ReelCheckService(prisma, uniqueness);
  });

  it("rebuilds the campaign's reel labels and returns the run to poll", async () => {
    reelDelegate.count.mockResolvedValue(3);
    uniquenessMock.rebuild.mockResolvedValue("rmr_1");
    runDelegate.findFirst.mockResolvedValue(runRow());

    const run = await service.start("cmp_1");

    expect(uniquenessMock.rebuild).toHaveBeenCalledWith("reel", "cmp_1");
    expect(run).toMatchObject({ id: "rmr_1", status: ComparisonStatus.QUEUED });
  });

  it("refuses a campaign with fewer than two reels before touching anything", async () => {
    reelDelegate.count.mockResolvedValue(1);

    await expect(service.start("cmp_1")).rejects.toThrow(/At least 2 reels/);
    expect(uniquenessMock.rebuild).not.toHaveBeenCalled();
  });

  it("reads the most recent run, or null when none has run", async () => {
    runDelegate.findFirst.mockResolvedValueOnce(null);
    await expect(service.findLatest("cmp_1")).resolves.toBeNull();

    runDelegate.findFirst.mockResolvedValueOnce(runRow({ status: ComparisonStatus.SUCCEEDED }));
    await expect(service.findLatest("cmp_1")).resolves.toMatchObject({
      status: ComparisonStatus.SUCCEEDED,
    });
  });
});
