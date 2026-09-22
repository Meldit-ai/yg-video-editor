import "reflect-metadata";
import { Logger, ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { Server } from "node:http";
import { AppModule } from "./app.module.js";

// Values already present in the shell environment win over .env entries.
try {
  process.loadEnvFile();
} catch {
  // No .env next to the process cwd — fine, env may come from the shell.
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    // Meta signs the exact bytes it sent, so the raw body has to survive
    // parsing: `JSON.stringify` of the parsed object is not byte-identical
    // (key order, whitespace, unicode escapes) and the HMAC would never match.
    rawBody: true,
  });

  app.enableShutdownHooks();
  app.setGlobalPrefix("api");
  app.enableCors({ origin: "http://localhost:8701" });

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
}

await bootstrap();
