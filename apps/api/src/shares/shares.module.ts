import { Module } from "@nestjs/common";
import { CampaignsModule } from "../campaigns/campaigns.module.js";
import { StorageModule } from "../storage/storage.module.js";
import { SharesController } from "./shares.controller.js";
import { SharesService } from "./shares.service.js";
import { ShareableVendorsController } from "./vendors-share.controller.js";
import { WhatsAppClient } from "./whatsapp.client.js";

@Module({
  // CampaignsModule for CampaignAccessGuard's CampaignsService dependency.
  imports: [CampaignsModule, StorageModule],
  controllers: [SharesController, ShareableVendorsController],
  providers: [SharesService, WhatsAppClient],
})
export class SharesModule {}
