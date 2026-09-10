import { IsEnum, IsOptional } from "class-validator";
import { CampaignStatus } from "@repo/database";

/**
 * Query string of GET /api/campaigns.
 *
 * Only the business `status` is filterable: soft-deleted rows (active=false)
 * are never listed, so there is deliberately no `active` query parameter.
 * The global ValidationPipe runs with forbidNonWhitelisted, so any other
 * query parameter is a 400.
 */
export class ListCampaignsQueryDto {
  @IsOptional()
  @IsEnum(CampaignStatus, {
    message: "status must be one of: ACTIVE, INACTIVE",
  })
  status?: CampaignStatus;
}
