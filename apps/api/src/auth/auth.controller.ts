import { Body, Controller, Get, HttpCode, HttpStatus, Post } from "@nestjs/common";
import type { User } from "@repo/database";
import { AuthService, type LoginResult } from "./auth.service.js";
import { RequestOtpDto, VerifyOtpDto } from "./dto/auth.dto.js";
import { Public } from "./decorators/public.decorator.js";
import { CurrentUser } from "./decorators/current-user.decorator.js";

@Controller("auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /** POST /api/auth/request-otp — body: { mobile } */
  @Public()
  @Post("request-otp")
  @HttpCode(HttpStatus.OK)
  requestOtp(@Body() body: RequestOtpDto): Promise<{ sent: true }> {
    return this.authService.requestOtp(body.mobile);
  }

  /** POST /api/auth/verify-otp — body: { mobile, otp } -> { token, user } */
  @Public()
  @Post("verify-otp")
  @HttpCode(HttpStatus.OK)
  verifyOtp(@Body() body: VerifyOtpDto): Promise<LoginResult> {
    return this.authService.verifyOtp(body.mobile, body.otp);
  }

  /** GET /api/auth/me — the caller's own account. */
  @Get("me")
  me(@CurrentUser() user: User): User {
    return user;
  }
}
