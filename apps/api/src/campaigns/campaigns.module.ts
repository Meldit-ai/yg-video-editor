import { Module } from "@nestjs/common";
import { TrackerModule } from "../tracker/tracker.module.js";
import { CampaignsController } from "./campaigns.controller.js";
import { CampaignsService } from "./campaigns.service.js";
import { CampaignAccessGuard } from "./guards/campaign-access.guard.js";

// PrismaModule is @Global, so PrismaService needs no import here.
// TrackerModule is not: it is imported for TrackerService, which turns the
// client-supplied tracker id into the name stored beside it.
//
// CampaignAccessGuard is exported rather than left to each consumer to
// register: every controller nested under campaigns/:campaignId needs it, and
// it needs CampaignsService — so importing this module is the one step that
// supplies both.
@Module({
  imports: [TrackerModule],
  controllers: [CampaignsController],
  providers: [CampaignsService, CampaignAccessGuard],
  exports: [CampaignsService, CampaignAccessGuard],
})
export class CampaignsModule {}
