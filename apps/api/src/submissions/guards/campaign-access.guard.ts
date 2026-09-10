import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { CampaignsService } from "../../campaigns/campaigns.service.js";
import type { AuthenticatedUser } from "../../auth/auth.types.js";

interface SubmissionRequest {
  user?: AuthenticatedUser;
  params?: Record<string, string>;
}

/**
 * Proves the campaign in the URL exists and is one this caller may see, before
 * the route runs.
 *
 * A guard rather than a check inside the handler, and this is the whole point:
 * guards run before interceptors, so the campaign is validated *before*
 * FileInterceptor starts streaming an upload into object storage. Doing it in
 * the handler would mean a 2 GB video is stored first and the request 404s
 * afterwards.
 *
 * It reuses CampaignsService.findOne, so the visibility rule is not restated
 * here: an editor gets a 404 for a paused or deleted campaign exactly as they
 * do when opening the campaign page.
 */
@Injectable()
export class CampaignAccessGuard implements CanActivate {
  constructor(private readonly campaigns: CampaignsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<SubmissionRequest>();

    // The global JwtAuthGuard runs first and has already attached the user;
    // this keeps the type honest rather than asserting it.
    const user = request.user;
    if (!user) throw new UnauthorizedException();

    const campaignId = request.params?.campaignId;
    if (typeof campaignId !== "string" || campaignId.length === 0) {
      throw new NotFoundException("Campaign not found");
    }

    // Throws 404 for unknown, soft-deleted, and (for editors) paused ones.
    await this.campaigns.findOne(campaignId, user);
    return true;
  }
}
