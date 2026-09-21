# api

NestJS 12 backend (ESM, Express 5) wired to `@repo/database` (Prisma 7).

## Commands

Run from the repo root (Turborepo):

```sh
pnpm dev    # nest start --watch (turbo builds @repo/database first)
pnpm build  # nest build -> dist/
pnpm start  # node dist/main.js (turbo builds first)
pnpm check-types
```

They also work directly from `apps/api`, but only after `@repo/database` has
been built once (run `pnpm build` at the repo root first) — the in-package
scripts invoke nest/tsc directly, without turbo's build ordering.

## Configuration

The API loads `apps/api/.env` at startup via Node's `process.loadEnvFile()`
(copy `.env.example` to `.env`; values already exported in the shell win).

- `PORT` — HTTP port, defaults to `8700`.
- `DATABASE_URL` — required for database-backed routes at runtime. Note that
  `packages/database/.env` is read only by the Prisma CLI (migrate/push/studio),
  not by the API process — keep both files in sync when pointing at a
  non-default database.

CORS is enabled for `http://localhost:8701` (the web app dev server). All
routes are prefixed with `/api`.

## Routes

Everything except `/api/health`, the two `/api/auth` OTP steps, and the
engine callback below requires a bearer token; `/api/users`, `/api/campaigns`
and `/api/vendors` are ADMIN-only.

- `GET /api/health` — `{ status, service, timestamp }`. Never touches the
  database, so it works without Postgres running.
- `POST /api/auth/request-otp`, `POST /api/auth/verify-otp`, `GET /api/auth/me`.
- `GET POST PATCH DELETE /api/users[/:id]` — accounts. `DELETE` is a soft delete.
- `GET POST PATCH DELETE /api/campaigns[/:id]` — `?status=ACTIVE|INACTIVE`.
- `GET /api/tracker/campaigns` — proxied, cached ~5 min, serves stale on failure.
- `POST /api/comparisons/engine-callback` — public, HMAC-signed. The
  comparison engine posts a finished job document here instead of (or as
  well as) being polled; authenticated by `X-Engine-Signature`, not a bearer
  token. 503 while `COMPARISON_ENGINE_CALLBACK_SECRET` is unset.

### Vendors

The contact directory. No `DELETE`: `active` is a visible status here, not a
soft-delete flag, so deactivating leaves the row listed and `POST` returns 409
for an existing number rather than reviving it.

- `GET /api/vendors` — newest first, inactive included; `?active=true|false`.
- `GET /api/vendors/:id`, `POST /api/vendors`, `PATCH /api/vendors/:id`.
- `GET /api/vendors/import/template` — the blank `.xlsx`, as an attachment.
- `POST /api/vendors/import` — multipart field `file`. Answers **200** (a run
  that created nothing is still a success) with a verdict for every row:
  `created`, `duplicate` or `error`, plus counts that always reconcile.

  Limits: `.xlsx` only, **2 MB** (413 `File too large` above it, from multer) and
  **5 000 data rows** (400). Headers must be on row 1; `Name` and `Phone Number`
  are required, other known headers are optional and unknown ones are ignored.
  The sheet named `Vendors` is imported, else the first one.

## Behavior without a database

The app boots even when Postgres is unreachable: `PrismaService.onModuleInit`
catches the `$connect` failure and logs a warning instead of crashing. Only
database-backed routes (`/api/users`) fail until the database comes up; Prisma
retries the connection lazily on the next query, so no restart is needed.
