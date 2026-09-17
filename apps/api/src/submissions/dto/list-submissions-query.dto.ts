import { Transform } from "class-transformer";
import { IsBoolean, IsIn, IsOptional } from "class-validator";
import { toBoolean } from "../../common/transforms.js";

/** Orderings the campaign feed offers. */
export const SUBMISSION_SORTS = ["original", "duplicate", "recent"] as const;

export type SubmissionSort = (typeof SUBMISSION_SORTS)[number];

/**
 * Query string of GET /api/campaigns/:campaignId/submissions.
 *
 * Every field is optional and the defaults reproduce the previous behaviour
 * exactly (newest first, nothing filtered), so existing callers are unaffected.
 * The global ValidationPipe runs with forbidNonWhitelisted, so any other
 * parameter is a 400.
 */
export class ListSubmissionsQueryDto {
  /**
   * `original` is most-original-first: lowest duplication score at the top,
   * which is what the campaign feed shows. `duplicate` is the reverse, for
   * working through the worst offenders. `recent` is the default.
   */
  @IsOptional()
  @IsIn(SUBMISSION_SORTS, {
    message: `sort must be one of: ${SUBMISSION_SORTS.join(", ")}`,
  })
  sort?: SubmissionSort;

  /** Only videos that met their campaign's accepted-duplication level. */
  @Transform(toBoolean)
  @IsOptional()
  @IsBoolean({ message: "flagged must be true or false" })
  flagged?: boolean;
}
