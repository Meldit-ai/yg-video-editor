import { Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import type { User } from "@repo/database";
import { PrismaService } from "../prisma/prisma.service.js";
import { DEV_OTP } from "./auth.constants.js";
import type { JwtPayload } from "./auth.types.js";

export interface LoginResult {
  token: string;
  user: User;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  /**
   * Step 1 of login. There is no signup: an unknown or soft-deleted mobile is
   * rejected here, so accounts only ever come from an admin creating them.
   *
   * No SMS is sent while the OTP is stubbed — the response just confirms the
   * number is known.
   */
  async requestOtp(mobile: string): Promise<{ sent: true }> {
    await this.findActiveUser(mobile);
    return { sent: true };
  }

  /** Step 2 of login. Exchanges a valid OTP for an access token. */
  async verifyOtp(mobile: string, otp: string): Promise<LoginResult> {
    // Constant stub for now; see DEV_OTP.
    if (otp !== DEV_OTP) {
      throw new UnauthorizedException("Incorrect OTP");
    }
    const user = await this.findActiveUser(mobile);
    const payload: JwtPayload = {
      sub: user.id,
      mobile: user.mobile,
      role: user.role,
    };
    return { token: await this.jwt.signAsync(payload), user };
  }

  private async findActiveUser(mobile: string): Promise<User> {
    const user = await this.prisma.client.user.findUnique({ where: { mobile } });
    // Soft-deleted users are indistinguishable from unknown ones on purpose:
    // deleting an account should revoke access, not merely hide the row.
    if (!user || !user.active) {
      throw new UnauthorizedException("No account found for this mobile number");
    }
    return user;
  }
}
