// Prisma 7 CLI configuration. This file replaces the old `package.json#prisma`
// field and the `url = env(...)` entry in schema.prisma.
//
// Prisma 7 does NOT auto-load .env files — the `dotenv/config` import below
// loads packages/database/.env before the config is evaluated.
import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    // Fall back to the local default (same value as .env.example) so
    // `prisma generate` — and therefore `pnpm build` — works on a fresh
    // clone where the gitignored .env does not exist yet.
    url:
      process.env.DATABASE_URL ??
      "postgresql://postgres:postgres@localhost:5432/yg_video_editor",
  },
});
