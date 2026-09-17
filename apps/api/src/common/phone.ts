/**
 * Turning a stored vendor phone number into one WhatsApp will accept.
 *
 * `Vendor.phoneNumber` is validated as `/^\+?[0-9]{10,15}$/` — the country code
 * is OPTIONAL, and in practice most rows are bare ten-digit Indian mobiles.
 * WhatsApp needs full international digits with no "+", so the gap has to be
 * closed somewhere, and guessing wrongly means messaging a stranger who happens
 * to hold that number in another country. So: resolve what can be resolved with
 * confidence, and return null for everything else rather than inventing a
 * country code.
 */

/** Country code assumed for a bare national number. */
const DEFAULT_COUNTRY_CODE =
  (process.env.DEFAULT_COUNTRY_CODE ?? "91").replace(/\D/g, "") || "91";

/** Indian mobile numbers are ten digits and start 6-9. */
const INDIAN_MOBILE = /^[6-9][0-9]{9}$/;

export interface ResolvedPhone {
  /** Digits only, no "+", ready for WhatsApp's `to` field. */
  waNumber: string;
}

/**
 * The WhatsApp-dialable form of `stored`, or null when it cannot be resolved.
 *
 * Null is a real answer, not a failure to try: the caller shows the vendor as
 * unreachable and asks someone to fix the number, which is always better than
 * delivering a campaign's videos to whoever owns that number abroad.
 */
export function toWhatsAppNumber(stored: string | null | undefined): string | null {
  if (typeof stored !== "string") return null;

  // Separators are already stripped on write by normalizePhoneNumber, but this
  // also runs over imported rows, so do not assume it.
  const raw = stored.trim().replace(/[\s\-.()]/g, "");
  if (raw.length === 0) return null;

  if (raw.startsWith("+")) {
    // Already international: the author told us the country.
    const digits = raw.slice(1);
    return /^[0-9]{10,15}$/.test(digits) ? digits : null;
  }

  if (!/^[0-9]+$/.test(raw)) return null;

  // Trunk prefix on a national number: 08765432109 -> 8765432109.
  const national = raw.length === 11 && raw.startsWith("0") ? raw.slice(1) : raw;

  if (INDIAN_MOBILE.test(national)) {
    return `${DEFAULT_COUNTRY_CODE}${national}`;
  }

  // Already carries the default country code, e.g. 918765432109.
  if (
    national.startsWith(DEFAULT_COUNTRY_CODE) &&
    INDIAN_MOBILE.test(national.slice(DEFAULT_COUNTRY_CODE.length))
  ) {
    return national;
  }

  // 11-15 digits that are not ours to interpret: could be any country, and a
  // wrong guess reaches a real person. Let the caller flag it instead.
  return null;
}

/** Whether a stored number can be messaged at all. */
export function isWhatsAppReachable(stored: string | null | undefined): boolean {
  return toWhatsAppNumber(stored) !== null;
}
