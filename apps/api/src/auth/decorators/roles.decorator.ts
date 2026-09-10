import { SetMetadata } from "@nestjs/common";
import type { Role } from "@repo/database";

export const ROLES_KEY = "roles";

/** Restricts a route to the listed roles. Enforced by RolesGuard. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
