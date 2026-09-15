import { Controller, Get } from "@nestjs/common";
import { CurrentUser } from "../auth/decorators/current-user.decorator.js";
import type { AuthenticatedUser } from "../auth/auth.types.js";
import { DashboardService } from "./dashboard.service.js";
import type { EditorDashboardStats } from "./dashboard.types.js";

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
}
