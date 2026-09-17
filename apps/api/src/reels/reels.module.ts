import { Module } from "@nestjs/common";
import { CampaignsModule } from "../campaigns/campaigns.module.js";
import { TrackerModule } from "../tracker/tracker.module.js";
import { ReelsController } from "./reels.controller.js";
import { ReelsService } from "./reels.service.js";

@Module({
  // CampaignsModule for CampaignAccessGuard; TrackerModule for the upstream
  // read — its service is a singleton, so the campaign cache is shared.
  imports: [CampaignsModule, TrackerModule],
  controllers: [ReelsController],
  providers: [ReelsService],
  exports: [ReelsService],
})
export class ReelsModule {}
