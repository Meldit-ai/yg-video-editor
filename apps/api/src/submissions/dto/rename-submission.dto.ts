import { Transform } from "class-transformer";
import { IsNotEmpty, IsString, MaxLength } from "class-validator";
import { trimString } from "../../campaigns/dto/create-campaign.dto.js";

export class RenameSubmissionDto {
  /**
   * The display name. Not the stored object key — renaming here never moves
   * the file, so existing playback URLs keep working.
   */
  @Transform(trimString)
  @IsString()
  @IsNotEmpty({ message: "fileName must not be empty" })
  @MaxLength(255)
  fileName!: string;
}
