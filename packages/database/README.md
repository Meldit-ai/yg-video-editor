# @repo/database

Prisma 7 database layer for the yg-video-editor monorepo (PostgreSQL, driver-adapter based via `@prisma/adapter-pg`).

## Commands

Run from the repo root with `pnpm --filter @repo/database <script>` (or via `turbo run <task>`):

| Script        | What it does                                                        |
| ------------- | ------------------------------------------------------------------- |
| `build`       | `prisma generate` (emits TS client into `src/generated`) then `tsc` |
| `check-types` | `tsc --noEmit` (via turbo it runs after `build`; standalone runs need a prior `db:generate`) |
| `db:generate` | Regenerate the Prisma client                                        |
| `db:push`     | Push the schema to the database without migrations                  |
| `db:migrate`  | `prisma migrate dev` (creates/applies migrations)                   |
| `db:studio`   | Open Prisma Studio                                                  |

## Usage

```ts
import { getPrismaClient, createPrismaClient, type User } from "@repo/database";

const prisma = getPrismaClient(); // lazy shared singleton
// or: const prisma = createPrismaClient({ connectionString: "..." });
const users: User[] = await prisma.user.findMany();
```

## Pointing DATABASE_URL elsewhere

- **CLI (generate/push/migrate/studio):** `prisma.config.ts` loads `packages/database/.env` via dotenv. Edit `DATABASE_URL` there (copy `.env.example` to `.env` on a fresh clone), or export `DATABASE_URL` in your shell/CI — the environment wins over the built-in localhost fallback.
- **Runtime (NestJS app):** `createPrismaClient()`/`getPrismaClient()` read `process.env.DATABASE_URL`, or accept an explicit `{ connectionString }`.

Default: `postgresql://postgres:postgres@localhost:5432/yg_video_editor`.

## Notes

- `src/generated/` is gitignored and produced by `prisma generate`; nothing in this package compiles until that has run (the `build` script does it for you).
- Prisma 7 requires a driver adapter (the Rust engine is gone); client construction is centralized in `src/client.ts`.
