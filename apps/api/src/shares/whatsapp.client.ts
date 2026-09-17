import { Injectable, Logger } from "@nestjs/common";

/**
 * Meta's Graph API version. Pinned rather than floating: Meta ships breaking
 * changes between versions, and a silent upgrade is not something to discover
 * in production.
 */
const GRAPH_VERSION = "v21.0";

/** Both calls are a single HTTP round trip; anything slower is hung. */
const REQUEST_TIMEOUT_MS = 20_000;

export interface WhatsAppSendResult {
  /** Meta's message id, for matching up a later status webhook. */
  messageId: string;
}

/**
 * Meta took the request but will not deliver it.
 *
 * Raised for a free-form message sent outside the 24-hour window, which Meta
 * answers with 200, a message id and no `message_status` — no error code, no
 * warning. The caller retries with an approved template.
 */
export class WhatsAppNotDeliverable extends Error {
  constructor(readonly messageId: string) {
    super(
      "WhatsApp accepted the request but will not deliver it — the 24-hour window is closed.",
    );
    this.name = "WhatsAppNotDeliverable";
  }
}

export class WhatsAppError extends Error {
  constructor(
    message: string,
    /** Meta's own numeric code, when it gave one. */
    readonly code: number | null,
    /** Whether sending the same thing again could plausibly work. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "WhatsAppError";
  }
}

/**
 * Codes worth another attempt. Everything else — a bad number, a rejected
 * template, a revoked token — fails the same way however many times it is
 * tried, and retrying only delays telling the admin.
 */
/**
 * Meta's OAuth failure: the token is expired, revoked, or for another app.
 * Deliberately absent from RETRYABLE_CODES — no number of attempts fixes a
 * credential, and retrying only delays the real report.
 */
const OAUTH_ERROR = 190;

const RETRYABLE_CODES = new Set([
  130429, // throughput reached
  131048, // spam rate limit
  131056, // pair rate limit
  133016, // temporary block
  1, // transient API error
  2, // service temporarily unavailable
  4, // application request limit
]);

/**
 * Thin client over WhatsApp Cloud API.
 *
 * Deliberately knows nothing about vendors, shares or retries — it sends one
 * message and reports what happened. The queueing, ordering and retry policy
 * live in SharesService, next to the database rows that make them durable.
 */
@Injectable()
export class WhatsAppClient {
  private readonly logger = new Logger(WhatsAppClient.name);

  /** Read per call so a token swap does not need a restart. */
  private get config(): { phoneNumberId: string; token: string } | null {
    const phoneNumberId = (process.env.WHATSAPP_PHONE_NUMBER_ID ?? "").trim();
    const token = (process.env.WHATSAPP_ACCESS_TOKEN ?? "").trim();
    if (phoneNumberId.length === 0 || token.length === 0) return null;
    return { phoneNumberId, token };
  }

  /** Whether sending is configured at all. */
  get isConfigured(): boolean {
    return this.config !== null;
  }

  /**
   * A plain text message.
   *
   * Only reaches a recipient who messaged us in the last 24 hours; outside that
   * window Meta rejects it and the caller falls back to a template.
   */
  async sendText(
    to: string,
    body: string,
  ): Promise<WhatsAppSendResult> {
    return this.post(to, {
      type: "text",
      // Renders the first link as a card, which is the point of sharing videos.
      text: { preview_url: true, body },
    });
  }

  /** An approved template, with its body variables in order. */
  async sendTemplate(
    to: string,
    templateName: string,
    languageCode: string,
    bodyParams: readonly string[],
  ): Promise<WhatsAppSendResult> {
    return this.post(to, {
      type: "template",
      template: {
        name: templateName,
        language: { code: languageCode },
        components: [
          {
            type: "body",
            parameters: bodyParams.map((text) => ({ type: "text", text })),
          },
        ],
      },
    });
  }

  private async post(
    to: string,
    payload: Record<string, unknown>,
  ): Promise<WhatsAppSendResult> {
    const config = this.config;
    if (config === null) {
      throw new WhatsAppError(
        "WhatsApp is not configured. Set WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN.",
        null,
        false,
      );
    }

    let response: Response;
    try {
      response = await fetch(
        `https://graph.facebook.com/${GRAPH_VERSION}/${config.phoneNumberId}/messages`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            to,
            ...payload,
          }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );
    } catch (caught) {
      // A hung socket or DNS failure: the message may or may not have been
      // accepted, but another attempt is the only useful response.
      const reason = caught instanceof Error ? caught.message : String(caught);
      throw new WhatsAppError(`WhatsApp request failed: ${reason}`, null, true);
    }

    const parsed: unknown = await response.json().catch(() => null);

    if (!response.ok) {
      const error = readError(parsed);
      throw new WhatsAppError(
        error.message,
        error.code,
        error.code !== null && RETRYABLE_CODES.has(error.code),
      );
    }

    const message = readMessage(parsed);
    if (message === null) {
      // A 200 with no id is not a send we can track; treat it as a failure
      // rather than recording a message nobody can follow up.
      throw new WhatsAppError(
        "WhatsApp accepted the request but returned no message id",
        null,
        true,
      );
    }
    if (!message.accepted) {
      throw new WhatsAppNotDeliverable(message.id);
    }
    return { messageId: message.id };
  }
}

function readError(payload: unknown): { message: string; code: number | null } {
  if (typeof payload !== "object" || payload === null) {
    return { message: "WhatsApp returned an unreadable error", code: null };
  }
  const { error } = payload as { error?: unknown };
  if (typeof error !== "object" || error === null) {
    return { message: "WhatsApp returned an unreadable error", code: null };
  }
  const { message, code, error_data: data } = error as {
    message?: unknown;
    code?: unknown;
    error_data?: { details?: unknown };
  };
  // `details` is usually the human-readable half; Meta's `message` alone is
  // often just the code's title.
  const details = typeof data?.details === "string" ? data.details : null;
  const text = typeof message === "string" ? message : "WhatsApp send failed";
  const numericCode = typeof code === "number" ? code : null;

  // An expired or revoked token is the one failure with a single known fix,
  // and Meta reports it as a bare OAuth error that reads like a code problem.
  // Say what to do about it instead, or the next person spends the afternoon
  // looking for a bug in the send path.
  if (numericCode === OAUTH_ERROR) {
    return {
      message: `${text} — the WhatsApp access token is expired or revoked. Replace WHATSAPP_ACCESS_TOKEN with a System User token (Business Settings > Users > System Users), which does not expire.`,
      code: numericCode,
    };
  }

  return {
    message: details === null ? text : `${text}: ${details}`,
    code: numericCode,
  };
}

function readMessage(
  payload: unknown,
): { id: string; accepted: boolean } | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { messages } = payload as { messages?: unknown };
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const first = messages[0] as { id?: unknown; message_status?: unknown };
  if (typeof first.id !== "string") return null;
  return {
    id: first.id,
    // Meta answers 200 with an id and NO `message_status` for a free-form
    // message sent outside the 24-hour window: it takes the request and drops
    // the message, without an error anywhere. Treating that as sent is how a
    // vendor silently never hears from us, so only an explicit "accepted"
    // counts as delivered to WhatsApp.
    accepted: first.message_status === "accepted",
  };
}
