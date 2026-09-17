import { Type } from "class-transformer";
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from "class-validator";
import { SubmissionSource } from "@repo/database";

/** Body of POST /api/campaigns/:campaignId/reels/adopt. */
export class AdoptReelsDto {
  /**
   * Who the adopted reels are attributed to.
   *
   * A submission must belong to someone, and a reel's Instagram profile is not
   * a user of this system — so an editor is named and the creator's handle is
   * kept in the file name.
   */
  @IsString()
  editorId!: string;

  /**
   * Which workflow the adopted rows join.
   *
   * TRACKER by default, because that is what they are. EDITOR exists so the
   * editor-upload flow can be exercised against real footage without anyone
   * hand-uploading a few dozen files: adopted that way, the rows are
   * indistinguishable from hand-ins and are classified as such.
   */
  @IsOptional()
  @IsEnum(SubmissionSource, {
    message: `source must be one of: ${Object.values(SubmissionSource).join(", ")}`,
  })
  source?: SubmissionSource;

  /**
   * How many reels to take, oldest first. Every reel when omitted.
   *
   * Unlike the import, adopting copies the bytes — so this is the knob that
   * decides whether a run is a minute or half a day.
   */
  @Type(() => Number)
  @IsOptional()
  @IsInt({ message: "limit must be a whole number" })
  @Min(1, { message: "Adopt at least one reel" })
  @Max(1000, { message: "Adopt at most 1000 reels at a time" })
  limit?: number;
}
