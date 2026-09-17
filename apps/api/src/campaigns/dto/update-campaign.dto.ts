import { Transform, Type } from "class-transformer";
import {
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from "class-validator";
import { CampaignStatus } from "@repo/database";
import {
  DUPLICATION_THRESHOLD_MESSAGE,
  DUPLICATION_THRESHOLD_OPTIONS,
  trimString,
  trimStringToNull,
} from "./create-campaign.dto.js";

/**
 * Body of PATCH /api/campaigns/:id — every field optional.
 *
 * Written out rather than derived with PartialType: @nestjs/mapped-types is
 * not a dependency here, and spelling the fields out keeps the update-only
 * `active` flag visible.
 *
 * Omitted fields are left untouched by the service; an explicitly null
 * nullable field is cleared. `active` (soft delete) and `status` (business
 * state) are independent: setting one never changes the other.
 */
export class UpdateCampaignDto {
  @Transform(trimString)
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: "title must not be empty" })
  title?: string;

  @Transform(trimStringToNull)
  @IsOptional()
  @IsString()
  briefText?: string | null;

  @Transform(trimStringToNull)
  @IsOptional()
  @IsString()
  guidanceNote?: string | null;

  /**
   * Id of a campaign in the external tracker, or null to unlink.
   *
   * As on create, `trackerCampaignName` is not accepted from the client: the
   * service resolves it from this id, and clearing the id clears the name too.
   */
  @Transform(trimStringToNull)
  @IsOptional()
  @IsString()
  trackerCampaignId?: string | null;

  @IsOptional()
  @IsEnum(CampaignStatus, {
    message: "status must be one of: ACTIVE, INACTIVE",
  })
  status?: CampaignStatus;

  /** Accepted duplication %. See CreateCampaignDto for why @Type is needed. */
  @Type(() => Number)
  @IsOptional()
  @IsNumber(DUPLICATION_THRESHOLD_OPTIONS, {
    message: DUPLICATION_THRESHOLD_MESSAGE,
  })
  @Min(0, { message: DUPLICATION_THRESHOLD_MESSAGE })
  @Max(100, { message: DUPLICATION_THRESHOLD_MESSAGE })
  duplicationThreshold?: number;

  /** Soft-delete flag. false hides the campaign; true restores it. */
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
