import { describe, expect, it, vi } from "vitest";
import { MatchesService } from "./matches.service.js";
import type { PrismaService } from "../prisma/prisma.service.js";
import type { StorageService } from "../storage/storage.service.js";

/**
 * A run over a campaign with nothing to match against must say so.
 *
 * "0 matches" from an empty campaign reads exactly like a real check that
 * found none, and the two mean very different things: one is a finding, the
 * other is a run that never happened. The UI branches on `totalReels` and
 * `trackerLinked` to tell them apart.
 */
function serviceWith(options: {
  trackerCampaignId: string | null;
  reelCount: number;
}) {
  const reelCount = vi.fn().mockResolvedValue(options.reelCount);
  const prisma = {
    client: {
      campaign: {
        findFirst: vi.fn().mockResolvedValue({
          id: "c1",
          title: "Probe",
          trackerCampaignId: options.trackerCampaignId,
        }),
      },
      campaignReel: {
        count: reelCount,
        findMany: vi.fn().mockResolvedValue([]),
      },
      videoSubmission: { findMany: vi.fn().mockResolvedValue([]) },
      crossPlatformMatch: {
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      videoFrameSignature: { findMany: vi.fn().mockResolvedValue([]) },
    },
  } as unknown as PrismaService;
  const storage = {
    presignPlaybackUrl: vi.fn().mockResolvedValue("x"),
  } as unknown as StorageService;
  return new MatchesService(prisma, storage);
}

describe("MatchRunResult on an empty campaign", () => {
  it("reports no tracker link when there is none", async () => {
    const service = serviceWith({ trackerCampaignId: null, reelCount: 0 });
    const result = await service.run("c1");
    expect(result.trackerLinked).toBe(false);
    expect(result.totalReels).toBe(0);
    expect(result.matchCount).toBe(0);
  });

  it("reports a link with no reels imported", async () => {
    // Linked, but nothing pulled in yet — a different fix from linking one.
    const service = serviceWith({ trackerCampaignId: "t1", reelCount: 0 });
    const result = await service.run("c1");
    expect(result.trackerLinked).toBe(true);
    expect(result.totalReels).toBe(0);
  });

  it("reports the reel count when there is one", async () => {
    const service = serviceWith({ trackerCampaignId: "t1", reelCount: 5186 });
    const result = await service.run("c1");
    expect(result.totalReels).toBe(5186);
  });
});
