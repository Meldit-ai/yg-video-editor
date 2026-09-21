import "reflect-metadata";
import { Logger, ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Server } from "node:http";
import { AppModule } from "./app.module.js";
import { resolveEngineCallbackUrl } from "./comparisons/engine-callback.route.js";

// Values already present in the shell environment win over .env entries.
try {
  process.loadEnvFile();
} catch {
  // No .env next to the process cwd — fine, env may come from the shell.
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });

  app.enableShutdownHooks();
  app.setGlobalPrefix("api");
  app.enableCors({ origin: "http://localhost:8701" });

  // `rawBody: true` above gives the engine-callback route the exact bytes to
  // verify its HMAC over. Nest registers exactly one JSON parser, and this
  // call replaces the default one, so the 2 MB limit and the raw-body capture
  // both apply together; the parser only touches application/json, so the
  // streamed multipart video uploads are unaffected.
  app.useBodyParser("json", { limit: "2mb" });

  app.useGlobalPipes(
    new ValidationPipe({
      // Strip properties with no matching DTO rule so clients cannot smuggle
      // extra fields (e.g. `role`) into a create/update payload.
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Node's default 5-minute request timeout is measured from the first byte
  // of the request, not the last byte received — which makes it a wall clock
  // on uploads. A 2 GB video submission over a domestic uplink runs well past
  // it, and would be cut off mid-stream with no error the browser can explain.
  // 30 minutes is generous for that and still bounds a stalled connection.
  // Raising it above headersTimeout is safe; lowering it below would make
  // Node silently swap the two.
  const server = app.getHttpServer() as Server;
  server.requestTimeout = 30 * 60 * 1000;
  server.headersTimeout = 60 * 1000;

  const port = Number(process.env.PORT ?? 8700);
  await app.listen(port);

  Logger.log(
    `API listening at http://localhost:${port}/api (health: http://localhost:${port}/api/health)`,
    "Bootstrap",
  );

  const callbackUrl = resolveEngineCallbackUrl();
  Logger.log(
    callbackUrl === null
      ? "Engine callbacks: off (API_PUBLIC_URL unset — polling mode)"
      : `Engine callbacks: on (${callbackUrl})`,
    "Bootstrap",
  );
}

await bootstrap();
