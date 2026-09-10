import { Module } from "@nestjs/common";
import { CampaignsModule } from "../campaigns/campaigns.module.js";
import { StorageModule } from "../storage/storage.module.js";
import { ComparisonEngineClient } from "./comparison-engine.client.js";
import { ComparisonsController } from "./comparisons.controller.js";
import { ComparisonsService } from "./comparisons.service.js";

/**
 * Duplicate detection. PrismaModule is @Global, so only the two collaborators
 * are imported: CampaignsModule for the access guard, and StorageModule for
 * the object URLs handed to the engine.
 *
 * ComparisonsService is exported because SubmissionsModule starts a run when
 * an upload lands. The dependency goes one way only — nothing here knows
 * about SubmissionsService, it reads VideoSubmission rows directly — so there
 * is no cycle to break.
 */
@Module({
  imports: [CampaignsModule, StorageModule],
  controllers: [ComparisonsController],
  providers: [ComparisonsService, ComparisonEngineClient],
  exports: [ComparisonsService],
})
export class ComparisonsModule {}
