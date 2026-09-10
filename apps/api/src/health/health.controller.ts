import { Controller, Get } from "@nestjs/common";
import { Public } from "../auth/decorators/public.decorator.js";

/**
 * Liveness endpoint. Deliberately does NOT touch the database so the app is
 * verifiable even when Postgres is not running.
 */
@Public()
@Controller("health")
export class HealthController {
  @Get()
  check(): { status: string; service: string; timestamp: string } {
    return {
      status: "ok",
      service: "api",
      timestamp: new Date().toISOString(),
    };
  }
}
