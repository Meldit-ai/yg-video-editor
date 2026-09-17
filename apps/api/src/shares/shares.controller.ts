import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { Role } from "@repo/database";
import { CurrentUser } from "../auth/decorators/current-user.decorator.js";
import { Roles } from "../auth/decorators/roles.decorator.js";
import type { AuthenticatedUser } from "../auth/auth.types.js";
import { CampaignAccessGuard } from "../campaigns/guards/campaign-access.guard.js";
import { CreateShareDto } from "./dto/create-share.dto.js";
import { SharesService } from "./shares.service.js";
import type { VendorShareDto } from "./shares.types.js";

/**
 * Sharing a campaign's videos with vendors.
 *
 * Admin-only: the feed this reads from is every editor's work, which an editor
 * is never shown. CampaignAccessGuard 404s an unknown campaign before anything
 * here runs.
 */
@Controller("campaigns/:campaignId/shares")
@UseGuards(CampaignAccessGuard)
@Roles(Role.ADMIN)
export class SharesController {
  constructor(private readonly shares: SharesService) {}

  /** GET /api/campaigns/:campaignId/shares — what has been sent, newest first. */
  @Get()
  findAll(@Param("campaignId") campaignId: string): Promise<VendorShareDto[]> {
    return this.shares.findAll(campaignId);
  }

  /**
   * POST /api/campaigns/:campaignId/shares — record and send.
   *
   * Returns once every recipient has been attempted, so the dialog can show a
   * per-vendor outcome rather than a hopeful "sent". Ten messages take about
   * ten seconds; the request is short enough to await.
   */
  @Post()
  create(
    @Param("campaignId") campaignId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateShareDto,
  ): Promise<VendorShareDto> {
    return this.shares.create(campaignId, user, body);
  }
}
