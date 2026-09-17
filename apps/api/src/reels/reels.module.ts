import { Module } from "@nestjs/common";
import { CampaignsModule } from "../campaigns/campaigns.module.js";
import { TrackerModule } from "../tracker/tracker.module.js";
import { ComparisonEngineClient } from "../comparisons/comparison-engine.client.js";
import { ReelCheckService } from "./reel-check.service.js";
import { ReelsController } from "./reels.controller.js";
import { ReelsService } from "./reels.service.js";

@Module({
  // CampaignsModule for CampaignAccessGuard; TrackerModule for the upstream
  // read — its service is a singleton, so the campaign cache is shared.
  imports: [CampaignsModule, TrackerModule],
  controllers: [ReelsController],
  // The engine client is provided here rather than imported: ComparisonsModule
  // keeps it internal, and it is a stateless HTTP wrapper, so a second instance
  // costs nothing and avoids widening that module's surface.
  providers: [ReelsService, ReelCheckService, ComparisonEngineClient],
  exports: [ReelsService, ReelCheckService],
})
export class ReelsModule {}
