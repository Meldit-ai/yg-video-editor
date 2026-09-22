import {
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import type { Request } from "express";
import { Public } from "../auth/decorators/public.decorator.js";
import { WhatsAppService } from "./whatsapp.service.js";
import type { WebhookPayload } from "./whatsapp.types.js";

/** An express request carrying the raw bytes, captured in main.ts. */
type RawRequest = Request & { rawBody?: Buffer };

/**
 * Meta's webhook for inbound WhatsApp messages.
 *
 * Public by necessity — Meta sends no bearer token — so authenticity rests
 * entirely on the shared verify token on GET and the HMAC signature on POST.
 * Neither route reads anything the caller says about who they are.
 */
@Controller("whatsapp")
export class WhatsAppController {
  constructor(private readonly whatsapp: WhatsAppService) {}

  /**
   * GET — the subscription handshake.
   *
   * Meta calls this once when the webhook is saved and expects `hub.challenge`
   * echoed back as a bare body. Anything else, including a JSON-wrapped copy,
   * reads to Meta as a failed validation.
   */
  @Public()
  @Get("webhook")
  verify(
    @Query("hub.mode") mode = "",
    @Query("hub.verify_token") token = "",
    @Query("hub.challenge") challenge = "",
  ): string {
    if (!this.whatsapp.verifySubscription(mode, token)) {
      throw new ForbiddenException("Verification failed");
    }
    return challenge;
  }

  /**
   * POST — a vendor's message.
   *
   * Answers 200 as soon as the payload is verified and read. Meta retries
   * anything slower than a few seconds, and a retry would process the same
   * reply twice.
   */
  @Public()
  @Post("webhook")
  @HttpCode(HttpStatus.OK)
  async receive(
    @Req() request: RawRequest,
    @Headers("x-hub-signature-256") signature?: string,
  ): Promise<{ received: true }> {
    if (!this.whatsapp.verifySignature(signature, request.rawBody)) {
      throw new ForbiddenException("Bad signature");
    }
    await this.whatsapp.handle(request.body as WebhookPayload);
    return { received: true };
  }
}
