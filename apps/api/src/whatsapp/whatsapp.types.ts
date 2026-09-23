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
  /** Instagram post links found, canonicalised. */
  links: string[];
  /**
   * URLs that were not Instagram posts.
   *
   * Kept apart so a reply carrying only a YouTube link reads as "they sent
   * something, but not a post" rather than as an empty message.
   */
  otherLinks: string[];
  /** Each post stored, whether the tracker has it, and whether it is ours. */
  posts: {
    shortcode: string;
    canonicalLink: string;
    onTracker: "PENDING" | "FOUND" | "NOT_FOUND";
    /**
     * Whether the post carries a video that vendor was sent. SAME_FILE is the
     * same bytes, SAME_FOOTAGE the same frames, DIFFERENT compared and not
     * ours, NOT_FINGERPRINTED nothing to compare against yet.
     */
    delivery:
      | "PENDING"
      | "SAME_FILE"
      | "SAME_FOOTAGE"
      | "DIFFERENT"
      | "NOT_FINGERPRINTED";
    deliveredSubmissionId: string | null;
    deliveredFrameShare: number | null;
  }[];
  /**
   * How the reply was tied to a share. REPLIED_TO_MESSAGE is exact;
   * SENDER_NUMBER inferred from one open share; AMBIGUOUS_SENDER a guess
   * between several; UNMATCHED nothing at all.
   */
  matchedBy:
    | "REPLIED_TO_MESSAGE"
    | "SENDER_NUMBER"
    | "AMBIGUOUS_SENDER"
    | "UNMATCHED";
  /** The share this was a reply to, when it could be identified. */
  shareId: string | null;
  vendorId: string | null;
  /** Videos that vendor was sent on that share. */
  submissionIds: string[];
}
