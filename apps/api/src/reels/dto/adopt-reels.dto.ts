import { IsString } from "class-validator";

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
}
