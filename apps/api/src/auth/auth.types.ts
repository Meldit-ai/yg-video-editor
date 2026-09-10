import type { Role, User } from "@repo/database";

/** Claims embedded in the signed access token. */
export interface JwtPayload {
  /** User id. Named `sub` to follow the JWT registered-claim convention. */
  sub: string;
  mobile: string;
  role: Role;
}

/**
 * The user attached to a request by JwtAuthGuard. This is the live database
 * row, not the token claims, so a soft-deleted or demoted user loses access
 * immediately rather than when their token happens to expire.
 */
export type AuthenticatedUser = User;

/** Express request augmented with the authenticated user. */
export interface RequestWithUser {
  user?: AuthenticatedUser;
  headers: Record<string, string | string[] | undefined>;
}
