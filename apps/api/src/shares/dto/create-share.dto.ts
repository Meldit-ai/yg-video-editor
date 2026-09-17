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
 * WhatsApp's own ceiling for a text body.
 *
 * Meta truncates nothing below this — the message is rejected above it — so it
 * is the real boundary the rest of these numbers are derived from rather than
 * chosen.
 */
export const WHATSAPP_BODY_LIMIT = 4096;

/** Room a presigned object URL takes in the body, measured on live links. */
const LINK_BUDGET = 130;

/** The typed note, which shares the same body as the links. */
export const MAX_SHARE_MESSAGE = 900;

/**
 * Videos in one share.
 *
 * Derived, not picked: the links and the note have to fit inside the body
 * WhatsApp will accept, so this is whatever is left once the note has had its
 * 900 characters — about 24 links at present. Meta imposes no separate limit
 * on links; they are plain text and cost only the room they occupy.
 */
export const MAX_SHARE_MEDIA = Math.floor(
  (WHATSAPP_BODY_LIMIT - MAX_SHARE_MESSAGE) / LINK_BUDGET,
);

/**
 * Vendors in one send.
 *
 * Meta has no per-send recipient limit — the constraint is the messaging tier,
 * a rolling 24-hour budget of unique recipients, which `SharesService` checks
 * against what has actually been sent today. This is only the guard against a
 * single malformed request naming thousands of vendors, so it sits at the
 * lowest tier's daily budget rather than below it.
 */
export const MAX_SHARE_VENDORS = 250;

/** Body of POST /api/campaigns/:campaignId/shares. */
export class CreateShareDto {
  @Transform(trimString)
  @IsString()
  @MaxLength(MAX_SHARE_MESSAGE, {
    message: `Message is too long. Keep it under ${MAX_SHARE_MESSAGE} characters so the links still fit.`,
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
