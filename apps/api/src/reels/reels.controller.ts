import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { Role } from "@repo/database";
import { Roles } from "../auth/decorators/roles.decorator.js";
import { CampaignAccessGuard } from "../campaigns/guards/campaign-access.guard.js";
import { AdoptReelsDto } from "./dto/adopt-reels.dto.js";
import { ReelAdoptService, type AdoptResultDto } from "./reel-adopt.service.js";
import { ReelCheckService } from "./reel-check.service.js";
import { ReelsService } from "./reels.service.js";
import type {
  CampaignReelDto,
  ReelCheckRunDto,
  ReelImportResultDto,
} from "./reels.types.js";

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
  constructor(
    private readonly reels: ReelsService,
    private readonly check: ReelCheckService,
    private readonly adopt: ReelAdoptService,
  ) {}

  /** GET /api/campaigns/:campaignId/reels — stored reels, most original first. */
  @Get()
  findAll(@Param("campaignId") campaignId: string): Promise<CampaignReelDto[]> {
    return this.reels.findAll(campaignId);
  }

  /**
   * POST /api/campaigns/:campaignId/reels/import — pull reels from the tracker.
   *
   * Takes every Instagram reel on the campaign. Unbounded on purpose: the
   * earliest reel decides who copied whom, so a window that missed it would
   * put the wrong profile at the front.
   */
  @Post("import")
  import(
    @Param("campaignId") campaignId: string,
  ): Promise<ReelImportResultDto> {
    return this.reels.importFromTracker(campaignId);
  }

  /**
   * GET .../reels/check — the most recent check, or null if none has run.
   *
   * Declared before any parameter route: Nest matches in declaration order,
   * and ":id" would otherwise swallow "check".
   */
  @Get("check")
  findLatestCheck(
    @Param("campaignId") campaignId: string,
  ): Promise<ReelCheckRunDto | null> {
    return this.check.findLatest(campaignId);
  }

  /**
   * POST .../reels/check — re-label every reel from scratch, in post order.
   *
   * Reels are classified as they are imported; this replays the whole
   * campaign under the current threshold. Returns as soon as the run exists,
   * because a first pass takes the better part of an hour. Poll
   * GET .../reels/check for progress, and GET .../reels for the labels, which
   * are written as each reel finishes.
   */
  @Post("check")
  runCheck(@Param("campaignId") campaignId: string): Promise<ReelCheckRunDto> {
    return this.check.start(campaignId);
  }

  /**
   * POST .../reels/adopt — copy imported reels in as video submissions.
   *
   * From then on a reel is an ordinary submission: it appears in the campaign
   * feed, is labelled by the same classifier as an editor's upload, and can
   * be shared with vendors. Classification starts once the copying finishes.
   */
  @Post("adopt")
  adoptReels(
    @Param("campaignId") campaignId: string,
    @Body() body: AdoptReelsDto,
  ): Promise<AdoptResultDto> {
    return this.adopt.adoptAll(
      campaignId,
      body.editorId,
      body.source,
      body.limit,
    );
  }
}
