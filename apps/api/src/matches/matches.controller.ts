import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { Role } from "@repo/database";
import { Roles } from "../auth/decorators/roles.decorator.js";
import { CampaignAccessGuard } from "../campaigns/guards/campaign-access.guard.js";
import { RunMatchesDto } from "./dto/run-matches.dto.js";
import { MatchesService } from "./matches.service.js";
import type { MatchGroupDto, MatchRunResultDto } from "./matches.types.js";

/**
 * Editor uploads that turn out to be the very same file as an Instagram reel
 * on the same campaign.
 *
 * Admin-only: it names creators across a whole campaign, which an editor is
 * never shown. CampaignAccessGuard 404s an unknown campaign before this runs.
 */
@Controller("campaigns/:campaignId/matches")
@UseGuards(CampaignAccessGuard)
@Roles(Role.ADMIN)
export class MatchesController {
  constructor(private readonly matches: MatchesService) {}

  /**
   * GET .../matches — what the last run found. Computes nothing.
   *
   * Grouped by edit: one cut is often posted by several accounts, and showing
   * them together is what makes the spread visible. Computes nothing — hashing
   * a campaign takes minutes, and the answer only changes when videos do.
   */
  @Get()
  findAll(
    @Param("campaignId") campaignId: string,
  ): Promise<MatchGroupDto[]> {
    return this.matches.findGroups(campaignId);
  }

  /**
   * POST .../matches — hash whatever is new, then rebuild the matches.
   *
   * `reelLimit` bounds how many reels are hashed in one run, oldest post
   * first. A campaign holds thousands and each is a download, so a first pass
   * over the oldest few hundred is usually what is wanted; runs are
   * incremental, so a later call picks up where this one stopped.
   */
  @Post()
  run(
    @Param("campaignId") campaignId: string,
    @Body() body: RunMatchesDto,
  ): Promise<MatchRunResultDto> {
    return this.matches.run(campaignId, body.reelLimit);
  }
}
