import {
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Min,
} from "class-validator";
import { Transform } from "class-transformer";
import { Role } from "@repo/database";
import {
  IsAtMostTwoDecimalPlaces,
  MOBILE_MESSAGE,
  MOBILE_PATTERN,
  RATE_CARD_MESSAGE,
  RATE_CARD_MIN_MESSAGE,
  RATE_CARD_OPTIONS,
  ROLE_MESSAGE,
} from "./create-user.dto.js";

/** Trims surrounding whitespace so " " cannot pass @IsNotEmpty(). */
const trim = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.trim() : value,
  );

/**
 * Body of PATCH /api/users/:id. Every field is optional — an omitted field is
 * left untouched (Prisma ignores `undefined` in an update payload).
 *
 * `active` is the soft-delete flag: setting it to true is how a deleted user
 * is restored by id. The global ValidationPipe runs with
 * forbidNonWhitelisted, so any key not declared here is a 400.
 */
export class UpdateUserDto {
  @IsOptional()
  @trim()
  @IsString()
  @Matches(MOBILE_PATTERN, { message: MOBILE_MESSAGE })
  mobile?: string;

  @IsOptional()
  @trim()
  @IsString()
  @IsNotEmpty({ message: "name must not be empty" })
  name?: string;

  @IsOptional()
  @IsEnum(Role, { message: ROLE_MESSAGE })
  role?: Role;

  /**
   * Per-video rate, in rupees. Send `null` to clear it — omitting the key
   * leaves it untouched, which is what makes "no rate agreed yet" expressible
   * without a sentinel. Only valid when the effective role is EDITOR; see
   * UsersService for how a promotion to ADMIN clears it.
   */
  @IsOptional()
  @IsNumber(RATE_CARD_OPTIONS, { message: RATE_CARD_MESSAGE })
  @IsAtMostTwoDecimalPlaces({ message: RATE_CARD_MESSAGE })
  @Min(0, { message: RATE_CARD_MIN_MESSAGE })
  rateCard?: number | null;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
