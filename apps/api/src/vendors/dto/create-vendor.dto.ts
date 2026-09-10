import { Transform } from "class-transformer";
import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from "class-validator";
import {
  normalizePhoneNumber,
  trimString,
  trimStringToNull,
} from "../../common/transforms.js";

/**
 * Same shape as the accounts' MOBILE_PATTERN (src/users/dto/create-user.dto.ts).
 * Vendors are not accounts, but the two number formats should not diverge:
 * the same person may well appear in both tables.
 */
export const PHONE_NUMBER_PATTERN = /^\+?[0-9]{10,15}$/;
export const PHONE_NUMBER_MESSAGE =
  "phoneNumber must be 10-15 digits, optionally prefixed with +";

/**
 * Body of POST /api/vendors.
 *
 * Also the row schema for bulk import: the parser builds one of these per
 * spreadsheet row and validates it with the same options main.ts installs, so
 * a row rejected by the importer is rejected by the endpoint for the same
 * reason, with the same message.
 *
 * There is no `active` here — the column defaults to true and is only ever
 * moved through PATCH (it is a visible status toggle, not a soft-delete flag).
 */
export class CreateVendorDto {
  @Transform(trimString)
  @IsString()
  @IsNotEmpty({ message: "name must not be empty" })
  @MaxLength(120)
  name!: string;

  /**
   * Normalised before validation, so the stored value is the canonical form
   * and the @unique column can be trusted as the duplicate key.
   */
  @Transform(normalizePhoneNumber)
  @IsString()
  @Matches(PHONE_NUMBER_PATTERN, { message: PHONE_NUMBER_MESSAGE })
  phoneNumber!: string;

  @Transform(trimStringToNull)
  @IsOptional()
  @IsEmail({}, { message: "email must be a valid email address" })
  @MaxLength(254)
  email?: string | null;

  @Transform(trimStringToNull)
  @IsOptional()
  @IsString()
  @MaxLength(200)
  instagram?: string | null;

  @Transform(trimStringToNull)
  @IsOptional()
  @IsString()
  @MaxLength(200)
  twitter?: string | null;

  @Transform(trimStringToNull)
  @IsOptional()
  @IsString()
  @MaxLength(200)
  linkedin?: string | null;
}
