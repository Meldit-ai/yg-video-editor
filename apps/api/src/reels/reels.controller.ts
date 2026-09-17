import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { Role } from "@repo/database";
import { Roles } from "../auth/decorators/roles.decorator.js";
import { CampaignAccessGuard } from "../campaigns/guards/campaign-access.guard.js";
import { ImportReelsDto } from "./dto/import-reels.dto.js";
import { ReelsService } from "./reels.service.js";
import type { CampaignReelDto, ReelImportResultDto } from "./reels.types.js";

/**
 * A campaign's Instagram reels, pulled from the external tracker.
 *
 * Admin-only: this is campaign-wide creator data, which an editor is never
 * shown. CampaignAccessGuard 404s an unknown campaign before anything runs.
 */
@Controller("campaigns/:campaignId/reels")
@UseGuards(CampaignAccessGuard)
@Roles(Role.ADMIN)
export class ReelsController {
  constructor(private readonly reels: ReelsService) {}

  /** GET /api/campaigns/:campaignId/reels — stored reels, most original first. */
  @Get()
  findAll(@Param("campaignId") campaignId: string): Promise<CampaignReelDto[]> {
    return this.reels.findAll(campaignId);
  }

  /**
   * POST /api/campaigns/:campaignId/reels/import — pull reels from the tracker.
   *
   * Bounded by `limit` (default 50): checking reels is quadratic, and a real
   * campaign carries over ten thousand of them.
   */
  @Post("import")
  import(
    @Param("campaignId") campaignId: string,
    @Body() body: ImportReelsDto,
  ): Promise<ReelImportResultDto> {
    return this.reels.importFromTracker(campaignId, body.limit);
  }
}
