import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
// @repo/database (Prisma 7) wires the PrismaClient to the pg driver adapter
// internally and exposes a lazy process-wide singleton via getPrismaClient().
// We wrap that instead of extending PrismaClient here, so this app never
// reconstructs adapter/config details. Everything is imported from
// "@repo/database" only — never from generated client paths.
import {
  disconnectPrismaClient,
  getPrismaClient,
  type PrismaClient,
} from "@repo/database";

@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  /**
   * The shared PrismaClient singleton from @repo/database.
   *
   * Lazy on purpose: getPrismaClient() creates the client on first access and
   * throws if DATABASE_URL is unset — a getter keeps that failure out of DI
   * construction, so the app still boots (and /api/health still works) with
   * no database configured. Database-backed routes fail per-request instead.
   */
  get client(): PrismaClient {
    return getPrismaClient();
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.client.$connect();
      this.logger.log("Database connection established");
    } catch (error) {
      // Do not crash the app when the database is unavailable: /api/health
      // must keep working without Postgres. DB-backed routes will error until
      // it is reachable (Prisma connects lazily on the next query, so no
      // restart is needed once the database comes up).
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Could not connect to the database — continuing without it. DB-backed routes will fail until it is reachable. Reason: ${reason}`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await disconnectPrismaClient();
    } catch {
      // Nothing to clean up if we never connected.
    }
  }
}
