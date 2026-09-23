import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../prisma/prisma.service.js";
import { WhatsAppService } from "./whatsapp.service.js";

const SECRET = "app-secret-from-meta";
const VERIFY = "yg-os-webhook-token";

function sign(body: string, secret = SECRET): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

/**
 * A prisma double covering the three tables a reply touches: the recipient it
 * came from, the row it is stored in, and the reels it is matched against.
 */
function serviceWith(options: {
  /** Recipient found by context.id — the reply-to case. */
  byMessageId?: unknown;
  /** Recipients found by the sender's number — the bare-link case. */
  byNumber?: unknown[];
  /** Reels the tracker holds, as { id, permalink }. */
  reels?: { id: string; permalink: string | null }[];
  /** A precomputed CrossPlatformMatch for the reel, if the run found one. */
  knownMatch?: {
    submissionId: string;
    contentHash: string | null;
    frameShare: number;
  } | null;
  /** The reel's own contentHash, for the same-bytes route. */
  reelContentHash?: string | null;
  /** A sent submission with the same hash, for the same-bytes route. */
  sameFileSubmissionId?: string | null;
} = {}) {
  const recipientFindFirst = vi
    .fn()
    .mockResolvedValue(options.byMessageId ?? null);
  const recipientFindMany = vi.fn().mockResolvedValue(options.byNumber ?? []);
  const upsert = vi
    .fn()
    .mockImplementation(({ create }: { create: Record<string, unknown> }) =>
      Promise.resolve({
        id: `row_${String(create.shortcode)}`,
        shortcode: create.shortcode,
        canonicalLink: create.canonicalLink,
      }),
    );
  const replyUpdate = vi.fn().mockResolvedValue({});
  const reelFindMany = vi.fn().mockResolvedValue(options.reels ?? []);
  const crossPlatformFindFirst = vi
    .fn()
    .mockResolvedValue(options.knownMatch ?? null);

  const prisma = {
    client: {
      vendorShareRecipient: {
        findFirst: recipientFindFirst,
        findMany: recipientFindMany,
      },
      vendorReplyPost: {
        upsert,
        update: replyUpdate,
        // checkDelivery re-reads the row for the reel it was matched to.
        findUnique: vi
          .fn()
          .mockResolvedValue({ reelId: options.reels?.[0]?.id ?? null }),
      },
      campaignReel: {
        findMany: reelFindMany,
        findUnique: vi
          .fn()
          .mockResolvedValue({ contentHash: options.reelContentHash ?? null }),
      },
      crossPlatformMatch: { findFirst: crossPlatformFindFirst },
      videoSubmission: {
        findFirst: vi
          .fn()
          .mockResolvedValue(
            options.sameFileSubmissionId == null
              ? null
              : { id: options.sameFileSubmissionId },
          ),
      },
      // No fingerprints unless a test provides them.
      videoFrameSignature: { findMany: vi.fn().mockResolvedValue([]) },
    },
  } as unknown as PrismaService;
  return {
    service: new WhatsAppService(prisma),
    recipientFindFirst,
    recipientFindMany,
    upsert,
    replyUpdate,
    reelFindMany,
    crossPlatformFindFirst,
  };
}

/** A recipient row shaped as resolveShare selects it. */
const recipient = (options: {
  shareId?: string;
  vendorId?: string;
  campaignId?: string;
  submissionIds?: string[];
} = {}) => ({
  shareId: options.shareId ?? "share_1",
  vendorId: options.vendorId ?? "vendor_1",
  share: {
    campaignId: options.campaignId ?? "camp_1",
    submissionIds: options.submissionIds ?? ["sub_a", "sub_b"],
  },
});

beforeEach(() => {
  process.env.WHATSAPP_APP_SECRET = SECRET;
  process.env.WHATSAPP_VERIFY_TOKEN = VERIFY;
});
afterEach(() => {
  delete process.env.WHATSAPP_APP_SECRET;
  delete process.env.WHATSAPP_VERIFY_TOKEN;
});

describe("verifySubscription", () => {
  it("accepts Meta's handshake with the right token", () => {
    const { service } = serviceWith();
    expect(service.verifySubscription("subscribe", VERIFY)).toBe(true);
  });

  it("refuses a wrong token", () => {
    const { service } = serviceWith();
    expect(service.verifySubscription("subscribe", "guessed")).toBe(false);
  });

  it("refuses a mode other than subscribe", () => {
    const { service } = serviceWith();
    expect(service.verifySubscription("unsubscribe", VERIFY)).toBe(false);
  });

  it("refuses everything when no token is configured", () => {
    // Failing closed: an unset token must not mean "allow anyone".
    delete process.env.WHATSAPP_VERIFY_TOKEN;
    const { service } = serviceWith();
    expect(service.verifySubscription("subscribe", "")).toBe(false);
  });
});

describe("verifySignature", () => {
  const body = Buffer.from('{"object":"whatsapp_business_account"}');

  it("accepts a payload signed with the app secret", () => {
    const { service } = serviceWith();
    expect(service.verifySignature(sign(body.toString()), body)).toBe(true);
  });

  it("refuses a payload signed with the wrong secret", () => {
    // What an attacker who knows the URL but not the secret would send.
    const { service } = serviceWith();
    expect(service.verifySignature(sign(body.toString(), "wrong"), body)).toBe(
      false,
    );
  });

  it("refuses a body altered after signing", () => {
    const { service } = serviceWith();
    const signature = sign(body.toString());
    const tampered = Buffer.from('{"object":"tampered"}');
    expect(service.verifySignature(signature, tampered)).toBe(false);
  });

  it("refuses a missing signature header", () => {
    const { service } = serviceWith();
    expect(service.verifySignature(undefined, body)).toBe(false);
  });

  it("refuses when the raw body was not captured", () => {
    // Re-serialising a parsed body is not byte-identical, so a missing raw
    // body must fail rather than fall back to something that looks close.
    const { service } = serviceWith();
    expect(service.verifySignature(sign(body.toString()), undefined)).toBe(
      false,
    );
  });

  it("refuses everything when no secret is configured", () => {
    delete process.env.WHATSAPP_APP_SECRET;
    const { service } = serviceWith();
    expect(service.verifySignature(sign(body.toString()), body)).toBe(false);
  });
});

describe("handle", () => {
  const POST = "https://www.instagram.com/reel/Dc3xTdXtjgf/";

  const reply = (options: { text?: string; context?: string } = {}) => ({
    entry: [
      {
        changes: [
          {
            value: {
              messages: [
                {
                  id: "wamid.IN",
                  from: "917057498857",
                  timestamp: "1790000000",
                  type: "text",
                  text: { body: options.text ?? "Posted it " + POST },
                  ...(options.context === undefined
                    ? {}
                    : { context: { id: options.context } }),
                },
              ],
            },
          },
        ],
      },
    ],
  });

  /**
   * Case two from the brief: they tagged our message and replied with the
   * link. context.id names the exact send, so the match is not a guess.
   */
  it("maps a reply that tagged our message", async () => {
    const { service, recipientFindFirst, upsert } = serviceWith({
      byMessageId: recipient(),
    });
    const [result] = await service.handle(reply({ context: "wamid.OUT" }));

    expect(recipientFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { providerMessageId: "wamid.OUT" } }),
    );
    expect(result?.matchedBy).toBe("REPLIED_TO_MESSAGE");
    expect(result?.shareId).toBe("share_1");
    expect(result?.submissionIds).toEqual(["sub_a", "sub_b"]);
    // Stored, with the link canonicalised and the raw text kept.
    expect(upsert).toHaveBeenCalledTimes(1);
    const created = upsert.mock.calls[0]![0]!.create;
    expect(created.shortcode).toBe("Dc3xTdXtjgf");
    expect(created.canonicalLink).toBe(POST);
    expect(created.matchedBy).toBe("REPLIED_TO_MESSAGE");
  });

  /**
   * Case one from the brief: a bare link, no reply-to. Their number is all we
   * have, which is enough when they have exactly one open share.
   */
  it("maps a bare link from a vendor with one open share", async () => {
    const { service, recipientFindMany } = serviceWith({
      byNumber: [recipient()],
    });
    const [result] = await service.handle(reply({ text: POST }));

    expect(recipientFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { waNumber: "917057498857", status: "SENT" },
      }),
    );
    expect(result?.matchedBy).toBe("SENDER_NUMBER");
    expect(result?.shareId).toBe("share_1");
  });

  it("says so when the sender has several open shares", async () => {
    // Recorded as a guess rather than presented as a fact: an admin reading
    // the row needs to know how much to trust it.
    const { service } = serviceWith({
      byNumber: [recipient(), recipient({ shareId: "share_2" })],
    });
    const [result] = await service.handle(reply({ text: POST }));
    expect(result?.matchedBy).toBe("AMBIGUOUS_SENDER");
    // Newest first, so it still picks the likeliest one.
    expect(result?.shareId).toBe("share_1");
  });

  it("falls back to the number when the tagged message is unknown", async () => {
    // They replied to an older send, or one from another system.
    const { service } = serviceWith({
      byMessageId: null,
      byNumber: [recipient()],
    });
    const [result] = await service.handle(reply({ context: "wamid.STALE" }));
    expect(result?.matchedBy).toBe("SENDER_NUMBER");
  });

  it("stores a post it cannot tie to any share", async () => {
    // Losing the reply would be worse than storing it unmatched.
    const { service, upsert } = serviceWith({});
    const [result] = await service.handle(reply({ text: POST }));
    expect(result?.matchedBy).toBe("UNMATCHED");
    expect(result?.shareId).toBeNull();
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  describe("the tracker check", () => {
    it("marks a post the tracker already holds", async () => {
      const { service, replyUpdate } = serviceWith({
        byMessageId: recipient(),
        reels: [{ id: "reel_9", permalink: POST }],
      });
      const [result] = await service.handle(reply({ context: "wamid.OUT" }));
      expect(result?.posts[0]?.onTracker).toBe("FOUND");
      expect(replyUpdate.mock.calls[0]![0]!.data).toMatchObject({
        trackerPresence: "FOUND",
        reelId: "reel_9",
      });
    });

    it("matches on the shortcode, not the URL string", async () => {
      // Our own rows spell it /reels/ as well as /reel/, and the vendor's
      // share-sheet link carries a tracking token.
      const { service } = serviceWith({
        byMessageId: recipient(),
        reels: [
          {
            id: "reel_9",
            permalink: "https://www.instagram.com/reels/Dc3xTdXtjgf/",
          },
        ],
      });
      const [result] = await service.handle(
        reply({ context: "wamid.OUT", text: POST + "?igsh=tracking" }),
      );
      expect(result?.posts[0]?.onTracker).toBe("FOUND");
    });

    it("says NOT_FOUND when the tracker does not have it", async () => {
      const { service, replyUpdate } = serviceWith({
        byMessageId: recipient(),
        reels: [],
      });
      const [result] = await service.handle(reply({ context: "wamid.OUT" }));
      expect(result?.posts[0]?.onTracker).toBe("NOT_FOUND");
      expect(replyUpdate.mock.calls[0]![0]!.data).toMatchObject({
        trackerPresence: "NOT_FOUND",
        reelId: null,
      });
    });

    it("scopes the lookup to the reply's own campaign", async () => {
      // A post on another campaign is not this campaign's delivery, and
      // saying FOUND would credit a vendor with work they did not do here.
      const { service, reelFindMany } = serviceWith({
        byMessageId: recipient({ campaignId: "camp_7" }),
      });
      await service.handle(reply({ context: "wamid.OUT" }));
      expect(reelFindMany.mock.calls[0]![0]!.where).toMatchObject({
        campaignId: "camp_7",
      });
    });

    it("does not confuse a permalink that merely contains the code", async () => {
      // `contains` narrows the candidates; parsing confirms them.
      const { service } = serviceWith({
        byMessageId: recipient(),
        reels: [
          {
            id: "reel_x",
            permalink: "https://www.instagram.com/reel/ZZDc3xTdXtjgfZZ/",
          },
        ],
      });
      const [result] = await service.handle(reply({ context: "wamid.OUT" }));
      expect(result?.posts[0]?.onTracker).toBe("NOT_FOUND");
    });
  });

  /**
   * The question the loop exists to answer: they replied with a link, but is
   * it *our* video? Three routes, in descending certainty.
   */
  describe("the delivery check", () => {
    const onTracker = {
      byMessageId: recipient(),
      reels: [{ id: "reel_9", permalink: POST }],
    };

    it("trusts a match the matching run already found", async () => {
      // Nothing to recompute when a CrossPlatformMatch exists.
      const { service, replyUpdate } = serviceWith({
        ...onTracker,
        knownMatch: {
          submissionId: "sub_a",
          contentHash: "abc123",
          frameShare: 100,
        },
      });
      const [result] = await service.handle(reply({ context: "wamid.OUT" }));
      expect(result?.posts[0]?.delivery).toBe("SAME_FILE");
      expect(result?.posts[0]?.deliveredSubmissionId).toBe("sub_a");
      // The last update is the delivery one.
      expect(replyUpdate.mock.calls.at(-1)![0]!.data).toMatchObject({
        deliveryCheck: "SAME_FILE",
        deliveredSubmissionId: "sub_a",
      });
    });

    it("reads a frame-only match as the same footage, not the same file", async () => {
      // A null contentHash on the match row means it was found by frames: the
      // reel is a re-encode, so the bytes differ but the footage is ours.
      const { service } = serviceWith({
        ...onTracker,
        knownMatch: {
          submissionId: "sub_b",
          contentHash: null,
          frameShare: 100,
        },
      });
      const [result] = await service.handle(reply({ context: "wamid.OUT" }));
      expect(result?.posts[0]?.delivery).toBe("SAME_FOOTAGE");
      expect(result?.posts[0]?.deliveredFrameShare).toBe(100);
    });

    it("matches on the bytes when the reel shares a hash with a sent video", async () => {
      // The common case: the vendor reposted the file we sent, unchanged.
      const { service } = serviceWith({
        ...onTracker,
        knownMatch: null,
        reelContentHash: "deadbeef",
        sameFileSubmissionId: "sub_a",
      });
      const [result] = await service.handle(reply({ context: "wamid.OUT" }));
      expect(result?.posts[0]?.delivery).toBe("SAME_FILE");
      expect(result?.posts[0]?.deliveredSubmissionId).toBe("sub_a");
      // A file match reports no frame share: the bytes are identical, so
      // frames would add nothing.
      expect(result?.posts[0]?.deliveredFrameShare).toBeNull();
    });

    it("says NOT_FINGERPRINTED rather than DIFFERENT when it could not look", async () => {
      // "We could not compare" is a different claim from "it is not ours", and
      // a later fingerprint run can still answer it.
      const { service } = serviceWith({ ...onTracker, knownMatch: null });
      const [result] = await service.handle(reply({ context: "wamid.OUT" }));
      expect(result?.posts[0]?.delivery).toBe("NOT_FINGERPRINTED");
    });

    it("does not compare when the post is not on the tracker", async () => {
      // Nothing to compare against, so the row stays PENDING for a retry.
      const { service } = serviceWith({ byMessageId: recipient(), reels: [] });
      const [result] = await service.handle(reply({ context: "wamid.OUT" }));
      expect(result?.posts[0]?.onTracker).toBe("NOT_FOUND");
      expect(result?.posts[0]?.delivery).toBe("PENDING");
    });

    it("does not compare when the reply is tied to no share", async () => {
      // Without a share there is no list of "videos we sent", so there is
      // nothing to check the post against.
      const { service } = serviceWith({ reels: [{ id: "reel_9", permalink: POST }] });
      const [result] = await service.handle(reply({ text: POST }));
      expect(result?.matchedBy).toBe("UNMATCHED");
      expect(result?.posts[0]?.delivery).toBe("PENDING");
    });

    it("only ever compares against that vendor's own share", async () => {
      // Widening it to the campaign would credit a vendor for a cut somebody
      // else was asked to post, so the comparison is scoped to the ids on
      // their share and nothing else.
      const { service, crossPlatformFindFirst } = serviceWith({
        byMessageId: recipient({ submissionIds: ["sub_x", "sub_y"] }),
        reels: [{ id: "reel_9", permalink: POST }],
        knownMatch: null,
      });
      await service.handle(reply({ context: "wamid.OUT" }));
      expect(crossPlatformFindFirst.mock.calls[0]![0]!.where).toMatchObject({
        reelId: "reel_9",
        submissionId: { in: ["sub_x", "sub_y"] },
      });
    });
  });

  it("separates a non-post link from the posts", async () => {
    const { service, upsert } = serviceWith({ byMessageId: recipient() });
    const [result] = await service.handle(
      reply({
        context: "wamid.OUT",
        text: "see https://youtube.com/watch?v=x",
      }),
    );
    expect(result?.posts).toHaveLength(0);
    expect(result?.otherLinks).toEqual(["https://youtube.com/watch?v=x"]);
    // Nothing stored: there is no post to store.
    expect(upsert).not.toHaveBeenCalled();
  });

  it("counts one post once when the same link appears twice", async () => {
    const { service, upsert } = serviceWith({ byMessageId: recipient() });
    await service.handle(
      reply({
        context: "wamid.OUT",
        text: POST + " and again " + POST + "?igsh=x",
      }),
    );
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it("ignores a status notification, which carries no messages", async () => {
    const { service } = serviceWith();
    const results = await service.handle({
      entry: [{ changes: [{ value: { statuses: [{ id: "x" }] } }] }],
    });
    expect(results).toEqual([]);
  });

  it("survives a malformed entry rather than failing the whole batch", async () => {
    // Meta retries anything that does not answer 200, so one bad message must
    // not cause every notification in the batch to be redelivered.
    const { service } = serviceWith();
    const results = await service.handle({
      entry: [{ changes: [{ value: { messages: [{ type: "text" }] } }] }],
    });
    expect(results).toEqual([]);
  });

  it("tolerates an empty payload", async () => {
    const { service } = serviceWith();
    expect(await service.handle({})).toEqual([]);
  });
});
