import { Transform, type TransformFnParams } from "class-transformer";
import { IsEnum, IsNotEmpty, IsOptional, IsString } from "class-validator";
import { CampaignStatus } from "@repo/database";

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
 * Body of POST /api/campaigns.
 *
 * Note there is no `active` here: `active` is the soft-delete flag and is
 * never client-settable on create (the column defaults to true). The business
 * state lives in `status`, which is a separate field entirely.
 */
export class CreateCampaignDto {
  @Transform(trimString)
  @IsString()
  @IsNotEmpty({ message: "title must not be empty" })
  title!: string;

  @Transform(trimStringToNull)
  @IsOptional()
  @IsString()
  briefText?: string | null;

  @Transform(trimStringToNull)
  @IsOptional()
  @IsString()
  guidanceNote?: string | null;

  /**
   * Id of a campaign in the external tracker.
   *
   * The matching `trackerCampaignName` is deliberately absent from this DTO:
   * the service resolves the name from this id through TrackerService, so the
   * two stored columns agree by construction. An id the tracker does not know
   * is a 400.
   */
  @Transform(trimStringToNull)
  @IsOptional()
  @IsString()
  trackerCampaignId?: string | null;

  /** Business state. Defaults to ACTIVE in the service when omitted. */
  @IsOptional()
  @IsEnum(CampaignStatus, {
    message: "status must be one of: ACTIVE, INACTIVE",
  })
  status?: CampaignStatus;
}
