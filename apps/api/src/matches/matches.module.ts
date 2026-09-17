import { Module } from "@nestjs/common";
import { CampaignsModule } from "../campaigns/campaigns.module.js";
import { StorageModule } from "../storage/storage.module.js";
import { MatchesController } from "./matches.controller.js";
import { MatchesService } from "./matches.service.js";

@Module({
  // CampaignsModule for CampaignAccessGuard; StorageModule to turn a stored
  // object key into a URL the hasher can read. Prisma is global.
  imports: [CampaignsModule, StorageModule],
  controllers: [MatchesController],
  providers: [MatchesService],
  exports: [MatchesService],
})
export class MatchesModule {}
