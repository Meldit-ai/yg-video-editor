import { Transform } from "class-transformer";
import {
  IsBoolean,
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
import {
  PHONE_NUMBER_MESSAGE,
  PHONE_NUMBER_PATTERN,
} from "./create-vendor.dto.js";

/**
 * Body of PATCH /api/vendors/:id. Every field is optional — an omitted field
 * is left untouched. Written out by hand rather than via PartialType so the
 * per-field rules stay readable in one place.
 *
 * `active` is the visible status toggle, and PATCH is the only way to move it:
 * there is no DELETE for vendors, so deactivating and re-activating both go
 * through here. The global ValidationPipe runs with forbidNonWhitelisted, so
 * any key not declared here is a 400.
 */
export class UpdateVendorDto {
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @IsNotEmpty({ message: "name must not be empty" })
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @Transform(normalizePhoneNumber)
  @IsString()
  @Matches(PHONE_NUMBER_PATTERN, { message: PHONE_NUMBER_MESSAGE })
  phoneNumber?: string;

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

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
