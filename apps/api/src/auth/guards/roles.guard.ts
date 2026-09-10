import {
  ForbiddenException,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Role } from "@repo/database";
import { ROLES_KEY } from "../decorators/roles.decorator.js";
import type { RequestWithUser } from "../auth.types.js";

/**
 * Enforces @Roles(...). Runs after JwtAuthGuard, so request.user is populated.
 * Routes without @Roles are open to any authenticated user.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const { user } = context.switchToHttp().getRequest<RequestWithUser>();
    if (!user || !required.includes(user.role)) {
      throw new ForbiddenException("Insufficient role for this resource");
    }
    return true;
  }
}
