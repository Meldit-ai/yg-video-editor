import { Module } from "@nestjs/common";
import { TrackerModule } from "../tracker/tracker.module.js";
import { CampaignsController } from "./campaigns.controller.js";
import { CampaignsService } from "./campaigns.service.js";

// PrismaModule is @Global, so PrismaService needs no import here.
// TrackerModule is not: it is imported for TrackerService, which turns the
// client-supplied tracker id into the name stored beside it.
@Module({
  imports: [TrackerModule],
  controllers: [CampaignsController],
  providers: [CampaignsService],
  exports: [CampaignsService],
})
export class CampaignsModule {}
