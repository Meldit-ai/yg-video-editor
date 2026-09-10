// Client construction helpers (driver-adapter wiring, lazy singleton).
export * from "./client.js";

// Re-export the generated Prisma client: PrismaClient, the Prisma namespace,
// and all model types — so consumers can do
//   import { PrismaClient, type User, type Project } from "@repo/database";
// Note: src/generated is produced by `prisma generate` (run as part of build).
export * from "./generated/client.js";
