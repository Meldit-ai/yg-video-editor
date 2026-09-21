import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { VendorShareStatus, type Prisma } from "@repo/database";
import type { AuthenticatedUser } from "../auth/auth.types.js";
import { toWhatsAppNumber } from "../common/phone.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { StorageService } from "../storage/storage.service.js";
import {
  WHATSAPP_BODY_LIMIT,
  type CreateShareDto,
} from "./dto/create-share.dto.js";
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

/**
 * Unique recipients WhatsApp accepts in a rolling 24 hours.
 *
 * Meta's messaging tier, not a number of our own: an unverified business gets
 * 250, and verification moves it to 1_000, 10_000, 100_000 and then unlimited
 * on volume and quality. Overridable because moving up a tier is something
 * Meta does to the account, and should not need a deploy here.
 */
const DAILY_RECIPIENT_LIMIT = (() => {
  const configured = Number(process.env.WHATSAPP_DAILY_RECIPIENTS ?? "");
  return Number.isInteger(configured) && configured > 0 ? configured : 250;
})();

/** The tier's window is rolling, not a calendar day. */
const DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Language codes to try, in order.
 *
 * Meta treats every translation as its own template, and reports an
 * unapproved one as "does not exist in <code>" rather than "not approved yet"
 * — so a single hard-coded code fails the moment that variant is still in
 * review while another is live. Trying both makes approval order irrelevant.
 */
const TEMPLATE_LANGUAGES = (
  process.env.WHATSAPP_TEMPLATE_LANGUAGES ?? "en_US,en"
)
  .split(",")
  .map((code) => code.trim())
  .filter((code) => code.length > 0);

/** Meta's code for "no such template in that language". */
const TEMPLATE_MISSING_CODE = 132001;

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

    // The tier is a rolling 24-hour budget of unique recipients, not a limit
    // per send, so it can only be checked against what has already gone out.
    const remaining = await this.remainingDailyRecipients(
      vendors.map((vendor) => vendor.id),
    );
    if (vendors.length > remaining) {
      throw new BadRequestException(
        remaining === 0
          ? `WhatsApp's daily limit of ${DAILY_RECIPIENT_LIMIT} recipients has been reached. Sending resumes in 24 hours.`
          : `Only ${remaining} of WhatsApp's ${DAILY_RECIPIENT_LIMIT} daily recipients are left, and this share names ${vendors.length}.`,
      );
    }

    // Unsigned, so the link a vendor opens tomorrow still works — a signed URL
    // would expire in six hours, long before anyone has watched them.
    const links = submissions.map((submission) =>
      this.storage.publicObjectUrl(submission.objectKey),
    );
    const body = composeMessage(input.message, links);

    // Measured rather than estimated: the per-video cap is derived from an
    // average link length, and a run of unusually long object keys can still
    // push a legal-looking share past what WhatsApp accepts.
    if (body.length > WHATSAPP_BODY_LIMIT) {
      throw new BadRequestException(
        `These ${submissions.length} videos and your message come to ${body.length} characters, over WhatsApp's ${WHATSAPP_BODY_LIMIT} limit. Send fewer videos or shorten the message.`,
      );
    }

    const share = await this.prisma.client.vendorShare.create({
      data: {
        campaignId,
        createdById: user.id,
        // What was actually sent, links and all, rather than only the note the
        // admin typed. A vendor replying weeks later is answering this text,
        // and the reply cannot be read against a message we did not keep.
        messageBody: body,
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
      links,
    });

    const updated = await this.prisma.client.vendorShare.findUniqueOrThrow({
      where: { id: share.id },
      include: WITH_NAMES,
    });
    return toDto(updated);
  }

  /**
   * How many new recipients WhatsApp will still accept in this rolling day.
   *
   * The tier counts *unique* recipients, so a vendor already messaged in the
   * window is free to message again — which is why the vendors in hand are
   * excluded from the count rather than simply subtracted from it.
   *
   * Counted from what we sent rather than asked of Meta: the Graph API reports
   * the tier, not the balance, and a send refused for quota is reported per
   * message once it is already too late to tell the admin up front.
   */
  private async remainingDailyRecipients(
    vendorIds: readonly string[],
  ): Promise<number> {
    const since = new Date(Date.now() - DAILY_WINDOW_MS);
    const sent = await this.prisma.client.vendorShareRecipient.findMany({
      where: {
        status: VendorShareStatus.SENT,
        sentAt: { gte: since },
        vendorId: { notIn: [...vendorIds] },
      },
      select: { vendorId: true },
      distinct: ["vendorId"],
    });
    return Math.max(0, DAILY_RECIPIENT_LIMIT - sent.length);
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
    context: {
      campaignTitle: string;
      videoCount: number;
      links: readonly string[];
    },
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

  /**
   * The template in whichever approved translation exists.
   *
   * Reports the LAST failure rather than the first: if no variant is approved
   * yet, "does not exist in en" is the useful message, not a stale error from
   * a code nobody configured.
   */
  private async sendTemplateInAnyLanguage(
    waNumber: string,
    params: readonly string[],
  ) {
    let lastError: unknown;
    for (const language of TEMPLATE_LANGUAGES) {
      try {
        return await this.whatsapp.sendTemplate(
          waNumber,
          TEMPLATE_NAME,
          language,
          params,
        );
      } catch (caught) {
        lastError = caught;
        const missing =
          caught instanceof WhatsAppError &&
          caught.code === TEMPLATE_MISSING_CODE;
        // Anything else — a bad number, a revoked token — fails the same way
        // in every language, so trying the next one only hides it.
        if (!missing) throw caught;
      }
    }
    throw lastError;
  }

  private async sendOne(
    recipientId: string,
    waNumber: string,
    body: string,
    context: {
      campaignTitle: string;
      videoCount: number;
      links: readonly string[];
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
        result = await this.sendTemplateInAnyLanguage(waNumber, [
          context.vendorName,
          String(context.videoCount),
          context.campaignTitle,
          templateLinks(context.links),
        ]);
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
 * Every link, in the one slot the approved template gives us.
 *
 * Separated by spaces rather than newlines, which is not a style choice:
 * checked against the live API, a variable carrying several links separated by
 * spaces is accepted, and the same text with a newline is refused outright
 * with `(#132018) There is an issue with the parameters in your template`.
 *
 * This is what a share of several videos used to lose. The free-form path
 * composed the whole list, but the template was handed `links[0]` alone, so a
 * vendor outside the 24-hour window received one link however many were sent
 * — and which path runs is invisible to the admin, so it read as intermittent.
 */
export function templateLinks(links: readonly string[]): string {
  return links.join(" ");
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
