import { Module } from "@nestjs/common";
import { CampaignsModule } from "../campaigns/campaigns.module.js";
import { StorageModule } from "../storage/storage.module.js";
import { TrackerModule } from "../tracker/tracker.module.js";
import { UniquenessModule } from "../uniqueness/uniqueness.module.js";
import { ReelAdoptService } from "./reel-adopt.service.js";
import { ReelCheckService } from "./reel-check.service.js";
import { ReelsController } from "./reels.controller.js";
import { ReelsService } from "./reels.service.js";

@Module({
  // CampaignsModule for CampaignAccessGuard; TrackerModule for the upstream
  // read — its service is a singleton, so the campaign cache is shared;
  // UniquenessModule to classify reels as they arrive and to rebuild on
  // demand; StorageModule for adopting a reel into our own bucket.
  imports: [CampaignsModule, TrackerModule, UniquenessModule, StorageModule],
  controllers: [ReelsController],
  providers: [ReelsService, ReelCheckService, ReelAdoptService],
  exports: [ReelsService, ReelCheckService],
})
export class ReelsModule {}
