import { SetMetadata } from "@nestjs/common";

export const IS_PUBLIC_KEY = "isPublic";

/**
 * Marks a route as reachable without a token.
 *
 * JwtAuthGuard is registered globally, so authentication is the default and
 * every exemption has to be spelled out here. A new endpoint that forgets to
 * think about auth fails closed.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
