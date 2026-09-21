import { Transform } from "class-transformer";
import { IsNotEmpty, IsOptional, IsString, MaxLength } from "class-validator";
import { trimString } from "../../campaigns/dto/create-campaign.dto.js";

/**
 * What a user may change about their own account.
 *
 * Name only, on purpose. `mobile` is the login identifier and there is no
 * self-service recovery, so letting someone edit it here is a way to lock
 * themselves out; `role`, `rateCard` and `active` stay admin-only because
 * each is something the account holder would otherwise grant themselves.
 * Those all live on PATCH /api/users/:id, which is @Roles(ADMIN).
 */
export class UpdateProfileDto {
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @IsNotEmpty({ message: "name must not be empty" })
  @MaxLength(120)
  name?: string;
}
