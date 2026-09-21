import { Role, Uniqueness } from "@repo/database";
import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedUser } from "../auth/auth.types.js";
import type { PrismaService } from "../prisma/prisma.service.js";
import { DashboardService } from "./dashboard.service.js";

type Row = {
  campaignId: string;
  duplicationScore: number | null;
  uniqueness: Uniqueness | null;
  campaign: { title: string };
};

function serviceWith(rows: Row[]) {
  const findMany = vi.fn().mockResolvedValue(rows);
  const prisma = {
    client: { videoSubmission: { findMany } },
  } as unknown as PrismaService;
  return { service: new DashboardService(prisma), findMany };
}

function editor(rateCard: number | null): AuthenticatedUser {
  return {
    id: "user_1",
    role: Role.EDITOR,
    rateCard,
  } as AuthenticatedUser;
}

const row = (
  campaignId: string,
  duplicationScore: number | null,
  uniqueness: Uniqueness | null = Uniqueness.UNIQUE,
): Row => ({
  campaignId,
  duplicationScore,
  uniqueness,
  campaign: { title: campaignId.toUpperCase() },
});

describe("DashboardService.statsFor", () => {
  it("reads only the caller's own active submissions", async () => {
    const { service, findMany } = serviceWith([]);
    await service.statsFor(editor(500));
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { editorId: "user_1", active: true, source: "EDITOR" },
      }),
    );
  });

  /**
   * The bug this exists for: reels adopted from the tracker carry an editorId
   * too, so an editor's dashboard counted 149 videos against 99 actually
   * handed in — and multiplied their rate card by the inflated number.
   */
  it("excludes reels adopted from the tracker", async () => {
    const { service, findMany } = serviceWith([]);
    await service.statsFor(editor(500));
    expect(findMany.mock.calls[0]![0]!.where.source).toBe("EDITOR");
  });

  it("counts videos, duplicates and campaigns", async () => {
    const { service } = serviceWith([
      row("c1", 95, Uniqueness.DUPLICATE),
      row("c1", 10),
      row("c2", 40),
    ]);
    const stats = await service.statsFor(editor(500));
    expect(stats.videosUploaded).toBe(3);
    expect(stats.duplicateCount).toBe(1);
    expect(stats.uniqueCount).toBe(2);
    expect(stats.campaignsContributed).toBe(2);
    expect(stats.perCampaign[0]).toMatchObject({
      campaignId: "c1",
      videos: 2,
      duplicates: 1,
      unique: 1,
    });
  });

  /**
   * The bug this exists for: the dashboard counted the deprecated
   * `overThreshold` boolean while every other screen had moved to
   * `uniqueness`, so an editor's duplicate count here disagreed with the
   * campaign feed showing the same videos.
   */
  it("reads uniqueness, not the deprecated overThreshold boolean", async () => {
    const { service, findMany } = serviceWith([]);
    await service.statsFor(editor(500));
    const select = findMany.mock.calls[0]![0]!.select;
    expect(select).toHaveProperty("uniqueness", true);
    expect(select).not.toHaveProperty("overThreshold");
  });

  it("counts a PARTIAL as neither duplicate nor unique", async () => {
    // It shares something with an earlier video but sat below the line the
    // admin drew. Calling it a duplicate accuses the editor on a score the
    // campaign accepted; calling it unique hides it.
    const { service } = serviceWith([row("c1", 30, Uniqueness.PARTIAL)]);
    const stats = await service.statsFor(editor(500));
    expect(stats.videosUploaded).toBe(1);
    expect(stats.duplicateCount).toBe(0);
    expect(stats.uniqueCount).toBe(0);
    expect(stats.uncheckedCount).toBe(0);
  });

  it("keeps unchecked videos apart from clean ones", async () => {
    // "No run has reached it yet" is not the same finding as "checked and
    // original", and folding them together flatters a campaign mid-run.
    const { service } = serviceWith([
      row("c1", null, null),
      row("c1", 5, Uniqueness.UNIQUE),
    ]);
    const stats = await service.statsFor(editor(500));
    expect(stats.uncheckedCount).toBe(1);
    expect(stats.uniqueCount).toBe(1);
    expect(stats.perCampaign[0]).toMatchObject({ unchecked: 1, unique: 1 });
  });

  it("averages only the videos that were actually compared", async () => {
    // The null one has not been through a run; counting it as 0 would report
    // a cleaner average than the evidence supports.
    const { service } = serviceWith([row("c1", 80), row("c1", 20), row("c1", null)]);
    const stats = await service.statsFor(editor(null));
    expect(stats.averageDuplicationScore).toBe(50);
  });

  it("reports a null average when nothing has been compared yet", async () => {
    const { service } = serviceWith([row("c1", null)]);
    const stats = await service.statsFor(editor(500));
    expect(stats.averageDuplicationScore).toBeNull();
  });

  it("leaves earnings null when no rate is agreed, rather than zero", async () => {
    const { service } = serviceWith([row("c1", 10), row("c1", 20)]);
    const stats = await service.statsFor(editor(null));
    expect(stats.estimatedEarnings).toBeNull();
    expect(stats.rateCard).toBeNull();
  });

  it("multiplies the rate card by the videos submitted", async () => {
    const { service } = serviceWith([row("c1", 10), row("c1", 20)]);
    const stats = await service.statsFor(editor(1750.5));
    expect(stats.estimatedEarnings).toBe(3501);
  });

  it("gives an admin no earnings, since a rate card is editor-only", async () => {
    const { service } = serviceWith([row("c1", 10)]);
    const admin = {
      id: "user_1",
      role: Role.ADMIN,
      rateCard: null,
    } as AuthenticatedUser;
    const stats = await service.statsFor(admin);
    expect(stats.estimatedEarnings).toBeNull();
  });
});

describe("DashboardService.adminStats", () => {
  function adminServiceWith(options: {
    byLabel?: Array<{
      campaignId: string;
      uniqueness: Uniqueness | null;
      _count: { _all: number };
    }>;
    byEditor?: Array<{
      editorId: string;
      uniqueness: Uniqueness | null;
      _count: { _all: number };
    }>;
    editorsByCampaign?: Array<{ campaignId: string; editorId: string }>;
    shareStatuses?: Array<{ status: string; _count: { _all: number } }>;
    runStatuses?: Array<{ status: string; _count: { _all: number } }>;
  }) {
    // Order matters: the service issues the campaign-label grouping, then the
    // per-editor grouping, then distinct editors per campaign.
    const groupBy = vi
      .fn()
      .mockResolvedValueOnce(options.byLabel ?? [])
      .mockResolvedValueOnce(options.byEditor ?? [])
      .mockResolvedValueOnce(options.editorsByCampaign ?? []);
    const prisma = {
      client: {
        campaign: {
          count: vi.fn().mockResolvedValue(2),
          findMany: vi
            .fn()
            .mockResolvedValue([{ id: "c1", title: "Traitors" }]),
        },
        user: {
          count: vi.fn().mockResolvedValue(3),
          findMany: vi.fn().mockResolvedValue([{ id: "u1", name: "Ravi" }]),
        },
        campaignRate: { count: vi.fn().mockResolvedValue(1) },
        videoSubmission: { groupBy },
        vendorShareRecipient: {
          groupBy: vi.fn().mockResolvedValue(options.shareStatuses ?? []),
        },
        videoComparison: {
          groupBy: vi.fn().mockResolvedValue(options.runStatuses ?? []),
        },
      },
    } as unknown as PrismaService;
    return { service: new DashboardService(prisma), groupBy };
  }

  it("counts only the editors' hand-ins, not adopted reels", async () => {
    // Reels brought in from the tracker are a separate pipeline with its own
    // screens; blending them would disagree with the campaign feed.
    const { service, groupBy } = adminServiceWith({});
    await service.adminStats();
    expect(groupBy.mock.calls[0]![0]!.where).toMatchObject({
      active: true,
      source: "EDITOR",
    });
  });

  it("totals the labels across campaigns", async () => {
    const { service } = adminServiceWith({
      byLabel: [
        { campaignId: "c1", uniqueness: Uniqueness.UNIQUE, _count: { _all: 32 } },
        { campaignId: "c1", uniqueness: Uniqueness.DUPLICATE, _count: { _all: 64 } },
        { campaignId: "c1", uniqueness: Uniqueness.PARTIAL, _count: { _all: 1 } },
      ],
      editorsByCampaign: [{ campaignId: "c1", editorId: "u1" }],
    });
    const stats = await service.adminStats();
    expect(stats.unique).toBe(32);
    expect(stats.duplicates).toBe(64);
    // The PARTIAL counts in videos and in neither label, as on /me.
    expect(stats.videos).toBe(97);
    expect(stats.perCampaign[0]).toMatchObject({
      campaignTitle: "Traitors",
      videos: 97,
      unique: 32,
      duplicates: 64,
      editors: 1,
    });
  });

  it("rates an editor on what was checked, not on everything", async () => {
    // Otherwise someone mid-run reads as less original than they are: the
    // videos the engine has not reached yet would count against them.
    const { service } = adminServiceWith({
      byEditor: [
        { editorId: "u1", uniqueness: Uniqueness.UNIQUE, _count: { _all: 3 } },
        { editorId: "u1", uniqueness: Uniqueness.DUPLICATE, _count: { _all: 1 } },
        { editorId: "u1", uniqueness: null, _count: { _all: 96 } },
      ],
    });
    const stats = await service.adminStats();
    expect(stats.perEditor[0]).toMatchObject({
      editorName: "Ravi",
      videos: 100,
      unique: 3,
      duplicates: 1,
      // 3 of the 4 checked, not 3 of 100.
      originalRate: 75,
    });
  });

  it("reports no rate rather than zero when nothing is checked", async () => {
    const { service } = adminServiceWith({
      byEditor: [
        { editorId: "u1", uniqueness: null, _count: { _all: 5 } },
      ],
    });
    // Null, not 0: nobody has judged this editor's work yet, which is not
    // the same as judging it and finding nothing original.
    const result = await service.adminStats();
    expect(result.perEditor[0]!.originalRate).toBeNull();
  });

  it("counts failures that want acting on", async () => {
    const { service } = adminServiceWith({
      shareStatuses: [
        { status: "SENT", _count: { _all: 11 } },
        { status: "FAILED", _count: { _all: 12 } },
      ],
      runStatuses: [
        { status: "FAILED", _count: { _all: 19 } },
        { status: "SUCCEEDED", _count: { _all: 4 } },
      ],
    });
    const result = await service.adminStats();
    expect(result.attention).toEqual({
      failedShares: 12,
      totalShareRecipients: 23,
      failedRuns: 19,
      succeededRuns: 4,
    });
  });

  it("reports zero for a status that never occurred", async () => {
    const { service } = adminServiceWith({ shareStatuses: [], runStatuses: [] });
    const result = await service.adminStats();
    expect(result.attention.failedShares).toBe(0);
    expect(result.attention.succeededRuns).toBe(0);
  });

  it("counts distinct editors, not their rows", async () => {
    const { service } = adminServiceWith({
      byLabel: [
        { campaignId: "c1", uniqueness: Uniqueness.UNIQUE, _count: { _all: 9 } },
      ],
      editorsByCampaign: [
        { campaignId: "c1", editorId: "u1" },
        { campaignId: "c1", editorId: "u2" },
      ],
    });
    const stats = await service.adminStats();
    expect(stats.perCampaign[0]!.editors).toBe(2);
  });
});
