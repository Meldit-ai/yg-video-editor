import { Type } from "class-transformer";
import { IsInt, IsOptional, Max, Min } from "class-validator";

/**
 * How many reels one import takes.
 *
 * Deliberately small by default. Checking reels is quadratic — 50 reels is
 * 1,225 pairs, 300 is 44,850, and a real campaign carries over ten thousand
 * posts, which is weeks of processing. Starting at 50 keeps a first run to
 * about half an hour; raise it per request once the results look right.
 */
export const DEFAULT_REEL_LIMIT = 50;

/** Above this a single run stops being something anyone waits for. */
export const MAX_REEL_LIMIT = 500;

/** Body of POST /api/campaigns/:campaignId/reels/import. */
export class ImportReelsDto {
  @Type(() => Number)
  @IsOptional()
  @IsInt({ message: "limit must be a whole number" })
  @Min(2, { message: "Import at least 2 reels — one alone has nothing to compare against" })
  @Max(MAX_REEL_LIMIT, {
    message: `Import at most ${MAX_REEL_LIMIT} reels at a time`,
  })
  limit?: number;
}
