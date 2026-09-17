import { Module } from "@nestjs/common";
import { ComparisonEngineClient } from "../comparisons/comparison-engine.client.js";
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
 * URLs handed to the engine. The engine client is a stateless HTTP wrapper,
 * so a second instance beside ComparisonsModule's costs nothing.
 */
@Module({
  imports: [StorageModule],
  providers: [UniquenessService, SubmissionTarget, ReelTarget, ComparisonEngineClient],
  exports: [UniquenessService],
})
export class UniquenessModule {}
