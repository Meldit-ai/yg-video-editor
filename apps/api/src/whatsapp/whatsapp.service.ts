import { createHmac, timingSafeEqual } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import {
  DeliveryCheck,
  ReplyMatch,
  TrackerPresence,
  VendorShareStatus,
} from "@repo/database";
import {
  frameShare as shareOfFrames,
  isSameFootage,
  MIN_FRAMES,
} from "../matches/matches.rules.js";
import { PrismaService } from "../prisma/prisma.service.js";
import {
  findOtherLinks,
  findPostLinks,
  objectKeyOf,
  shortcodeOf,
} from "./post-link.js";
import type {
  InboundMessage,
  InboundResult,
  WebhookPayload,
} from "./whatsapp.types.js";

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
    const posts = findPostLinks(text);
    const otherLinks = findOtherLinks(text);
    const sentAt =
      message.timestamp === undefined
        ? null
        : new Date(Number(message.timestamp) * 1000);

    const share = await this.resolveShare(from, message.context?.id ?? null);

    // Stored before anything is decided about them. The webhook's job is to
    // lose nothing: whether the tracker has the post is answered next, and a
    // tracker that is down must not cost us the vendor's reply.
    const stored: StoredReplyPost[] = [];
    for (const post of posts) {
      const row = await this.prisma.client.vendorReplyPost.upsert({
        where: {
          providerMessageId_shortcode: {
            providerMessageId: messageId,
            shortcode: post.shortcode,
          },
        },
        create: {
          providerMessageId: messageId,
          fromNumber: from,
          shortcode: post.shortcode,
          rawLink: post.raw,
          canonicalLink: post.canonical,
          messageBody: text,
          matchedBy: share.matchedBy,
          shareId: share.shareId,
          vendorId: share.vendorId,
          campaignId: share.campaignId,
          sentAt,
        },
        // A redelivered webhook is the same reply, not a second one.
        update: {
          matchedBy: share.matchedBy,
          shareId: share.shareId,
          vendorId: share.vendorId,
          campaignId: share.campaignId,
        },
        select: { id: true, shortcode: true, canonicalLink: true },
      });
      stored.push(row);
    }

    // Now the lookup, per post. Separate from the write above so a failure
    // here leaves a PENDING row rather than losing the reply.
    const checked = await Promise.all(
      stored.map(async (row) => {
        const onTracker = await this.checkTracker(
          row.id,
          row.shortcode,
          share.campaignId,
        );
        const delivery = await this.checkDelivery(
          row.id,
          onTracker,
          share.submissionIds,
        );
        return { onTracker, delivery };
      }),
    );

    const result: InboundResult = {
      messageId,
      from,
      text,
      links: posts.map((post) => post.canonical),
      otherLinks,
      posts: stored.map((row, index) => ({
        shortcode: row.shortcode,
        canonicalLink: row.canonicalLink,
        onTracker: checked[index]?.onTracker ?? "PENDING",
        delivery: checked[index]?.delivery.status ?? "PENDING",
        deliveredSubmissionId: checked[index]?.delivery.submissionId ?? null,
        deliveredFrameShare: checked[index]?.delivery.frameShare ?? null,
      })),
      matchedBy: share.matchedBy,
      shareId: share.shareId,
      vendorId: share.vendorId,
      submissionIds: share.submissionIds,
    };

    this.logger.log(
      `Reply from ${from}: ${posts.length} post link(s)` +
        (otherLinks.length > 0 ? `, ${otherLinks.length} other link(s)` : "") +
        ` · ${share.matchedBy}` +
        (share.shareId === null
          ? ""
          : ` share=${share.shareId} sent=${share.submissionIds.length}`) +
        (checked.length > 0
          ? ` · tracker: ${checked.map((one) => one.onTracker).join(", ")}` +
            ` · delivery: ${checked.map((one) => one.delivery.status).join(", ")}`
          : ""),
    );
    return result;
  }

  /**
   * Which share a reply belongs to.
   *
   * Two ways in, and they are not equally good:
   *
   *   - `context.id` names the exact message they replied to, which is the
   *     `providerMessageId` stored when the share went out. Unambiguous.
   *   - A bare link with no reply-to only carries the sender's number. That is
   *     enough when the vendor has one open share and a guess when they have
   *     several, so the two cases are recorded differently rather than being
   *     flattened into one confidence.
   *
   * Never throws: an unresolvable reply is still stored, with UNMATCHED.
   */
  private async resolveShare(
    fromNumber: string,
    repliedToMessageId: string | null,
  ): Promise<ResolvedShare> {
    const select = {
      shareId: true,
      vendorId: true,
      share: { select: { campaignId: true, submissionIds: true } },
    } as const;

    if (repliedToMessageId !== null) {
      const exact = await this.prisma.client.vendorShareRecipient.findFirst({
        where: { providerMessageId: repliedToMessageId },
        select,
      });
      if (exact !== null) {
        return {
          matchedBy: ReplyMatch.REPLIED_TO_MESSAGE,
          shareId: exact.shareId,
          vendorId: exact.vendorId,
          campaignId: exact.share.campaignId,
          submissionIds: exact.share.submissionIds,
        };
      }
      // Fall through: they tagged a message we do not recognise — an older
      // send, or one from a different system. Their number may still say.
    }

    // Newest first: a vendor replying without tagging is almost always
    // answering the most recent thing we sent them.
    const byNumber = await this.prisma.client.vendorShareRecipient.findMany({
      where: { waNumber: fromNumber, status: VendorShareStatus.SENT },
      orderBy: { sentAt: "desc" },
      take: 2,
      select,
    });

    const first = byNumber[0];
    if (first === undefined) {
      return {
        matchedBy: ReplyMatch.UNMATCHED,
        shareId: null,
        vendorId: null,
        campaignId: null,
        submissionIds: [],
      };
    }
    return {
      // Recorded as a guess when they have more than one open share, so an
      // admin reading the row knows how much to trust it.
      matchedBy:
        byNumber.length > 1
          ? ReplyMatch.AMBIGUOUS_SENDER
          : ReplyMatch.SENDER_NUMBER,
      shareId: first.shareId,
      vendorId: first.vendorId,
      campaignId: first.share.campaignId,
      submissionIds: first.share.submissionIds,
    };
  }

  /**
   * Whether the tracker already holds this post, recorded on the row.
   *
   * Matched on the shortcode rather than the permalink string: our own reel
   * rows spell it several ways (/reel/ and /reels/ both occur), and a vendor's
   * share-sheet link carries a tracking token. Only the shortcode is stable.
   *
   * Scoped to the campaign when one is known. A post that exists on another
   * campaign is not this campaign's delivery, and saying FOUND would claim a
   * vendor delivered work they did not.
   */
  private async checkTracker(
    replyPostId: string,
    shortcode: string,
    campaignId: string | null,
  ): Promise<TrackerPresence> {
    let presence: TrackerPresence = TrackerPresence.NOT_FOUND;
    let reelId: string | null = null;
    try {
      // `contains` narrows to the candidates the database can index-scan; the
      // shortcode is then confirmed by parsing, so a permalink that merely
      // contains the string somewhere else cannot match.
      const candidates = await this.prisma.client.campaignReel.findMany({
        where: {
          active: true,
          permalink: { contains: shortcode },
          ...(campaignId === null ? {} : { campaignId }),
        },
        select: { id: true, permalink: true },
        take: 20,
      });
      const hit = candidates.find(
        (reel) => shortcodeOf(reel.permalink) === shortcode,
      );
      if (hit !== undefined) {
        presence = TrackerPresence.FOUND;
        reelId = hit.id;
      }
    } catch (error) {
      this.logger.error(
        `Tracker lookup failed for ${shortcode}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      // Left PENDING rather than NOT_FOUND: "we could not look" is a different
      // claim from "it is not there", and a retry can still resolve it.
      return TrackerPresence.PENDING;
    }

    await this.prisma.client.vendorReplyPost.update({
      where: { id: replyPostId },
      data: { trackerPresence: presence, reelId, trackerCheckedAt: new Date() },
    });
    return presence;
  }

  /**
   * Whether the replied post carries one of the videos that vendor was sent.
   *
   * The question the loop exists to answer. A vendor can send any link; this
   * separates "they posted our cut" from "they posted something".
   *
   * Compared only against the videos sent on that vendor's own share. Widening
   * it to the campaign would credit a vendor for a cut somebody else was asked
   * to post.
   */
  private async checkDelivery(
    replyPostId: string,
    onTracker: TrackerPresence,
    sentSubmissionIds: readonly string[],
  ): Promise<DeliveryOutcome> {
    const unresolved: DeliveryOutcome = {
      status: DeliveryCheck.PENDING,
      submissionId: null,
      frameShare: null,
    };
    if (sentSubmissionIds.length === 0) return unresolved;

    const row = await this.prisma.client.vendorReplyPost.findUnique({
      where: { id: replyPostId },
      select: { reelId: true, shareId: true },
    });
    if (row === null) return unresolved;

    // First, the chat itself. The links we put in that conversation are stored
    // on the share, so a reel whose media URL is one of them was posted from a
    // file we handed this vendor — evidence that needs no tracker and no
    // fingerprint. Older shares recorded only the note, so this finds nothing
    // for them and the routes below still apply.
    const fromChat = await this.matchAgainstChatLinks(
      row.shareId,
      row.reelId,
      sentSubmissionIds,
    );
    const outcome =
      fromChat ??
      // Then the tracker routes, which need the post to be a reel we hold.
      (onTracker === TrackerPresence.FOUND && row.reelId !== null
        ? await this.compareReelToSent(row.reelId, sentSubmissionIds)
        : unresolved);
    await this.prisma.client.vendorReplyPost.update({
      where: { id: replyPostId },
      data: {
        deliveryCheck: outcome.status,
        deliveredSubmissionId: outcome.submissionId,
        deliveredFrameShare: outcome.frameShare,
      },
    });
    return outcome;
  }

  /**
   * Whether the reel was posted from a file we put in that chat.
   *
   * The most direct evidence there is, and it needs neither the tracker nor a
   * fingerprint: the links sent to this vendor are stored verbatim on the
   * share, so if the reel's media URL is one of them, the vendor downloaded
   * our file and posted it.
   *
   * Matched on the object key rather than the whole URL. A playback link is
   * presigned — the signature and expiry change every time one is generated —
   * so the same video yields a different URL on every send, and comparing
   * strings would never match. The key inside it is stable.
   *
   * Returns null when nothing matches, so the caller falls through to the
   * tracker routes. Shares recorded before the links were stored keep only the
   * admin's note, and find nothing here.
   */
  private async matchAgainstChatLinks(
    shareId: string | null,
    reelId: string | null,
    sentSubmissionIds: readonly string[],
  ): Promise<DeliveryOutcome | null> {
    if (shareId === null || reelId === null) return null;
    try {
      const [share, reel] = await Promise.all([
        this.prisma.client.vendorShare.findUnique({
          where: { id: shareId },
          select: { messageBody: true },
        }),
        this.prisma.client.campaignReel.findUnique({
          where: { id: reelId },
          select: { mediaUrl: true },
        }),
      ]);
      if (share === null || reel === null) return null;

      const reelKey = objectKeyOf(reel.mediaUrl);
      if (reelKey === null) return null;

      // The keys actually put in that conversation.
      const sentKeys = new Set(
        (share.messageBody.match(/https?:\/\/[^\s]+/g) ?? [])
          .map(objectKeyOf)
          .filter((key): key is string => key !== null),
      );
      if (!sentKeys.has(reelKey)) return null;

      // Which of the sent videos it was. The share's own submissions are the
      // only candidates, so a vendor cannot be credited for another's file.
      const owner = await this.prisma.client.videoSubmission.findFirst({
        where: { id: { in: [...sentSubmissionIds] }, objectKey: reelKey },
        select: { id: true },
      });
      return {
        // The same stored object, so the same bytes.
        status: DeliveryCheck.SAME_FILE,
        submissionId: owner?.id ?? null,
        frameShare: null,
      };
    } catch (error) {
      this.logger.error(
        `Chat-link match failed for share ${shareId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  /**
   * Three routes, in descending certainty; the first that answers wins.
   *
   *   1. A CrossPlatformMatch already exists for this reel — the matching run
   *      worked it out, including how. Nothing to recompute.
   *   2. The reel and a sent video share a contentHash: the very same bytes.
   *      A straight repost, which is the common case.
   *   3. Frame signatures. Every frame of the shorter video must appear in the
   *      other, per matches.rules — a rule measured on real pairs rather than
   *      tuned, where nothing below 100% was ever the same video.
   *
   * Never throws: a failed comparison leaves the row PENDING for a retry.
   */
  private async compareReelToSent(
    reelId: string,
    sentSubmissionIds: readonly string[],
  ): Promise<DeliveryOutcome> {
    try {
      const known = await this.prisma.client.crossPlatformMatch.findFirst({
        where: {
          active: true,
          reelId,
          submissionId: { in: [...sentSubmissionIds] },
        },
        select: { submissionId: true, contentHash: true, frameShare: true },
      });
      if (known !== null) {
        const byHash = known.contentHash !== null;
        return {
          status: byHash ? DeliveryCheck.SAME_FILE : DeliveryCheck.SAME_FOOTAGE,
          submissionId: known.submissionId,
          frameShare: byHash ? null : known.frameShare,
        };
      }

      const reel = await this.prisma.client.campaignReel.findUnique({
        where: { id: reelId },
        select: { contentHash: true },
      });
      if (reel?.contentHash != null) {
        const sameFile = await this.prisma.client.videoSubmission.findFirst({
          where: {
            id: { in: [...sentSubmissionIds] },
            contentHash: reel.contentHash,
          },
          select: { id: true },
        });
        if (sameFile !== null) {
          return {
            status: DeliveryCheck.SAME_FILE,
            submissionId: sameFile.id,
            frameShare: null,
          };
        }
      }

      const reelFrames = await this.prisma.client.videoFrameSignature.findMany({
        where: { reelId },
        select: { signature: true },
      });
      // Distinguished from DIFFERENT on purpose: "we could not look" is not
      // "it is not ours", and a later fingerprint run can still answer it.
      if (reelFrames.length < MIN_FRAMES) {
        return {
          status: DeliveryCheck.NOT_FINGERPRINTED,
          submissionId: null,
          frameShare: null,
        };
      }
      const reelSet = new Set(reelFrames.map((one) => one.signature));

      let best:
        | { submissionId: string; shared: number; total: number; share: number }
        | null = null;
      for (const submissionId of sentSubmissionIds) {
        const own = await this.prisma.client.videoFrameSignature.findMany({
          where: { submissionId },
          select: { signature: true },
        });
        const ownSet = new Set(own.map((one) => one.signature));
        if (ownSet.size < MIN_FRAMES) continue;

        // The shorter video's coverage is what counts: a 10-second cut inside
        // a 60-second reel shares all of its own frames, which is the finding,
        // while the reel shares only a sixth of its.
        const [shorter, longer] =
          ownSet.size <= reelSet.size ? [ownSet, reelSet] : [reelSet, ownSet];
        let shared = 0;
        for (const signature of shorter) {
          if (longer.has(signature)) shared += 1;
        }
        const share = shareOfFrames({ shared, total: shorter.size });
        if (best === null || share > best.share) {
          best = { submissionId, shared, total: shorter.size, share };
        }
      }

      if (best === null) {
        return {
          status: DeliveryCheck.NOT_FINGERPRINTED,
          submissionId: null,
          frameShare: null,
        };
      }
      // The counts, not the percentage: isSameFootage applies its own
      // MIN_FRAMES floor and needs real frame numbers to do it.
      return isSameFootage({ shared: best.shared, total: best.total })
        ? {
            status: DeliveryCheck.SAME_FOOTAGE,
            submissionId: best.submissionId,
            frameShare: best.share,
          }
        : {
            status: DeliveryCheck.DIFFERENT,
            submissionId: null,
            frameShare: best.share,
          };
    } catch (error) {
      this.logger.error(
        `Delivery check failed for reel ${reelId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return {
        status: DeliveryCheck.PENDING,
        submissionId: null,
        frameShare: null,
      };
    }
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

/** A stored reply row, as readMessage needs it back. */
interface StoredReplyPost {
  id: string;
  shortcode: string;
  canonicalLink: string;
}

/** Which share a reply belongs to, and how confidently. */
interface ResolvedShare {
  matchedBy: ReplyMatch;
  shareId: string | null;
  vendorId: string | null;
  campaignId: string | null;
  submissionIds: string[];
}

/** What the delivery comparison concluded about one replied post. */
interface DeliveryOutcome {
  status: DeliveryCheck;
  /** The video it carries, when one was identified. */
  submissionId: string | null;
  /** Share of the shorter video's frames in common. Null for a file match. */
  frameShare: number | null;
}
