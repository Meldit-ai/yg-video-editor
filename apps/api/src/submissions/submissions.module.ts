import { Module } from "@nestjs/common";
import { MulterModule } from "@nestjs/platform-express";
import { CampaignsModule } from "../campaigns/campaigns.module.js";
import { StorageModule } from "../storage/storage.module.js";
import { StorageService } from "../storage/storage.service.js";
import { UniquenessModule } from "../uniqueness/uniqueness.module.js";
import { UploadSizeGuard } from "./guards/upload-size.guard.js";
import { SubmissionsController } from "./submissions.controller.js";
import { SubmissionsService } from "./submissions.service.js";
import { videoUploadMulterOptions } from "./video-upload.storage.js";

/**
 * Video submissions. PrismaModule is @Global, so only the collaborators are
 * imported: CampaignsModule for the access guard (which it exports along with
 * CampaignsService, the guard's own dependency), StorageModule for the
 * bucket, and UniquenessModule to classify an upload once it has landed.
 *
 * MulterModule is registered here rather than configured on the interceptor
 * because the storage engine has a dependency (StorageService) and inline
 * interceptor options cannot be injected. Registering it in this module also
 * keeps it out of the vendors importer, which wants plain memory storage.
 */
@Module({
  imports: [
    CampaignsModule,
    UniquenessModule,
    StorageModule,
    MulterModule.registerAsync({
      imports: [StorageModule],
      inject: [StorageService],
      useFactory: (storage: StorageService) =>
        videoUploadMulterOptions(storage),
    }),
  ],
  controllers: [SubmissionsController],
  providers: [SubmissionsService, UploadSizeGuard],
})
export class SubmissionsModule {}
