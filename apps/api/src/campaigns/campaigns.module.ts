import { Module } from "@nestjs/common";
import { TrackerModule } from "../tracker/tracker.module.js";
import { UniquenessModule } from "../uniqueness/uniqueness.module.js";
import { CampaignsController } from "./campaigns.controller.js";
import { CampaignsService } from "./campaigns.service.js";
import { CampaignAccessGuard } from "./guards/campaign-access.guard.js";

// PrismaModule is @Global, so PrismaService needs no import here.
// TrackerModule is not: it is imported for TrackerService, which turns the
// client-supplied tracker id into the name stored beside it. UniquenessModule
// re-labels a campaign's videos when its threshold changes; it imports nothing
// of ours, which is what keeps this edge from closing a cycle.
//
// CampaignAccessGuard is exported rather than left to each consumer to
// register: every controller nested under campaigns/:campaignId needs it, and
// it needs CampaignsService — so importing this module is the one step that
// supplies both.
@Module({
  imports: [TrackerModule, UniquenessModule],
  controllers: [CampaignsController],
  providers: [CampaignsService, CampaignAccessGuard],
  exports: [CampaignsService, CampaignAccessGuard],
})
export class CampaignsModule {}
