import { Controller, Get } from "@nestjs/common";
import { Role } from "@repo/database";
import { CurrentUser } from "../auth/decorators/current-user.decorator.js";
import { Roles } from "../auth/decorators/roles.decorator.js";
import type { AuthenticatedUser } from "../auth/auth.types.js";
import { DashboardService } from "./dashboard.service.js";
import type {
  AdminDashboardStats,
  EditorDashboardStats,
} from "./dashboard.types.js";

/**
 * The signed-in user's own dashboard.
 *
 * No @Roles: the route only ever reads the caller's own submissions, so an
 * admin opening it sees their own (usually empty) numbers rather than anyone
 * else's. The global JwtAuthGuard has already rejected anonymous callers.
 */
@Controller("dashboard")
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get("me")
  myStats(@CurrentUser() user: AuthenticatedUser): Promise<EditorDashboardStats> {
    return this.dashboardService.statsFor(user);
  }

  /**
   * GET /api/dashboard/admin — every campaign, for an admin.
   *
   * Explicitly @Roles(ADMIN): unlike /me this reads everyone's work, so it is
   * the one route here that is not about the caller.
   */
  @Get("admin")
  @Roles(Role.ADMIN)
  adminStats(): Promise<AdminDashboardStats> {
    return this.dashboardService.adminStats();
  }
}
