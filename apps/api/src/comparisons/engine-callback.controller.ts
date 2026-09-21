import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  Logger,
  Post,
  RawBody,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { Public } from "../auth/decorators/public.decorator.js";
import { ENGINE_CALLBACK_ACTION, ENGINE_CALLBACK_CONTROLLER } from "./engine-callback.route.js";
import { verifyEngineSignature } from "./engine-callback.signature.js";
import { EngineJobNotifications } from "./engine-job-notifications.js";

/**
 * Receives the finished job document the Python comparison engine POSTs back.
 *
 * Public: the engine holds no user token, only the shared HMAC secret, which
 * is the only authentication this route has. Idempotent by construction —
 * `EngineJobNotifications` buffers a duplicate or late-arriving callback
 * rather than erroring, and prunes it after ten minutes if nothing ever
 * waited for it (see `EARLY_NOTIFICATION_TTL_MS`).
 */
@Public()
@Controller(ENGINE_CALLBACK_CONTROLLER)
export class EngineCallbackController {
  private readonly logger = new Logger(EngineCallbackController.name);

  constructor(private readonly notifications: EngineJobNotifications) {}

  @Post(ENGINE_CALLBACK_ACTION)
  @HttpCode(200)
  receive(
    @RawBody() raw: Buffer | undefined,
    @Headers("x-engine-signature") signature?: string,
  ): { received: true; outcome: "resolved" | "buffered" } {
    const secret = (process.env.COMPARISON_ENGINE_CALLBACK_SECRET ?? "").trim();
    if (secret.length === 0) {
      throw new ServiceUnavailableException(
        "Engine callbacks are not configured. Missing: COMPARISON_ENGINE_CALLBACK_SECRET",
      );
    }

    // ValidationPipe's global whitelist/transform skip Buffer parameters, so
    // this only happens when Nest itself did not populate rawBody — i.e. the
    // request was not application/json.
    if (raw === undefined) {
      throw new BadRequestException("Expected a JSON body");
    }

    // Verify the bytes before parsing them: a signature check on already
    // -parsed JSON would accept a body whose re-serialization happens to
    // differ from what was actually signed.
    if (!verifyEngineSignature(raw, signature, secret, Date.now())) {
      this.logger.warn("Rejected engine callback: invalid signature");
      throw new UnauthorizedException("Invalid engine signature");
    }

    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new BadRequestException("Body is not valid JSON");
    }

    if (
      typeof payload !== "object" ||
      payload === null ||
      Array.isArray(payload) ||
      typeof (payload as Record<string, unknown>).job_id !== "string"
    ) {
      throw new BadRequestException("Missing job_id");
    }

    const jobId = (payload as { job_id: string }).job_id;
    const outcome = this.notifications.notify(jobId, payload);
    this.logger.log(`Engine callback for job ${jobId}: ${outcome}`);
    return { received: true, outcome };
  }
}
