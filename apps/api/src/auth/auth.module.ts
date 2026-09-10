import { Global, Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { AuthController } from "./auth.controller.js";
import { AuthService } from "./auth.service.js";
import { TOKEN_TTL } from "./auth.constants.js";

/**
 * Resolves the token signing secret.
 *
 * A checked-in fallback would silently make production tokens forgeable, so
 * outside development a missing JWT_SECRET is a startup failure, not a warning.
 */
function resolveJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (secret && secret.length > 0) return secret;
  if (process.env.NODE_ENV === "production") {
    throw new Error("JWT_SECRET must be set when NODE_ENV=production");
  }
  return "dev-only-insecure-secret";
}

@Global()
@Module({
  imports: [
    JwtModule.register({
      global: true,
      secret: resolveJwtSecret(),
      signOptions: { expiresIn: TOKEN_TTL },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService],
  exports: [AuthService],
})
export class AuthModule {}
