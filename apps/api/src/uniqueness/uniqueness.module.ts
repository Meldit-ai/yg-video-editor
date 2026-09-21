import { Module } from "@nestjs/common";
import { ComparisonEngineClient } from "../comparisons/comparison-engine.client.js";
import { EngineJobNotifications } from "../comparisons/engine-job-notifications.js";
import { StorageModule } from "../storage/storage.module.js";
import { ReelTarget } from "./reel-target.js";
import { SubmissionTarget } from "./submission-target.js";
import { UniquenessService } from "./uniqueness.service.js";

/**
 * The uniqueness classifier — UNIQUE / PARTIAL / DUPLICATE labels for a
 * campaign's submissions and reels.
 *
 * Imported by every module that produces or withdraws a video (submissions,
 * reels) and by CampaignsModule for threshold edits. It deliberately imports
 * none of them: CampaignsModule is what ComparisonsModule and ReelsModule
 * import for the access guard, so a dependency from here back to it would
 * close a cycle. PrismaModule is @Global; StorageModule supplies the object
 * URLs handed to the engine.
 *
 * The engine client is no longer a stateless wrapper a second instance could
 * share nothing with: it now holds a reference to `EngineJobNotifications`,
 * the shared registry the engine's callback resolves against, so both are
 * provided exactly once, here, and exported for ComparisonsModule's
 * `EngineCallbackController` to inject.
 */
@Module({
  imports: [StorageModule],
  providers: [
    UniquenessService,
    SubmissionTarget,
    ReelTarget,
    ComparisonEngineClient,
    EngineJobNotifications,
  ],
  exports: [UniquenessService, EngineJobNotifications],
})
export class UniquenessModule {}
