import { Controller, Get } from "@nestjs/common";
import { Role } from "@repo/database";
import { Roles } from "../auth/decorators/roles.decorator.js";
import { TrackerService, type TrackerCampaign } from "./tracker.service.js";

/**
 * Read-only window onto the external campaign tracker.
 *
 * @Roles on the class matches who can edit campaigns — this list only exists
 * to populate the tracker picker on the campaign form, so editors have no use
 * for it. The globally registered JwtAuthGuard has already rejected anonymous
 * callers.
 */
@Controller("tracker")
@Roles(Role.ADMIN)
export class TrackerController {
  constructor(private readonly trackerService: TrackerService) {}

  /**
   * GET /api/tracker/campaigns — every active tracker campaign as
   * `{ id, name }`, served from a short-lived in-process cache.
   */
  @Get("campaigns")
  listCampaigns(): Promise<TrackerCampaign[]> {
    return this.trackerService.listCampaigns();
  }
}
