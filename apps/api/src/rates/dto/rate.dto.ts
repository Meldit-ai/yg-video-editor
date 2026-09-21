import {
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from "class-validator";

const AMOUNT_OPTIONS = { allowNaN: false, allowInfinity: false } as const;
const NOTE_MAX = 500;

export class ProposeRateDto {
  /** Per-video rate, in rupees. */
  @IsNumber(AMOUNT_OPTIONS, { message: "amount must be a number" })
  @Min(0, { message: "amount must not be negative" })
  amount!: number;

  /** Why the editor is asking. Optional, and shown to the admin deciding. */
  @IsOptional()
  @IsString()
  @MaxLength(NOTE_MAX)
  editorNote?: string;
}

export class DecideRateDto {
  @IsBoolean()
  approve!: boolean;

  /** The admin's reason, shown to the editor either way. */
  @IsOptional()
  @IsString()
  @MaxLength(NOTE_MAX)
  adminNote?: string;
}

export class SetCampaignRateDto {
  /**
   * Send `null` to clear the campaign default, which drops every editor
   * without their own approved rate back to their User.rateCard.
   */
  @IsOptional()
  @IsNumber(AMOUNT_OPTIONS, { message: "defaultRate must be a number" })
  @Min(0, { message: "defaultRate must not be negative" })
  defaultRate?: number | null;
}
