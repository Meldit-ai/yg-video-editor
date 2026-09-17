import { Module } from "@nestjs/common";
import { CampaignsModule } from "../campaigns/campaigns.module.js";
import { UniquenessModule } from "../uniqueness/uniqueness.module.js";
import { ComparisonsController } from "./comparisons.controller.js";
import { ComparisonsService } from "./comparisons.service.js";

/**
 * The run history behind duplicate detection, and the admin's rebuild button.
 * PrismaModule is @Global, so only the two collaborators are imported:
 * CampaignsModule for the access guard, and UniquenessModule for the
 * classifier the rebuild goes through. The checking itself, and the engine
 * client, live over there.
 */
@Module({
  imports: [CampaignsModule, UniquenessModule],
  controllers: [ComparisonsController],
  providers: [ComparisonsService],
})
export class ComparisonsModule {}
