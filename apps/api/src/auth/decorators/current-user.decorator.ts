import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { AuthenticatedUser, RequestWithUser } from "../auth.types.js";

/** Injects the authenticated user attached by JwtAuthGuard. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const request = ctx.switchToHttp().getRequest<RequestWithUser>();
    if (!request.user) {
      // Unreachable on a guarded route; a guard always runs first.
      throw new Error("CurrentUser used on a route without JwtAuthGuard");
    }
    return request.user;
  },
);
