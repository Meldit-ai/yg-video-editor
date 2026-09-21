import { RateStatus, Role } from "@repo/database";
import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedUser } from "../auth/auth.types.js";
import type { PrismaService } from "../prisma/prisma.service.js";
import { RatesService } from "./rates.service.js";

const CAMPAIGN = { id: "c1", title: "Traitors S2", active: true };

function serviceWith(options: {
  defaultRate?: number | null;
  rateCard?: number | null;
  rate?: {
    id?: string;
    amount: number;
    status: RateStatus;
    editorId?: string;
  } | null;
  role?: Role;
}) {
  const campaignRow = {
    ...CAMPAIGN,
    defaultRate: options.defaultRate ?? null,
  };
  const rateRow =
    options.rate == null
      ? null
      : {
          id: options.rate.id ?? "r1",
          campaignId: "c1",
          editorId: options.rate.editorId ?? "user_1",
          amount: options.rate.amount,
          status: options.rate.status,
          previousAmount: null,
          editorNote: null,
          adminNote: null,
          decidedAt: null,
          createdAt: new Date("2026-01-01"),
          updatedAt: new Date("2026-01-01"),
          campaign: { title: CAMPAIGN.title },
          editor: { name: "Ravi" },
          decidedBy: null,
        };

  const upsert = vi.fn().mockResolvedValue(rateRow ?? {
    id: "r1",
    campaignId: "c1",
    editorId: "user_1",
    amount: 0,
    status: RateStatus.PENDING,
    previousAmount: null,
    editorNote: null,
    adminNote: null,
    decidedAt: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    campaign: { title: CAMPAIGN.title },
    editor: { name: "Ravi" },
    decidedBy: null,
  });
  const update = vi.fn().mockResolvedValue(rateRow);
  const findUniqueRate = vi.fn().mockResolvedValue(rateRow);

  const prisma = {
    client: {
      campaign: {
        findUnique: vi.fn().mockResolvedValue(campaignRow),
        update: vi.fn().mockResolvedValue({ id: "c1", defaultRate: 1500 }),
      },
      user: {
        findUnique: vi.fn().mockResolvedValue({
          rateCard: options.rateCard ?? null,
          role: options.role ?? Role.EDITOR,
        }),
      },
      campaignRate: {
        findUnique: findUniqueRate,
        findMany: vi.fn().mockResolvedValue([]),
        upsert,
        update,
      },
    },
  } as unknown as PrismaService;

  return { service: new RatesService(prisma), upsert, update, findUniqueRate };
}

const editor = (id = "user_1"): AuthenticatedUser =>
  ({ id, role: Role.EDITOR }) as AuthenticatedUser;
const admin = (id = "admin_1"): AuthenticatedUser =>
  ({ id, role: Role.ADMIN }) as AuthenticatedUser;

describe("RatesService.effectiveFor", () => {
  /**
   * The rule the whole propose-approve cycle rests on: an editor asking for
   * more must not change what is owed. If a PENDING row ever paid, an editor
   * could raise their own rate by asking.
   */
  it("does not pay a PENDING proposal", async () => {
    const { service } = serviceWith({
      rateCard: 1000,
      rate: { amount: 5000, status: RateStatus.PENDING },
    });
    const result = await service.effectiveFor("user_1", "c1");
    expect(result.effective).toBe(1000);
    expect(result.source).toBe("USER_RATE_CARD");
    expect(result.pending?.amount).toBe(5000);
  });

  it("pays an APPROVED rate over everything else", async () => {
    const { service } = serviceWith({
      defaultRate: 1500,
      rateCard: 1000,
      rate: { amount: 2000, status: RateStatus.APPROVED },
    });
    const result = await service.effectiveFor("user_1", "c1");
    expect(result.effective).toBe(2000);
    expect(result.source).toBe("APPROVED_CAMPAIGN_RATE");
    // An approved rate is not "pending" — nothing is awaiting a decision.
    expect(result.pending).toBeNull();
  });

  it("falls back to the campaign default before the user's rate card", async () => {
    const { service } = serviceWith({ defaultRate: 1500, rateCard: 1000 });
    const result = await service.effectiveFor("user_1", "c1");
    expect(result.effective).toBe(1500);
    expect(result.source).toBe("CAMPAIGN_DEFAULT");
  });

  it("falls back to the user's rate card when the campaign has none", async () => {
    const { service } = serviceWith({ rateCard: 1000 });
    const result = await service.effectiveFor("user_1", "c1");
    expect(result.effective).toBe(1000);
    expect(result.source).toBe("USER_RATE_CARD");
  });

  it("reports nothing agreed rather than zero", async () => {
    // Zero is a rate someone could have agreed to; null is the absence of one.
    const { service } = serviceWith({});
    const result = await service.effectiveFor("user_1", "c1");
    expect(result.effective).toBeNull();
    expect(result.source).toBe("NONE");
  });

  it("gives an admin no rate card, as the dashboard does", async () => {
    const { service } = serviceWith({ rateCard: 9999, role: Role.ADMIN });
    const result = await service.effectiveFor("admin_1", "c1");
    expect(result.effective).toBeNull();
  });

  it("rejects a REJECTED rate, leaving the fallback in place", async () => {
    const { service } = serviceWith({
      rateCard: 1000,
      rate: { amount: 5000, status: RateStatus.REJECTED },
    });
    const result = await service.effectiveFor("user_1", "c1");
    expect(result.effective).toBe(1000);
    // A rejected ask is decided, so it is not shown as pending either.
    expect(result.pending).toBeNull();
  });
});

describe("RatesService.propose", () => {
  it("records what was paying, so the admin sees the change asked for", async () => {
    const { service, upsert } = serviceWith({ rateCard: 1000 });
    await service.propose(editor(), "c1", 2000, "Longer edits this month");
    const call = upsert.mock.calls[0]![0]!;
    expect(call.create.previousAmount).toBe(1000);
    expect(call.create.amount).toBe(2000);
    expect(call.create.status).toBe(RateStatus.PENDING);
  });

  it("clears the last decision when re-asking", async () => {
    // Otherwise a fresh ask would still carry the previous admin's note and
    // read as already decided.
    const { service, upsert } = serviceWith({ rateCard: 1000 });
    await service.propose(editor(), "c1", 2000, null);
    const update = upsert.mock.calls[0]![0]!.update;
    expect(update.status).toBe(RateStatus.PENDING);
    expect(update.adminNote).toBeNull();
    expect(update.decidedById).toBeNull();
    expect(update.decidedAt).toBeNull();
  });

  it("refuses a rate that is already in force", async () => {
    const { service } = serviceWith({ rateCard: 1000 });
    await expect(service.propose(editor(), "c1", 1000, null)).rejects.toThrow(
      /already your rate/i,
    );
  });

  it("refuses a negative rate", async () => {
    const { service } = serviceWith({ rateCard: 1000 });
    await expect(service.propose(editor(), "c1", -5, null)).rejects.toThrow(
      /between 0/i,
    );
  });

  it("rounds to paise", async () => {
    const { service, upsert } = serviceWith({ rateCard: 1000 });
    await service.propose(editor(), "c1", 1234.5678, null);
    expect(upsert.mock.calls[0]![0]!.create.amount).toBe(1234.57);
  });
});

describe("RatesService.decide", () => {
  it("refuses a non-admin", async () => {
    const { service } = serviceWith({
      rate: { amount: 2000, status: RateStatus.PENDING },
    });
    await expect(
      service.decide(editor(), "r1", true, null),
    ).rejects.toThrow(/only an admin/i);
  });

  it("refuses an admin deciding their own ask", async () => {
    // Otherwise the approval step is no barrier at all for an admin.
    const { service } = serviceWith({
      rate: { amount: 2000, status: RateStatus.PENDING, editorId: "admin_1" },
    });
    await expect(
      service.decide(admin("admin_1"), "r1", true, null),
    ).rejects.toThrow(/your own rate/i);
  });

  it("refuses to decide something already decided", async () => {
    const { service } = serviceWith({
      rate: { amount: 2000, status: RateStatus.APPROVED },
    });
    await expect(
      service.decide(admin(), "r1", true, null),
    ).rejects.toThrow(/already been decided/i);
  });

  it("stamps who decided and when", async () => {
    const { service, update } = serviceWith({
      rate: { amount: 2000, status: RateStatus.PENDING },
    });
    await service.decide(admin("admin_9"), "r1", true, "Agreed");
    const data = update.mock.calls[0]![0]!.data;
    expect(data.status).toBe(RateStatus.APPROVED);
    expect(data.decidedById).toBe("admin_9");
    expect(data.adminNote).toBe("Agreed");
    expect(data.decidedAt).toBeInstanceOf(Date);
  });

  it("records a rejection rather than deleting the ask", async () => {
    // The editor has to be able to see the answer and the reason.
    const { service, update } = serviceWith({
      rate: { amount: 5000, status: RateStatus.PENDING },
    });
    await service.decide(admin(), "r1", false, "Too high for this brief");
    expect(update.mock.calls[0]![0]!.data.status).toBe(RateStatus.REJECTED);
  });
});

describe("RatesService.setCampaignDefault", () => {
  it("refuses a non-admin", async () => {
    const { service } = serviceWith({});
    await expect(
      service.setCampaignDefault(editor(), "c1", 1500),
    ).rejects.toThrow(/only an admin/i);
  });

  it("accepts null, to clear the default", async () => {
    const { service } = serviceWith({});
    await expect(
      service.setCampaignDefault(admin(), "c1", null),
    ).resolves.toBeDefined();
  });
});
