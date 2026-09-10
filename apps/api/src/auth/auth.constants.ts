/**
 * Development OTP. Every login accepts this value and no SMS is sent.
 *
 * This is the ONLY place the stub lives: swapping in a real SMS provider means
 * generating a per-request code, persisting it with an expiry, and comparing
 * against it here — no other file needs to change.
 */
export const DEV_OTP = "1234";

/** How long an issued access token stays valid. */
export const TOKEN_TTL = "7d";
