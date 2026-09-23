import { Controller, Get } from "@nestjs/common";
import { Role } from "@repo/database";
import { Roles } from "../auth/decorators/roles.decorator.js";
import { SharesService } from "./shares.service.js";
import type { VendorShareDto } from "./shares.types.js";

/**
 * Every share sent, across all campaigns.
 *
 * Separate from SharesController, which is nested under a campaign and carries
 * CampaignAccessGuard: this answers "what have we sent, and to whom" for an
 * admin who does not already know which campaign to look in. Reaching it
 * through a campaign was three clicks and needed the answer first.
 *
 * Admin-only for the same reason the campaign-scoped one is: it names every
 * editor's work.
 */
@Controller("shares")
@Roles(Role.ADMIN)
export class AllSharesController {
  constructor(private readonly shares: SharesService) {}

  /** GET /api/shares — every campaign's shares, newest first. */
  @Get()
  findAll(): Promise<VendorShareDto[]> {
    return this.shares.findAll();
  }
}
