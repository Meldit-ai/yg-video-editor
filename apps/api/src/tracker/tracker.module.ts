import { Module } from "@nestjs/common";
import { TrackerController } from "./tracker.controller.js";
import { TrackerService } from "./tracker.service.js";

/**
 * TrackerService is exported so CampaignsModule can resolve a tracker id to
 * its display name on write. Nest providers are singletons per module, so the
 * controller and the campaigns service share one cache.
 */
@Module({
  controllers: [TrackerController],
  providers: [TrackerService],
  exports: [TrackerService],
})
export class TrackerModule {}
