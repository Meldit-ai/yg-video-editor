import { Transform } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsString,
  MaxLength,
} from "class-validator";
import { trimString } from "../../common/transforms.js";

/**
 * Links are appended to the typed message, and WhatsApp starts truncating a
 * long body well before its hard limit. Ten keeps the message readable.
 */
export const MAX_SHARE_MEDIA = 10;

/** More than this in one action is a mailing list, not a hand-off. */
export const MAX_SHARE_VENDORS = 20;

/** Body of POST /api/campaigns/:campaignId/shares. */
export class CreateShareDto {
  @Transform(trimString)
  @IsString()
  @MaxLength(900, {
    message:
      "Message is too long. Keep it under 900 characters so the links still fit.",
  })
  message!: string;

  @IsArray()
  @ArrayNotEmpty({ message: "Select at least one video to share" })
  @ArrayMaxSize(MAX_SHARE_MEDIA, {
    message: `Share at most ${MAX_SHARE_MEDIA} videos at a time`,
  })
  @IsString({ each: true })
  submissionIds!: string[];

  @IsArray()
  @ArrayNotEmpty({ message: "Select at least one vendor" })
  @ArrayMaxSize(MAX_SHARE_VENDORS, {
    message: `Send to at most ${MAX_SHARE_VENDORS} vendors at a time`,
  })
  @IsString({ each: true })
  vendorIds!: string[];
}
