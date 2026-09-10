import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { HealthController } from "./health/health.controller.js";
import { PrismaModule } from "./prisma/prisma.module.js";
import { UsersModule } from "./users/users.module.js";
import { CampaignsModule } from "./campaigns/campaigns.module.js";
import { SubmissionsModule } from "./submissions/submissions.module.js";
import { TrackerModule } from "./tracker/tracker.module.js";
import { VendorsModule } from "./vendors/vendors.module.js";
import { AuthModule } from "./auth/auth.module.js";
import { JwtAuthGuard } from "./auth/guards/jwt-auth.guard.js";
import { RolesGuard } from "./auth/guards/roles.guard.js";

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    UsersModule,
    CampaignsModule,
    SubmissionsModule,
    TrackerModule,
    VendorsModule,
  ],
  controllers: [HealthController],
  providers: [
    // Order matters: authenticate first so RolesGuard has request.user.
    // Both are global, making every route protected unless it opts out
    // with @Public().
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
