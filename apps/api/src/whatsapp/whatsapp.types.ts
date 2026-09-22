/**
 * The slice of Meta's webhook payload this app reads.
 *
 * Deliberately partial and all-optional: Meta adds fields freely and sends
 * several notification shapes down the same hook, so everything here is
 * checked at runtime rather than trusted from the type.
 */
export interface WebhookPayload {
  object?: string;
  entry?: WebhookEntry[];
}

export interface WebhookEntry {
  id?: string;
  changes?: WebhookChange[];
}

export interface WebhookChange {
  field?: string;
  value?: {
    messaging_product?: string;
    metadata?: { phone_number_id?: string };
    contacts?: { profile?: { name?: string }; wa_id?: string }[];
    messages?: InboundMessage[];
    statuses?: unknown[];
  };
}

/** One message a vendor sent us. */
export interface InboundMessage {
  id?: string;
  from?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  /** Present when the vendor used WhatsApp's reply-to, which is what ties
   *  their message back to the share we sent them. */
  context?: { id?: string; from?: string };
}

/** What one inbound message resolved to, after matching it to a share. */
export interface InboundResult {
  messageId: string;
  from: string;
  text: string;
  /** Links found in the message body. */
  links: string[];
  /** The share this was a reply to, when it could be identified. */
  shareId: string | null;
  vendorId: string | null;
  /** Videos that vendor was sent on that share. */
  submissionIds: string[];
}
