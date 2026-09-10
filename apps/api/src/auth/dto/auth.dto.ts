import { IsString, Length, Matches } from "class-validator";

/** Mobile numbers are stored and validated as strings: leading zeros and
 *  country-code prefixes are significant and would be lost as numbers. */
const MOBILE_PATTERN = /^\+?[0-9]{10,15}$/;
const MOBILE_MESSAGE = "mobile must be 10-15 digits, optionally prefixed with +";

export class RequestOtpDto {
  @IsString()
  @Matches(MOBILE_PATTERN, { message: MOBILE_MESSAGE })
  mobile!: string;
}

export class VerifyOtpDto {
  @IsString()
  @Matches(MOBILE_PATTERN, { message: MOBILE_MESSAGE })
  mobile!: string;

  @IsString()
  @Length(4, 4, { message: "otp must be 4 digits" })
  otp!: string;
}
