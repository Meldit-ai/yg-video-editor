import type { TransformFnParams } from "class-transformer";

/**
 * Shared class-transformer helpers.
 *
 * These live outside any feature module because the vendor import reuses the
 * exact same normalisation the DTOs apply, and duplicating them would let the
 * two drift apart silently.
 */

/** Trims a string value, leaving non-strings untouched for the validators. */
export const trimString = ({ value }: TransformFnParams): unknown =>
  typeof value === "string" ? value.trim() : value;

/**
 * Trims a string and turns an empty result into null.
 *
 * Nullable columns are cleared by sending "" or null; both arrive here as
 * null, which @IsOptional() lets through untouched. That is what makes
 * "clear this field" expressible without a separate sentinel value, and it
 * keeps whitespace-only input from being stored as a value.
 */
export const trimStringToNull = ({ value }: TransformFnParams): unknown => {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
};

/**
 * Strips the separators people type inside phone numbers, keeping digits and
 * a leading "+". "+91 98765-43210" and "+919876543210" are the same number,
 * and the column they land in is @unique — so normalising here, before any
 * validation or lookup, is what makes POST, PATCH and bulk import agree on
 * what a duplicate is by construction rather than by convention.
 */
export const normalizePhoneNumber = ({ value }: TransformFnParams): unknown =>
  typeof value === "string" ? value.trim().replace(/[\s\-.()]/g, "") : value;
