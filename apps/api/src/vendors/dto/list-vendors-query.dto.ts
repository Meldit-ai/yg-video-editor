import { Transform, type TransformFnParams } from "class-transformer";
import { IsBoolean, IsOptional } from "class-validator";

/**
 * Query string of GET /api/vendors.
 *
 * The global ValidationPipe transforms but does not do implicit conversion, so
 * a query parameter arrives as the string "true" / "false" and is mapped here.
 * Anything else falls through unchanged and fails @IsBoolean with a readable
 * message rather than being coerced to a surprising value.
 */
export class ListVendorsQueryDto {
  @Transform(({ value }: TransformFnParams): unknown => {
    if (value === "true") return true;
    if (value === "false") return false;
    return value;
  })
  @IsOptional()
  @IsBoolean({ message: "active must be true or false" })
  active?: boolean;
}
