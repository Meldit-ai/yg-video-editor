import { Module } from "@nestjs/common";
import { CampaignsModule } from "../campaigns/campaigns.module.js";
import { UniquenessModule } from "../uniqueness/uniqueness.module.js";
import { ComparisonsController } from "./comparisons.controller.js";
import { ComparisonsService } from "./comparisons.service.js";
import { EngineCallbackController } from "./engine-callback.controller.js";

/**
 * The run history behind duplicate detection, and the admin's rebuild button.
 * PrismaModule is @Global, so only the two collaborators are imported:
 * CampaignsModule for the access guard, and UniquenessModule for the
 * classifier the rebuild goes through. The checking itself, and the engine
 * client, live over there.
 *
 * `EngineCallbackController` lives in its own class rather than on
 * `ComparisonsController`: that one carries the `campaigns/:campaignId/…`
 * prefix and `CampaignAccessGuard`, neither of which applies to a
 * campaign-agnostic, HMAC-authenticated callback from the engine.
 * `EngineJobNotifications` it depends on is provided by UniquenessModule,
 * which this module already imports.
 */
@Module({
  imports: [CampaignsModule, UniquenessModule],
  controllers: [ComparisonsController, EngineCallbackController],
  providers: [ComparisonsService],
})
export class ComparisonsModule {}
