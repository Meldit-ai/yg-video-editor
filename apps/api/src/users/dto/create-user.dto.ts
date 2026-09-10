import {
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Min,
  registerDecorator,
  type ValidationOptions,
} from "class-validator";
import { Transform } from "class-transformer";
import { Role } from "@repo/database";

/**
 * Mobile numbers are stored and validated as strings: leading zeros and
 * country-code prefixes are significant and would be lost as numbers.
 * Kept identical to the auth DTOs (src/auth/dto/auth.dto.ts) — a number an
 * admin can create must be a number that same user can log in with.
 */
export const MOBILE_PATTERN = /^\+?[0-9]{10,15}$/;
export const MOBILE_MESSAGE =
  "mobile must be 10-15 digits, optionally prefixed with +";

export const ROLE_MESSAGE = `role must be one of: ${Object.values(Role).join(", ")}`;

/**
 * Rate-card rules, shared by both DTOs so create and update reject the same
 * values for the same reason. Money, so two decimal places; a rate cannot be
 * negative, and NaN/Infinity would poison the Float column.
 */
export const RATE_CARD_MESSAGE =
  "rateCard must be a number with at most 2 decimal places";
export const RATE_CARD_MIN_MESSAGE = "rateCard must not be negative";
export const RATE_CARD_OPTIONS = {
  allowNaN: false,
  allowInfinity: false,
} as const;

/**
 * At most two decimal places — money, not an arbitrary float.
 *
 * Hand-rolled rather than `@IsNumber({ maxDecimalPlaces: 2 })`, which
 * class-validator 0.15 implements as `value.toString().split(".")[1].length`.
 * Any fraction small enough to stringify in exponential notation (|v| < 1e-6,
 * so 1e-7 becomes "1e-7") has no "." to split on, and the resulting TypeError
 * escapes the global ValidationPipe: a rejectable body answers 500 instead of
 * the 400 it should.
 */
export function IsAtMostTwoDecimalPlaces(options?: ValidationOptions) {
  return (object: object, propertyName: string): void => {
    registerDecorator({
      name: "isAtMostTwoDecimalPlaces",
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate(value: unknown): boolean {
          if (typeof value !== "number" || !Number.isFinite(value)) return false;
          // Compared with a tolerance, not for equality: 1750.5 * 100 is
          // 175050.00000000003, and rejecting a valid rate over float noise
          // would be worse than accepting a value 1e-9 off a whole paisa.
          return Math.abs(value * 100 - Math.round(value * 100)) < 1e-9;
        },
      },
    });
  };
}

/** Trims surrounding whitespace so " " cannot pass @IsNotEmpty(). */
const trim = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.trim() : value,
  );

/** Body of POST /api/users. */
export class CreateUserDto {
  @trim()
  @IsString()
  @Matches(MOBILE_PATTERN, { message: MOBILE_MESSAGE })
  mobile!: string;

  @trim()
  @IsString()
  @IsNotEmpty({ message: "name must not be empty" })
  name!: string;

  /** Optional; the database defaults it to EDITOR. */
  @IsOptional()
  @IsEnum(Role, { message: ROLE_MESSAGE })
  role?: Role;

  /**
   * What the editor charges per video, in rupees. Omitted or null means the
   * rate is not agreed yet. Only valid when the role resolves to EDITOR — the
   * service rejects it for an ADMIN rather than storing a value nothing reads.
   */
  @IsOptional()
  @IsNumber(RATE_CARD_OPTIONS, { message: RATE_CARD_MESSAGE })
  @IsAtMostTwoDecimalPlaces({ message: RATE_CARD_MESSAGE })
  @Min(0, { message: RATE_CARD_MIN_MESSAGE })
  rateCard?: number | null;
}
