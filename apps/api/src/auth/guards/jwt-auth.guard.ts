import {
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { Reflector } from "@nestjs/core";
import { PrismaService } from "../../prisma/prisma.service.js";
import { IS_PUBLIC_KEY } from "../decorators/public.decorator.js";
import type { JwtPayload, RequestWithUser } from "../auth.types.js";

/**
 * Authenticates every request unless the route is marked @Public().
 *
 * Registered globally (APP_GUARD), so routes are protected by default and a
 * new endpoint cannot accidentally ship unguarded.
 *
 * The user is re-read from the database on each request rather than trusted
 * from the token claims. Tokens live for days, so without this a soft-deleted
 * or demoted user would keep their old access until expiry.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const token = extractBearerToken(request);
    if (!token) {
      throw new UnauthorizedException("Missing bearer token");
    }

    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(token);
    } catch {
      throw new UnauthorizedException("Invalid or expired token");
    }

    const user = await this.prisma.client.user.findUnique({
      where: { id: payload.sub },
    });
    if (!user || !user.active) {
      throw new UnauthorizedException("Account no longer active");
    }

    request.user = user;
    return true;
  }
}

function extractBearerToken(request: RequestWithUser): string | undefined {
  const header = request.headers?.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== "string") return undefined;
  const [scheme, token] = value.split(" ");
  return scheme?.toLowerCase() === "bearer" && token ? token : undefined;
}
