import { Transform } from "class-transformer";
import { IsInt, IsOptional, Max, Min } from "class-validator";

/**
 * The most rows one request may ask for.
 *
 * A page is signed and serialised per row, and the point of paging is to keep
 * a response small — an unbounded `take` would hand that decision to the
 * caller and undo it.
 */
export const MAX_PAGE_SIZE = 100;

/**
 * A page of a list, and enough to ask for the next one.
 *
 * `total` counts every row matching the filter, not just this page: a list
 * says "24 of 97" before it has loaded 97, and a caller decides whether an
 * action is available from the whole campaign rather than from what has been
 * scrolled to.
 */
export interface Page<T> {
  items: T[];
  total: number;
  /** `skip` for the next request, or null when this page is the last. */
  nextSkip: number | null;
}

/**
 * `take`/`skip` for a list route.
 *
 * Both are optional and omitting them returns the whole list, which is what
 * every caller did before paging existed — a page is asked for, never imposed.
 *
 * Offset rather than a cursor, deliberately. A cursor's advantage is a list
 * that shifts under the reader, and it only holds when the ordering is stable;
 * these rows are ordered by a duplication label that a background check
 * rewrites minutes after a video arrives, so a cursor would be no more
 * truthful here than an offset. What makes the difference is that the
 * ordering ends in a unique key (see `withTiebreak`), so a row cannot sit in
 * two pages of one unchanged list, and that the client drops a row it already
 * holds when the list does shift.
 */
export class PageQueryDto {
  /** Rows to return. Omitted means all of them. */
  @IsOptional()
  @Transform(toInteger)
  @IsInt({ message: "take must be a whole number" })
  @Min(1, { message: "take must be at least 1" })
  @Max(MAX_PAGE_SIZE, { message: `take must be at most ${MAX_PAGE_SIZE}` })
  take?: number;

  /** Rows to skip before this page. Omitted means none. */
  @IsOptional()
  @Transform(toInteger)
  @IsInt({ message: "skip must be a whole number" })
  @Min(0, { message: "skip must be 0 or more" })
  skip?: number;
}

/**
 * Parses a query-string number.
 *
 * Left as-is when it is not one, so the validator reports it rather than this
 * silently turning "abc" into NaN and the query into an unbounded read.
 */
function toInteger({ value }: { value: unknown }): unknown {
  if (typeof value !== "string" || value.trim() === "") return value;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : value;
}

/** Wraps rows and their unfiltered count as a page. */
export function pageOf<T>(
  items: T[],
  total: number,
  query: PageQueryDto,
): Page<T> {
  const skip = query.skip ?? 0;
  const reachedEnd = query.take === undefined || skip + items.length >= total;
  return { items, total, nextSkip: reachedEnd ? null : skip + items.length };
}
