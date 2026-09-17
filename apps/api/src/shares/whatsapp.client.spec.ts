import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WhatsAppClient,
  WhatsAppError,
  WhatsAppNotDeliverable,
} from "./whatsapp.client.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("WhatsAppClient", () => {
  let client: WhatsAppClient;

  beforeEach(() => {
    process.env.WHATSAPP_PHONE_NUMBER_ID = "123";
    process.env.WHATSAPP_ACCESS_TOKEN = "token";
    client = new WhatsAppClient();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    delete process.env.WHATSAPP_ACCESS_TOKEN;
  });

  it("returns the message id when Meta accepts the send", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        messages: [{ id: "wamid.abc", message_status: "accepted" }],
      }),
    );

    await expect(client.sendText("919999999999", "hi")).resolves.toEqual({
      messageId: "wamid.abc",
    });
  });

  it("refuses a 200 that carries an id but no message_status", async () => {
    // What Meta actually answers for a free-form message sent outside the
    // 24-hour window: it takes the request, returns an id, and drops the
    // message — no error code anywhere. Recording that as sent is how a
    // vendor silently never hears from us.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ messages: [{ id: "wamid.dropped" }] }),
    );

    await expect(client.sendText("919999999999", "hi")).rejects.toBeInstanceOf(
      WhatsAppNotDeliverable,
    );
  });

  it("carries the id on the not-deliverable error, so the drop is traceable", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ messages: [{ id: "wamid.dropped" }] }),
    );

    await expect(client.sendText("919999999999", "hi")).rejects.toMatchObject({
      messageId: "wamid.dropped",
    });
  });

  it("accepts a template send, which is not window-bound", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        messages: [{ id: "wamid.tmpl", message_status: "accepted" }],
      }),
    );

    await expect(
      client.sendTemplate("919999999999", "t", "en", ["a"]),
    ).resolves.toEqual({ messageId: "wamid.tmpl" });
  });

  it("marks a throughput error retryable and a bad number not", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { message: "rate limit", code: 130429 } }, 429),
    );
    await expect(client.sendText("919999999999", "hi")).rejects.toMatchObject({
      retryable: true,
    });

    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { message: "bad number", code: 131026 } }, 400),
    );
    await expect(client.sendText("919999999999", "hi")).rejects.toMatchObject({
      retryable: false,
    });
  });

  it("folds Meta's details into the message, which is the readable half", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(
        {
          error: {
            message: "(#131030) Recipient not in allowed list",
            code: 131030,
            error_data: { details: "Add the number and try again." },
          },
        },
        400,
      ),
    );

    await expect(client.sendText("919999999999", "hi")).rejects.toThrow(
      /Add the number and try again/,
    );
  });

  it("treats a network failure as retryable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("socket hang up"));

    await expect(client.sendText("919999999999", "hi")).rejects.toMatchObject({
      retryable: true,
    });
  });

  it("fails clearly when nothing is configured", async () => {
    delete process.env.WHATSAPP_ACCESS_TOKEN;

    await expect(client.sendText("919999999999", "hi")).rejects.toBeInstanceOf(
      WhatsAppError,
    );
    expect(client.isConfigured).toBe(false);
  });
});
