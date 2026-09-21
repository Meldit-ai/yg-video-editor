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
        where: { editorId: "user_1", active: true },
      }),
    );
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
    editorsByCampaign?: Array<{ campaignId: string; editorId: string }>;
  }) {
    const groupBy = vi
      .fn()
      // First call is the label grouping, second is distinct editors.
      .mockResolvedValueOnce(options.byLabel ?? [])
      .mockResolvedValueOnce(options.editorsByCampaign ?? []);
    const prisma = {
      client: {
        campaign: {
          count: vi.fn().mockResolvedValue(2),
          findMany: vi
            .fn()
            .mockResolvedValue([{ id: "c1", title: "Traitors" }]),
        },
        user: { count: vi.fn().mockResolvedValue(3) },
        campaignRate: { count: vi.fn().mockResolvedValue(1) },
        videoSubmission: {
          groupBy,
          findMany: vi.fn().mockResolvedValue([]),
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
