import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../prisma/prisma.service.js";
import { WhatsAppService } from "./whatsapp.service.js";

const SECRET = "app-secret-from-meta";
const VERIFY = "yg-os-webhook-token";

function sign(body: string, secret = SECRET): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

function serviceWith(recipient: unknown = null) {
  const findFirst = vi.fn().mockResolvedValue(recipient);
  const prisma = {
    client: { vendorShareRecipient: { findFirst } },
  } as unknown as PrismaService;
  return { service: new WhatsAppService(prisma), findFirst };
}

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
  const reply = (context?: string) => ({
    entry: [
      {
        changes: [
          {
            value: {
              messages: [
                {
                  id: "wamid.IN",
                  from: "919876543210",
                  type: "text",
                  text: { body: "Posted it https://instagram.com/reel/abc123" },
                  ...(context === undefined ? {} : { context: { id: context } }),
                },
              ],
            },
          },
        ],
      },
    ],
  });

  it("ties a reply to the share it answers, and the videos sent", async () => {
    // context.id is the id of the message being replied to — the same id
    // stored as providerMessageId when the share went out.
    const { service, findFirst } = serviceWith({
      shareId: "share_1",
      vendorId: "vendor_1",
      share: { submissionIds: ["sub_a", "sub_b"] },
    });
    const [result] = await service.handle(reply("wamid.OUT"));
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { providerMessageId: "wamid.OUT" },
      }),
    );
    expect(result?.shareId).toBe("share_1");
    expect(result?.submissionIds).toEqual(["sub_a", "sub_b"]);
  });

  it("pulls the links out of the message", async () => {
    const { service } = serviceWith(null);
    const [result] = await service.handle(reply("wamid.OUT"));
    expect(result?.links).toEqual(["https://instagram.com/reel/abc123"]);
  });

  it("keeps a message that replies to nothing, unmatched", async () => {
    // A vendor who sends a fresh message rather than using reply-to still
    // told us something; it just cannot be tied to a share.
    const { service, findFirst } = serviceWith(null);
    const [result] = await service.handle(reply());
    expect(findFirst).not.toHaveBeenCalled();
    expect(result?.shareId).toBeNull();
    expect(result?.submissionIds).toEqual([]);
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
