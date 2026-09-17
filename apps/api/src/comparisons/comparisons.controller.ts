import { Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { Role } from "@repo/database";
import type { AuthenticatedUser } from "../auth/auth.types.js";
import { CurrentUser } from "../auth/decorators/current-user.decorator.js";
import { Roles } from "../auth/decorators/roles.decorator.js";
import { CampaignAccessGuard } from "../campaigns/guards/campaign-access.guard.js";
import { ComparisonsService } from "./comparisons.service.js";
import type {
  ComparisonDto,
  ComparisonSummaryDto,
} from "./comparisons.types.js";

/**
 * Duplicate detection over a campaign's submissions.
 *
 * Readable by both roles, but not equally. A result is inherently *about*
 * other editors' work — "this cut of yours matches one Priya submitted" names
 * a video the editor is not otherwise allowed to know exists — so the service
 * redacts: an editor sees the verdict on **their own** videos and nothing
 * that identifies the counterpart. An admin sees the whole matrix.
 *
 * That split is enforced server-side, in ComparisonsService.toDto, rather than
 * by hiding a panel in the browser. The history and the manual re-run stay
 * admin-only, because both are about the campaign rather than about one
 * editor's submission.
 *
 * CampaignAccessGuard sits on the class so an unknown campaign id 404s before
 * any of these touch the database.
 */
@Controller("campaigns/:campaignId/comparisons")
@UseGuards(CampaignAccessGuard)
export class ComparisonsController {
  constructor(private readonly comparisons: ComparisonsService) {}

  /**
   * GET /api/campaigns/:campaignId/comparisons — history, newest first.
   *
   * Admin-only: a list of past runs says how often the campaign has been
   * checked, which is campaign-level information an editor has no use for.
   */
  @Get()
  @Roles(Role.ADMIN)
  findAll(
    @Param("campaignId") campaignId: string,
  ): Promise<ComparisonSummaryDto[]> {
    return this.comparisons.findAll(campaignId);
  }

  /**
   * GET /api/campaigns/:campaignId/comparisons/latest — the current run, or
   * null when the campaign has never been checked.
   *
   * Declared before the :comparisonId route on purpose: Nest matches in
   * declaration order, and the parameter route would otherwise swallow
   * "latest" as an id.
   *
   * This is the endpoint the campaign page polls while a run is in flight —
   * our own database, never the engine. What comes back is scoped to the
   * caller's role; see the class comment.
   */
  @Get("latest")
  findLatest(
    @Param("campaignId") campaignId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ComparisonDto | null> {
    return this.comparisons.findLatest(campaignId, user);
  }

  /** GET /api/campaigns/:campaignId/comparisons/:comparisonId — one run. */
  @Get(":comparisonId")
  findOne(
    @Param("campaignId") campaignId: string,
    @Param("comparisonId") comparisonId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ComparisonDto> {
    return this.comparisons.findOne(campaignId, comparisonId, user);
  }

  /**
   * POST /api/campaigns/:campaignId/comparisons — re-label every submitted
   * video from scratch, in upload order.
   *
   * Uploads are classified as they land; this replays the whole campaign
   * under the current threshold, which is how a threshold change ripples
   * forward. Admin-only: it costs real engine time, and an editor cannot see
   * the full result anyway.
   *
   * Returns as soon as the run row exists, not when it finishes: a rebuild
   * takes minutes, and holding the request open for it would hit every
   * timeout between here and the browser. The caller polls `latest`.
   */
  @Post()
  @Roles(Role.ADMIN)
  run(@Param("campaignId") campaignId: string): Promise<ComparisonSummaryDto> {
    return this.comparisons.rebuild(campaignId);
  }
}
