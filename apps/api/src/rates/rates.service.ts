import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { RateStatus, Role } from "@repo/database";
import type { AuthenticatedUser } from "../auth/auth.types.js";
import { PrismaService } from "../prisma/prisma.service.js";
import type { CampaignRateDto, EffectiveRate } from "./rates.types.js";

/** Rupees and paise — the same two places a rate card allows. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Rates are money: reject anything that cannot be one. */
const MAX_RATE = 1_000_000;

@Injectable()
export class RatesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * What an editor is paid per video on a campaign, and where that came from.
   *
   * Resolution order, most specific first:
   *   1. an APPROVED CampaignRate for this editor on this campaign
   *   2. the campaign's own defaultRate
   *   3. the editor's User.rateCard, which is how it worked before rates
   *   4. nothing agreed
   *
   * A PENDING proposal is deliberately absent from that list. It is returned
   * alongside so the UI can show "you asked for X", but it never pays.
   */
  async effectiveFor(
    editorId: string,
    campaignId: string,
  ): Promise<EffectiveRate> {
    const [campaign, editor, rate] = await Promise.all([
      this.prisma.client.campaign.findUnique({
        where: { id: campaignId },
        select: { id: true, title: true, defaultRate: true, active: true },
      }),
      this.prisma.client.user.findUnique({
        where: { id: editorId },
        select: { rateCard: true, role: true },
      }),
      this.prisma.client.campaignRate.findUnique({
        where: { campaignId_editorId: { campaignId, editorId } },
        include: {
          campaign: { select: { title: true } },
          editor: { select: { name: true } },
          decidedBy: { select: { name: true } },
        },
      }),
    ]);

    if (campaign === null || !campaign.active) {
      throw new NotFoundException("Campaign not found");
    }

    const pending =
      rate !== null && rate.status === RateStatus.PENDING ? toDto(rate) : null;

    if (rate !== null && rate.status === RateStatus.APPROVED) {
      return {
        campaignId,
        campaignTitle: campaign.title,
        effective: rate.amount,
        source: "APPROVED_CAMPAIGN_RATE",
        pending,
      };
    }
    if (campaign.defaultRate !== null) {
      return {
        campaignId,
        campaignTitle: campaign.title,
        effective: campaign.defaultRate,
        source: "CAMPAIGN_DEFAULT",
        pending,
      };
    }
    // Admins never carry a rate card, by the same rule the dashboard follows.
    const rateCard = editor?.role === Role.EDITOR ? (editor.rateCard ?? null) : null;
    if (rateCard !== null) {
      return {
        campaignId,
        campaignTitle: campaign.title,
        effective: rateCard,
        source: "USER_RATE_CARD",
        pending,
      };
    }
    return {
      campaignId,
      campaignTitle: campaign.title,
      effective: null,
      source: "NONE",
      pending,
    };
  }

  /**
   * An editor asks for a rate on a campaign.
   *
   * Replaces their own previous ask rather than stacking proposals, so the row
   * is always the current question an admin has to answer. `previousAmount`
   * records what was paying at the time, so the admin sees the change being
   * requested without reconstructing it.
   */
  async propose(
    user: AuthenticatedUser,
    campaignId: string,
    amount: number,
    editorNote: string | null,
  ): Promise<CampaignRateDto> {
    if (!Number.isFinite(amount) || amount < 0 || amount > MAX_RATE) {
      throw new BadRequestException(
        `Rate must be between 0 and ${MAX_RATE}.`,
      );
    }
    const rounded = round2(amount);

    // Read the current rate before writing, so previousAmount is what was
    // actually paying rather than the proposal being replaced.
    const current = await this.effectiveFor(user.id, campaignId);
    if (current.effective !== null && current.effective === rounded) {
      throw new BadRequestException(
        "That is already your rate on this campaign.",
      );
    }

    const row = await this.prisma.client.campaignRate.upsert({
      where: { campaignId_editorId: { campaignId, editorId: user.id } },
      create: {
        campaignId,
        editorId: user.id,
        amount: rounded,
        previousAmount: current.effective,
        editorNote,
        status: RateStatus.PENDING,
      },
      update: {
        amount: rounded,
        previousAmount: current.effective,
        editorNote,
        // A fresh ask is undecided again, and clears the last decision.
        status: RateStatus.PENDING,
        adminNote: null,
        decidedById: null,
        decidedAt: null,
      },
      include: {
        campaign: { select: { title: true } },
        editor: { select: { name: true } },
        decidedBy: { select: { name: true } },
      },
    });
    return toDto(row);
  }

  /** Every proposal awaiting a decision, oldest first. Admin only. */
  async pendingQueue(): Promise<CampaignRateDto[]> {
    const rows = await this.prisma.client.campaignRate.findMany({
      where: { status: RateStatus.PENDING },
      orderBy: { createdAt: "asc" },
      include: {
        campaign: { select: { title: true } },
        editor: { select: { name: true } },
        decidedBy: { select: { name: true } },
      },
    });
    return rows.map(toDto);
  }

  /** One editor's rates across every campaign they have asked about. */
  async listForEditor(editorId: string): Promise<CampaignRateDto[]> {
    const rows = await this.prisma.client.campaignRate.findMany({
      where: { editorId },
      orderBy: { updatedAt: "desc" },
      include: {
        campaign: { select: { title: true } },
        editor: { select: { name: true } },
        decidedBy: { select: { name: true } },
      },
    });
    return rows.map(toDto);
  }

  /**
   * An admin approves or rejects an ask.
   *
   * Rejecting keeps the row so the editor can see the answer and the note;
   * the previously approved rate, if any, goes on paying.
   */
  async decide(
    admin: AuthenticatedUser,
    rateId: string,
    approve: boolean,
    adminNote: string | null,
  ): Promise<CampaignRateDto> {
    if (admin.role !== Role.ADMIN) {
      throw new ForbiddenException("Only an admin can decide a rate.");
    }
    const existing = await this.prisma.client.campaignRate.findUnique({
      where: { id: rateId },
      select: { id: true, status: true, editorId: true },
    });
    if (existing === null) throw new NotFoundException("Rate not found");
    if (existing.status !== RateStatus.PENDING) {
      throw new BadRequestException("That rate has already been decided.");
    }
    // An admin approving their own ask would defeat the point of the cycle.
    if (existing.editorId === admin.id) {
      throw new ForbiddenException(
        "You cannot decide your own rate. Ask another admin.",
      );
    }

    const row = await this.prisma.client.campaignRate.update({
      where: { id: rateId },
      data: {
        status: approve ? RateStatus.APPROVED : RateStatus.REJECTED,
        adminNote,
        decidedById: admin.id,
        decidedAt: new Date(),
      },
      include: {
        campaign: { select: { title: true } },
        editor: { select: { name: true } },
        decidedBy: { select: { name: true } },
      },
    });
    return toDto(row);
  }

  /** The campaign-wide default, which applies to every editor without one. */
  async setCampaignDefault(
    admin: AuthenticatedUser,
    campaignId: string,
    amount: number | null,
  ): Promise<{ campaignId: string; defaultRate: number | null }> {
    if (admin.role !== Role.ADMIN) {
      throw new ForbiddenException("Only an admin can set a campaign rate.");
    }
    if (
      amount !== null &&
      (!Number.isFinite(amount) || amount < 0 || amount > MAX_RATE)
    ) {
      throw new BadRequestException(`Rate must be between 0 and ${MAX_RATE}.`);
    }
    const campaign = await this.prisma.client.campaign.update({
      where: { id: campaignId },
      data: { defaultRate: amount === null ? null : round2(amount) },
      select: { id: true, defaultRate: true },
    });
    return { campaignId: campaign.id, defaultRate: campaign.defaultRate };
  }
}

type RateRow = {
  id: string;
  campaignId: string;
  editorId: string;
  amount: number;
  status: RateStatus;
  previousAmount: number | null;
  editorNote: string | null;
  adminNote: string | null;
  decidedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  campaign: { title: string };
  editor: { name: string };
  decidedBy: { name: string } | null;
};

function toDto(row: RateRow): CampaignRateDto {
  return {
    id: row.id,
    campaignId: row.campaignId,
    campaignTitle: row.campaign.title,
    editorId: row.editorId,
    editorName: row.editor.name,
    amount: row.amount,
    status: row.status,
    previousAmount: row.previousAmount,
    editorNote: row.editorNote,
    adminNote: row.adminNote,
    decidedByName: row.decidedBy?.name ?? null,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
