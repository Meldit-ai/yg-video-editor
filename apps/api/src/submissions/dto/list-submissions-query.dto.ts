import { Transform } from "class-transformer";
import { IsBoolean, IsIn, IsOptional } from "class-validator";
import { SubmissionSource } from "@repo/database";
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
  @IsBoolean({ message: "flagged must be true or false" })
  @IsOptional()
  flagged?: boolean;

  /**
   * Which workflow to read: the editors' hand-ins, or the reels brought in
   * from the tracker.
   *
   * Defaults to EDITOR in the service rather than here, because "no source
   * given" has to mean the editor feed — the two are separate pipelines and a
   * blended list is never the right answer.
   */
  @IsOptional()
  @IsIn(Object.values(SubmissionSource), {
    message: `source must be one of: ${Object.values(SubmissionSource).join(", ")}`,
  })
  source?: SubmissionSource;
}
