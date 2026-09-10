import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/client.js";

export interface CreatePrismaClientOptions {
  /** Postgres connection string. Defaults to process.env.DATABASE_URL. */
  connectionString?: string;
}

/**
 * Construct a new PrismaClient wired to the pg driver adapter.
 *
 * Prisma 7 removed the Rust query engine; a driver adapter is required, so
 * every client goes through @prisma/adapter-pg here.
 */
export function createPrismaClient(
  options: CreatePrismaClientOptions = {},
): PrismaClient {
  const connectionString =
    options.connectionString ?? process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error(
      "@repo/database: DATABASE_URL is not set. Provide it via the environment " +
        "or pass { connectionString } to createPrismaClient().",
    );
  }

  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({ adapter });
}

let singleton: PrismaClient | undefined;

/**
 * Lazily-created process-wide PrismaClient singleton.
 *
 * Created on first call (never at import time, so importing this package for
 * its types does not require DATABASE_URL) and reused afterwards — safe to
 * call from anywhere that just needs a shared client.
 */
export function getPrismaClient(): PrismaClient {
  singleton ??= createPrismaClient();
  return singleton;
}

/**
 * Disconnect and drop the shared singleton (e.g. in tests or on shutdown).
 * The next getPrismaClient() call creates a fresh client.
 */
export async function disconnectPrismaClient(): Promise<void> {
  if (singleton) {
    const client = singleton;
    singleton = undefined;
    await client.$disconnect();
  }
}
