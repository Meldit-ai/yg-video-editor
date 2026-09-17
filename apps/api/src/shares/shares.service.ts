import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { VendorShareStatus, type Prisma } from "@repo/database";
import type { AuthenticatedUser } from "../auth/auth.types.js";
import { toWhatsAppNumber } from "../common/phone.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { StorageService } from "../storage/storage.service.js";
import type { CreateShareDto } from "./dto/create-share.dto.js";
import type {
  ShareableVendorDto,
  VendorShareDto,
  VendorShareRecipientDto,
} from "./shares.types.js";
import {
  WhatsAppClient,
  WhatsAppError,
  WhatsAppNotDeliverable,
} from "./whatsapp.client.js";

/** The template used when a vendor's 24-hour window is shut. */
const TEMPLATE_NAME = process.env.WHATSAPP_TEMPLATE_NAME ?? "vendor_review_request";
const TEMPLATE_LANGUAGE = process.env.WHATSAPP_TEMPLATE_LANGUAGE ?? "en";

/**
 * Meta's "message outside the 24-hour window" codes. Hitting one is not a
 * failure — it is the signal to send the approved template instead.
 */
const OUTSIDE_WINDOW_CODES = new Set([131047, 131051, 132000, 470]);

/** Attempts before a recipient is left FAILED for a human to look at. */
const MAX_ATTEMPTS = 3;

const WITH_NAMES = {
  createdBy: { select: { name: true } },
  recipients: {
    include: { vendor: { select: { name: true } } },
    orderBy: { createdAt: "asc" },
  },
} satisfies Prisma.VendorShareInclude;

type ShareRow = Prisma.VendorShareGetPayload<{ include: typeof WITH_NAMES }>;

/**
 * Sharing a campaign's videos with vendors over WhatsApp.
 *
 * The send is a loop, because Meta has no bulk endpoint — `to` takes one number
 * per request. What makes that safe is not concurrency control (ten messages is
 * nothing) but durability: every recipient is a row, written before anything is
 * sent, so a restart mid-send leaves a record of exactly who was still owed a
 * message rather than losing it.
 */
@Injectable()
export class SharesService {
  private readonly logger = new Logger(SharesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly whatsapp: WhatsAppClient,
  ) {}

  /** Vendors an admin can pick, with unusable numbers marked rather than hidden. */
  async listShareableVendors(): Promise<ShareableVendorDto[]> {
    const vendors = await this.prisma.client.vendor.findMany({
      where: { active: true },
      select: { id: true, name: true, phoneNumber: true },
      orderBy: { name: "asc" },
    });

    // Shown disabled rather than dropped: "this vendor has a bad number" is
    // something an admin needs to see and fix, not something to hide.
    return vendors.map((vendor) => ({
      ...vendor,
      reachable: toWhatsAppNumber(vendor.phoneNumber) !== null,
    }));
  }

  /** Every share sent from a campaign, newest first. */
  async findAll(campaignId: string): Promise<VendorShareDto[]> {
    const rows = await this.prisma.client.vendorShare.findMany({
      where: { campaignId, active: true },
      include: WITH_NAMES,
      orderBy: { createdAt: "desc" },
    });
    return rows.map(toDto);
  }

  /**
   * Records a share and sends it.
   *
   * The rows are committed before the first message goes out, so the record of
   * what was attempted survives the send failing, the process restarting, or
   * WhatsApp being unreachable.
   */
  async create(
    campaignId: string,
    user: AuthenticatedUser,
    input: CreateShareDto,
  ): Promise<VendorShareDto> {
    const [campaign, submissions, vendors] = await Promise.all([
      this.prisma.client.campaign.findFirst({
        where: { id: campaignId, active: true },
        select: { title: true },
      }),
      this.prisma.client.videoSubmission.findMany({
        where: { id: { in: input.submissionIds }, campaignId, active: true },
        select: { id: true, objectKey: true, fileName: true },
      }),
      this.prisma.client.vendor.findMany({
        where: { id: { in: input.vendorIds }, active: true },
        select: { id: true, name: true, phoneNumber: true },
      }),
    ]);

    if (campaign === null) {
      throw new BadRequestException("Campaign not found");
    }
    if (submissions.length === 0) {
      throw new BadRequestException(
        "None of the selected videos are on this campaign",
      );
    }
    if (vendors.length === 0) {
      throw new BadRequestException("None of the selected vendors exist");
    }
    if (!this.whatsapp.isConfigured) {
      throw new BadRequestException(
        "WhatsApp is not configured on this server yet.",
      );
    }

    // Unsigned, so the link a vendor opens tomorrow still works — a signed URL
    // would expire in six hours, long before anyone has watched them.
    const links = submissions.map((submission) =>
      this.storage.publicObjectUrl(submission.objectKey),
    );
    const body = composeMessage(input.message, links);

    const share = await this.prisma.client.vendorShare.create({
      data: {
        campaignId,
        createdById: user.id,
        messageBody: input.message,
        submissionIds: submissions.map((submission) => submission.id),
        recipients: {
          create: vendors.map((vendor) => {
            const waNumber = toWhatsAppNumber(vendor.phoneNumber);
            return {
              vendorId: vendor.id,
              waNumber,
              // Decided up front: a vendor whose number cannot be resolved is
              // never attempted, and says so, rather than failing mid-loop.
              status:
                waNumber === null
                  ? VendorShareStatus.UNREACHABLE
                  : VendorShareStatus.PENDING,
            };
          }),
        },
      },
      include: WITH_NAMES,
    });

    await this.deliver(share.id, body, {
      campaignTitle: campaign.title,
      videoCount: submissions.length,
      firstLink: links[0] ?? "",
    });

    const updated = await this.prisma.client.vendorShare.findUniqueOrThrow({
      where: { id: share.id },
      include: WITH_NAMES,
    });
    return toDto(updated);
  }

  /**
   * Sends every recipient still owed a message.
   *
   * Sequential on purpose. Ten messages take about ten seconds and Meta allows
   * eighty a second, so there is nothing to gain from concurrency and something
   * to lose: a burst is exactly what its spam heuristics watch for.
   */
  private async deliver(
    shareId: string,
    body: string,
    context: { campaignTitle: string; videoCount: number; firstLink: string },
  ): Promise<void> {
    const pending = await this.prisma.client.vendorShareRecipient.findMany({
      where: { shareId, status: VendorShareStatus.PENDING },
      include: { vendor: { select: { name: true } } },
      orderBy: { createdAt: "asc" },
    });

    for (const recipient of pending) {
      if (recipient.waNumber === null) continue;
      await this.sendOne(recipient.id, recipient.waNumber, body, {
        ...context,
        vendorName: recipient.vendor.name,
        attempts: recipient.attempts,
      });
    }
  }

  private async sendOne(
    recipientId: string,
    waNumber: string,
    body: string,
    context: {
      campaignTitle: string;
      videoCount: number;
      firstLink: string;
      vendorName: string;
      attempts: number;
    },
  ): Promise<void> {
    let usedTemplate = false;

    try {
      let result;
      try {
        result = await this.whatsapp.sendText(waNumber, body);
      } catch (caught) {
        // The typed message only reaches a vendor who wrote to us in the last
        // 24 hours. Outside it Meta either refuses the send outright or — more
        // often — takes it and silently drops it, so both shapes mean the same
        // thing: fall back to the approved template, which always lands.
        const outsideWindow =
          caught instanceof WhatsAppNotDeliverable ||
          (caught instanceof WhatsAppError && isOutsideWindow(caught));
        if (!outsideWindow) throw caught;
        usedTemplate = true;
        result = await this.whatsapp.sendTemplate(
          waNumber,
          TEMPLATE_NAME,
          TEMPLATE_LANGUAGE,
          [
            context.vendorName,
            String(context.videoCount),
            context.campaignTitle,
            context.firstLink,
          ],
        );
      }

      await this.prisma.client.vendorShareRecipient.update({
        where: { id: recipientId },
        data: {
          status: VendorShareStatus.SENT,
          providerMessageId: result.messageId,
          usedTemplate,
          errorMessage: null,
          attempts: { increment: 1 },
          sentAt: new Date(),
        },
      });
    } catch (caught) {
      const error =
        caught instanceof WhatsAppError
          ? caught
          : new WhatsAppError(
              caught instanceof Error ? caught.message : String(caught),
              null,
              false,
            );

      const attempts = context.attempts + 1;
      // Left PENDING only while another attempt could plausibly help; anything
      // else is FAILED now, so the admin sees it rather than waiting on a retry
      // that will fail identically.
      const exhausted = !error.retryable || attempts >= MAX_ATTEMPTS;

      await this.prisma.client.vendorShareRecipient.update({
        where: { id: recipientId },
        data: {
          status: exhausted
            ? VendorShareStatus.FAILED
            : VendorShareStatus.PENDING,
          errorMessage: error.message,
          attempts,
        },
      });

      this.logger.warn(
        `WhatsApp send to ${waNumber} failed (attempt ${attempts}): ${error.message}`,
      );
    }
  }
}

/** Meta's way of saying the free-form window is shut. */
function isOutsideWindow(error: WhatsAppError): boolean {
  return error.code !== null && OUTSIDE_WINDOW_CODES.has(error.code);
}

/**
 * The typed message with the video links under it.
 *
 * Blank lines between text and links so WhatsApp renders the first as a
 * preview card rather than running it into the sentence before.
 */
export function composeMessage(
  message: string,
  links: readonly string[],
): string {
  const typed = message.trim();
  const list = links.join("\n");
  return typed.length === 0 ? list : `${typed}\n\n${list}`;
}

function toDto(row: ShareRow): VendorShareDto {
  return {
    id: row.id,
    campaignId: row.campaignId,
    createdById: row.createdById,
    createdByName: row.createdBy.name,
    messageBody: row.messageBody,
    submissionIds: row.submissionIds,
    createdAt: row.createdAt,
    recipients: row.recipients.map(
      (recipient): VendorShareRecipientDto => ({
        id: recipient.id,
        vendorId: recipient.vendorId,
        vendorName: recipient.vendor.name,
        waNumber: recipient.waNumber,
        status: recipient.status,
        usedTemplate: recipient.usedTemplate,
        errorMessage: recipient.errorMessage,
        sentAt: recipient.sentAt,
      }),
    ),
  };
}
