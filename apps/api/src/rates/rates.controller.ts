import { Body, Controller, Get, Param, Patch, Post } from "@nestjs/common";
import { Role } from "@repo/database";
import { CurrentUser } from "../auth/decorators/current-user.decorator.js";
import { Roles } from "../auth/decorators/roles.decorator.js";
import type { AuthenticatedUser } from "../auth/auth.types.js";
import {
  DecideRateDto,
  ProposeRateDto,
  SetCampaignRateDto,
} from "./dto/rate.dto.js";
import { RatesService } from "./rates.service.js";
import type { CampaignRateDto, EffectiveRate } from "./rates.types.js";

/**
 * Per-campaign rates, on the propose-approve cycle.
 *
 * Deliberately not under UsersController, which is @Roles(ADMIN) as a whole:
 * an editor has to reach their own rates, and loosening that guard would also
 * expose role and rateCard writes.
 */
@Controller("rates")
export class RatesController {
  constructor(private readonly ratesService: RatesService) {}

  /** GET /api/rates/mine — every rate this editor has asked about. */
  @Get("mine")
  mine(@CurrentUser() user: AuthenticatedUser): Promise<CampaignRateDto[]> {
    return this.ratesService.listForEditor(user.id);
  }

  /**
   * GET /api/rates/campaigns/:campaignId/effective — what the caller earns
   * per video here, and any ask of their own still awaiting a decision.
   */
  @Get("campaigns/:campaignId/effective")
  effective(
    @Param("campaignId") campaignId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<EffectiveRate> {
    return this.ratesService.effectiveFor(user.id, campaignId);
  }

  /** POST /api/rates/campaigns/:campaignId — the editor's own ask. */
  @Post("campaigns/:campaignId")
  propose(
    @Param("campaignId") campaignId: string,
    @Body() dto: ProposeRateDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<CampaignRateDto> {
    return this.ratesService.propose(
      user,
      campaignId,
      dto.amount,
      dto.editorNote ?? null,
    );
  }

  /** GET /api/rates/pending — the admin queue. */
  @Get("pending")
  @Roles(Role.ADMIN)
  pending(): Promise<CampaignRateDto[]> {
    return this.ratesService.pendingQueue();
  }

  /** PATCH /api/rates/:rateId — approve or reject one ask. */
  @Patch(":rateId")
  @Roles(Role.ADMIN)
  decide(
    @Param("rateId") rateId: string,
    @Body() dto: DecideRateDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<CampaignRateDto> {
    return this.ratesService.decide(
      admin,
      rateId,
      dto.approve,
      dto.adminNote ?? null,
    );
  }

  /** PATCH /api/rates/campaigns/:campaignId/default — campaign-wide rate. */
  @Patch("campaigns/:campaignId/default")
  @Roles(Role.ADMIN)
  setDefault(
    @Param("campaignId") campaignId: string,
    @Body() dto: SetCampaignRateDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<{ campaignId: string; defaultRate: number | null }> {
    return this.ratesService.setCampaignDefault(
      admin,
      campaignId,
      dto.defaultRate ?? null,
    );
  }
}
