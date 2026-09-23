import { Role, Uniqueness } from "@repo/database";
import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedUser } from "../auth/auth.types.js";
import type { PrismaService } from "../prisma/prisma.service.js";
import { DashboardService } from "./dashboard.service.js";

type Row = {
  id: string;
  campaignId: string;
  duplicationScore: number | null;
  uniqueness: Uniqueness | null;
  campaign: { title: string };
};

function serviceWith(rows: Row[], matched: Array<{ submissionId: string }> = []) {
  const findMany = vi.fn().mockResolvedValue(rows);
  const prisma = {
    client: {
      videoSubmission: { findMany },
      // Which of this editor's videos reached Instagram — half of what is
      // payable. Empty unless a test says otherwise.
      crossPlatformMatch: {
        findMany: vi.fn().mockResolvedValue(matched),
      },
    },
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

let nextRowId = 0;
const row = (
  campaignId: string,
  duplicationScore: number | null,
  uniqueness: Uniqueness | null = Uniqueness.UNIQUE,
): Row => ({
  // Distinct per row, so a test can say which one reached Instagram.
  id: `sub_${(nextRowId += 1)}`,
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

  /**
   * Payment is for original work and for work that reached Instagram. A cut
   * handed in twice is one piece of work, so an unposted copy earns nothing —
   * but a copy that got posted is paid for the posting.
   */
  it("pays for unique work", async () => {
    const { service } = serviceWith([row("c1", 5, Uniqueness.UNIQUE)]);
    const stats = await service.statsFor(editor(1500));
    expect(stats.payableCount).toBe(1);
    expect(stats.estimatedEarnings).toBe(1500);
  });

  it("does not pay for a duplicate nobody posted", async () => {
    const { service } = serviceWith([row("c1", 95, Uniqueness.DUPLICATE)]);
    const stats = await service.statsFor(editor(1500));
    expect(stats.payableCount).toBe(0);
    expect(stats.estimatedEarnings).toBe(0);
  });

  it("pays for a duplicate that did get posted", async () => {
    const rows = [row("c1", 95, Uniqueness.DUPLICATE)];
    const { service } = serviceWith(rows, [{ submissionId: rows[0]!.id }]);
    const stats = await service.statsFor(editor(1500));
    expect(stats.payableCount).toBe(1);
    expect(stats.estimatedEarnings).toBe(1500);
  });

  /**
   * The bug this exists for: a video can be both the editor's own work and
   * matched on the tracker. Adding the two sets would pay for it twice.
   */
  it("pays once for a video that is both unique and posted", async () => {
    const rows = [row("c1", 5, Uniqueness.UNIQUE)];
    const { service } = serviceWith(rows, [{ submissionId: rows[0]!.id }]);
    const stats = await service.statsFor(editor(1500));
    expect(stats.payableCount).toBe(1);
    expect(stats.estimatedEarnings).toBe(1500);
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
    editorsByCampaign?: Array<{
      campaignId: string;
      editorId: string;
      _count: { _all: number };
    }>;
    duplicatesByEditor?: Array<{
      editorId: string;
      _count: { _all: number };
    }>;
    payableByCampaign?: Array<{
      campaignId: string;
      editorId: string;
      _count: { _all: number };
    }>;
    /** Submissions matched to a tracker reel. */
    matched?: Array<{ submissionId: string }>;
    /** Rate card for the mocked editor, behind the spend figures. */
    rateCard?: number | null;
    lastRun?: { status: string; createdAt: Date } | null;
  }) {
    // Order matters: the service issues the campaign-label grouping, then the
    // per-editor grouping, then distinct editors per campaign.
    // Order matters: campaign labels, per editor, duplicate clusters, then
    // distinct editors per campaign.
    const groupBy = vi
      .fn()
      .mockResolvedValueOnce(options.byLabel ?? [])
      .mockResolvedValueOnce(options.byEditor ?? [])
      .mockResolvedValueOnce(options.editorsByCampaign ?? [])
      // Payable videos per editor per campaign.
      .mockResolvedValueOnce(
        options.payableByCampaign ?? options.editorsByCampaign ?? [],
      )
      // Duplicates that were posted, for what repeated work cost.
      .mockResolvedValueOnce(options.duplicatesByEditor ?? []);
    const findFirstRun = vi
      .fn()
      .mockResolvedValue(
        options.lastRun === undefined
          ? { status: "SUCCEEDED", createdAt: new Date("2026-09-21") }
          : options.lastRun,
      );
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
          findMany: vi
            .fn()
            .mockResolvedValue([
              { id: "u1", name: "Ravi", rateCard: options.rateCard ?? null },
            ]),
        },
        videoSubmission: {
          groupBy,
          count: vi.fn().mockResolvedValue(0),
          findUnique: vi.fn().mockResolvedValue({
            id: "s1",
            campaignId: "c1",
            fileName: "final-cut.mp4",
            campaign: { title: "Traitors" },
          }),
        },
        videoComparison: { findFirst: findFirstRun },
        // Which submissions reached Instagram — half of what is payable.
        crossPlatformMatch: {
          findMany: vi.fn().mockResolvedValue(options.matched ?? []),
        },
      },
    } as unknown as PrismaService;
    return { service: new DashboardService(prisma), groupBy, findFirstRun };
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
      editorsByCampaign: [
        { campaignId: "c1", editorId: "u1", _count: { _all: 97 } },
      ],
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

  /**
   * The bug this exists for: counting every failure ever recorded showed
   * "19 duplicate checks failed" on a system whose most recent run had
   * succeeded — each dev restart had marked one failed. A panel that is
   * permanently red is a panel nobody reads.
   */
  it("reports the latest run per campaign, not every run ever", async () => {
    const { service, findFirstRun } = adminServiceWith({
      lastRun: { status: "SUCCEEDED", createdAt: new Date("2026-09-21") },
    });
    const result = await service.adminStats();
    expect(findFirstRun).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { createdAt: "desc" } }),
    );
    expect(result.health[0]).toMatchObject({
      campaignTitle: "Traitors",
      lastRunStatus: "SUCCEEDED",
      unchecked: 0,
    });
  });

  it("says so when a campaign has never been checked", async () => {
    // Null, not "FAILED": nothing has run, which is not the same as a run
    // that went wrong.
    const { service } = adminServiceWith({ lastRun: null });
    const result = await service.adminStats();
    expect(result.health[0]!.lastRunStatus).toBeNull();
    expect(result.health[0]!.lastRunAt).toBeNull();
  });



  it("prices a campaign at each editor's own rate", async () => {
    // Two editors on one campaign are usually on different rates, so a single
    // multiplication over the campaign's total would be wrong.
    const { service } = adminServiceWith({
      byLabel: [
        { campaignId: "c1", uniqueness: Uniqueness.UNIQUE, _count: { _all: 9 } },
      ],
      editorsByCampaign: [
        { campaignId: "c1", editorId: "u1", _count: { _all: 9 } },
      ],
      rateCard: 1500,
    });
    const stats = await service.adminStats();
    expect(stats.perCampaign[0]?.spend).toBe(13500);
    expect(stats.perCampaign[0]?.pricedVideos).toBe(9);
    expect(stats.totalSpend).toBe(13500);
  });

  it("leaves spend null when no rate is agreed, not zero", async () => {
    // Zero would read as "this work is worth nothing" rather than "nobody has
    // agreed what it is worth".
    const { service } = adminServiceWith({
      byLabel: [
        { campaignId: "c1", uniqueness: Uniqueness.UNIQUE, _count: { _all: 9 } },
      ],
      editorsByCampaign: [
        { campaignId: "c1", editorId: "u1", _count: { _all: 9 } },
      ],
      rateCard: null,
    });
    const stats = await service.adminStats();
    expect(stats.perCampaign[0]?.spend).toBeNull();
    expect(stats.totalSpend).toBeNull();
  });

  it("prices the repeated work separately", async () => {
    // The cost of the problem the duplicate checking exists to find.
    const { service } = adminServiceWith({
      byLabel: [
        { campaignId: "c1", uniqueness: Uniqueness.DUPLICATE, _count: { _all: 4 } },
      ],
      editorsByCampaign: [
        { campaignId: "c1", editorId: "u1", _count: { _all: 4 } },
      ],
      duplicatesByEditor: [{ editorId: "u1", _count: { _all: 4 } }],
      rateCard: 1500,
    });
    const stats = await service.adminStats();
    expect(stats.duplicateSpend).toBe(6000);
  });

  it("counts distinct editors, not their rows", async () => {
    const { service } = adminServiceWith({
      byLabel: [
        { campaignId: "c1", uniqueness: Uniqueness.UNIQUE, _count: { _all: 9 } },
      ],
      editorsByCampaign: [
        { campaignId: "c1", editorId: "u1", _count: { _all: 5 } },
        { campaignId: "c1", editorId: "u2", _count: { _all: 4 } },
      ],
    });
    const stats = await service.adminStats();
    expect(stats.perCampaign[0]!.editors).toBe(2);
  });
});
