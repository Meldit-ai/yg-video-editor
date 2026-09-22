import { createHmac, timingSafeEqual } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service.js";
import type {
  InboundMessage,
  InboundResult,
  WebhookPayload,
} from "./whatsapp.types.js";

/** Anything that looks like a link in a vendor's reply. */
const LINK_PATTERN = /https?:\/\/[^\s<>"']+/gi;

@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger(WhatsAppService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Whether the hub challenge should be echoed back.
   *
   * Meta calls this once when the webhook is saved. The token is ours, set in
   * both places by hand, so a mismatch means the request is not from our
   * configuration — not that Meta is wrong.
   */
  verifySubscription(mode: string, token: string): boolean {
    const expected = process.env.WHATSAPP_VERIFY_TOKEN;
    if (expected === undefined || expected.length === 0) {
      this.logger.error(
        "WHATSAPP_VERIFY_TOKEN is not set, so the webhook cannot be verified",
      );
      return false;
    }
    return mode === "subscribe" && safeEqual(token, expected);
  }

  /**
   * Whether this POST really came from Meta.
   *
   * Without it the endpoint is an open door: anyone who learns the URL could
   * post fabricated vendor replies and have them matched against real shares.
   * The signature covers the exact bytes received, which is why the raw body
   * is captured in main.ts rather than re-serialised from the parsed object —
   * `JSON.stringify` of a parsed body is not byte-identical and would fail.
   *
   * Returns false when no secret is configured: refusing everything is the
   * safe failure, and the log says why.
   */
  verifySignature(header: string | undefined, raw: Buffer | undefined): boolean {
    const secret = process.env.WHATSAPP_APP_SECRET;
    if (secret === undefined || secret.length === 0) {
      this.logger.error(
        "WHATSAPP_APP_SECRET is not set, so webhook payloads cannot be trusted",
      );
      return false;
    }
    if (header === undefined || raw === undefined) return false;

    const expected =
      "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
    return safeEqual(header, expected);
  }

  /**
   * Records what a vendor sent back, matched to what they were sent.
   *
   * Never throws: Meta retries a webhook that does not answer 200, and a
   * malformed entry from one vendor must not cause every later notification
   * to be redelivered.
   */
  async handle(payload: WebhookPayload): Promise<InboundResult[]> {
    const results: InboundResult[] = [];
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        for (const message of change.value?.messages ?? []) {
          try {
            const result = await this.readMessage(message);
            if (result !== null) results.push(result);
          } catch (error) {
            this.logger.error(
              `Could not read inbound message ${message.id ?? "?"}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }
      }
    }
    return results;
  }

  /**
   * One message, tied back to the share it replies to.
   *
   * `context.id` is the id of the message being replied to — the same id we
   * stored as `providerMessageId` when the share went out. That is what makes
   * the match exact: falling back to the sender's number alone would be
   * ambiguous whenever a vendor has more than one open share.
   */
  private async readMessage(
    message: InboundMessage,
  ): Promise<InboundResult | null> {
    const messageId = message.id;
    const from = message.from;
    if (messageId === undefined || from === undefined) return null;

    const text = message.text?.body ?? "";
    const links = [...text.matchAll(LINK_PATTERN)].map((match) => match[0]);

    const repliedTo = message.context?.id ?? null;
    const recipient =
      repliedTo === null
        ? null
        : await this.prisma.client.vendorShareRecipient.findFirst({
            where: { providerMessageId: repliedTo },
            select: {
              shareId: true,
              vendorId: true,
              share: { select: { submissionIds: true } },
            },
          });

    const result: InboundResult = {
      messageId,
      from,
      text,
      links,
      shareId: recipient?.shareId ?? null,
      vendorId: recipient?.vendorId ?? null,
      submissionIds: recipient?.share.submissionIds ?? [],
    };

    this.logger.log(
      recipient === null
        ? `Reply from ${from} with ${links.length} link(s), not tied to a share`
        : `Reply from ${from} with ${links.length} link(s) on share ${recipient.shareId}, sent ${recipient.share.submissionIds.length} video(s)`,
    );
    return result;
  }
}

/** Constant-time compare that tolerates differing lengths. */
function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  // timingSafeEqual throws on a length mismatch, which would itself leak the
  // length; compare against a fixed-size digest of each side instead.
  const da = createHmac("sha256", "cmp").update(a).digest();
  const db = createHmac("sha256", "cmp").update(b).digest();
  return timingSafeEqual(da, db);
}
