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

  it("accepts a 200 that carries an id and no message_status", async () => {
    // This is what Meta actually returns for an ordinary successful send —
    // verified against the live API. Reading it as a silent drop made every
    // delivered text fire the fallback template too, so vendors received the
    // links and then a template telling them about the same links.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ messages: [{ id: "wamid.ok" }] }),
    );

    await expect(client.sendText("919999999999", "hi")).resolves.toEqual({
      messageId: "wamid.ok",
    });
  });

  it("refuses a message Meta says it is holding", async () => {
    // The one status that does mean "taken but not delivered".
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ messages: [{ id: "wamid.held", message_status: "held" }] }),
    );

    await expect(client.sendText("919999999999", "hi")).rejects.toBeInstanceOf(
      WhatsAppNotDeliverable,
    );
  });

  it("carries the id on the not-deliverable error, so the drop is traceable", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        messages: [{ id: "wamid.dropped", message_status: "held" }],
      }),
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

  it("names the fix for an expired token instead of repeating Meta's wording", async () => {
    // The temporary tokens Meta hands out last under 24h, so this is the
    // failure the integration hits most often, and "OAuthException" reads
    // like a bug in the send path rather than a credential that ran out.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(
        {
          error: {
            message: "Error validating access token: Session has expired",
            code: 190,
            type: "OAuthException",
          },
        },
        401,
      ),
    );

    await expect(client.sendText("919999999999", "hi")).rejects.toThrow(
      /System User token/,
    );
  });

  it("never retries an expired token, however many attempts are left", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ error: { message: "Session has expired", code: 190 } }, 401),
    );

    await expect(client.sendText("919999999999", "hi")).rejects.toMatchObject({
      retryable: false,
    });
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
