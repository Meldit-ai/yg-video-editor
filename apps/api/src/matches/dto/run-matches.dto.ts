import { Type } from "class-transformer";
import { IsInt, IsOptional, Max, Min } from "class-validator";

/** Body of POST /api/campaigns/:campaignId/matches. */
export class RunMatchesDto {
  /**
   * How many not-yet-hashed reels to read in this run, oldest post first.
   *
   * Every reel is a download, so an unbounded first pass over a campaign of
   * thousands is a long wait. Runs are incremental — a hashed reel keeps its
   * hash — so a bounded run followed by another picks up where it stopped.
   */
  @Type(() => Number)
  @IsOptional()
  @IsInt({ message: "reelLimit must be a whole number" })
  @Min(1, { message: "Hash at least one reel" })
  @Max(5000, { message: "Hash at most 5000 reels in one run" })
  reelLimit?: number;
}
