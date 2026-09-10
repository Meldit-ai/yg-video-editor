# yg-video-editor

Turborepo monorepo (pnpm workspaces, TypeScript). Admin tool for briefing video
editors on campaigns, with mobile + OTP login.

## Structure

```
apps/
  api/                  NestJS backend (port 8700, routes under /api)
  web/                  Vite + React + Tailwind CSS v4 + shadcn/ui (port 8701, proxies /api -> :8700)
packages/
  database/             Prisma 7 client + schema (PostgreSQL)
  typescript-config/    Shared tsconfig presets (base / nestjs / react)
```

## Getting started

```sh
pnpm install
```

Copy each `.env.example` to `.env` — there are two, and they serve different
processes:

- `packages/database/.env` — read by the **Prisma CLI** (`db:push`, `db:migrate`, `db:studio`)
- `apps/api/.env` — read by the **API at runtime** (`DATABASE_URL`, `PORT`, `JWT_SECRET`)

Then:

```sh
pnpm db:push       # create the tables
pnpm db:seed       # create the first ADMIN
pnpm dev           # api + web
```

Open http://localhost:8701 and sign in with the seeded mobile number
(`ADMIN_MOBILE`, default `9999999999`). **The OTP is always `1234`** — SMS is not
wired up; see `apps/api/src/auth/auth.constants.ts`.

## How it works

There is **no signup**. Login rejects any mobile number that is not already a
user, so accounts come only from an admin creating them — hence the seed step
above, which bootstraps the first one.

Roles are `ADMIN` and `EDITOR`. In this build every feature is admin-only;
`EDITOR` exists for future use and lands on a "nothing assigned yet" screen.

Nothing is ever hard-deleted. Every model carries an `active` flag; `DELETE`
sets it to `false`, and lists filter it out. On `Campaign` this is separate from
`status` (ACTIVE/INACTIVE), which is the business state — a campaign can be
paused without being deleted.

`Vendor` is the exception, and the flag means the opposite thing there: `active`
is a **visible status**, not a hidden delete. Inactive vendors stay in the list,
stay reachable by id, and are re-activated from the same menu that deactivated
them — so there is no `DELETE /api/vendors/:id`, and `POST` refuses to revive an
existing number rather than silently resurrecting it.

## API

| Method | Route | Access |
| --- | --- | --- |
| POST | `/api/auth/request-otp` | public |
| POST | `/api/auth/verify-otp` | public |
| GET | `/api/auth/me` | any signed-in user |
| GET | `/api/health` | public |
| `GET POST PATCH DELETE` | `/api/users`, `/api/users/:id` | ADMIN |
| `GET POST PATCH DELETE` | `/api/campaigns`, `/api/campaigns/:id` | ADMIN |
| `GET POST PATCH` | `/api/vendors`, `/api/vendors/:id` | ADMIN |
| GET | `/api/vendors/import/template` | ADMIN |
| POST | `/api/vendors/import` | ADMIN |
| GET | `/api/tracker/campaigns` | ADMIN |

`GET /api/campaigns` accepts an optional `?status=ACTIVE|INACTIVE` filter, and
`GET /api/vendors` an optional `?active=true|false` one.

`/api/vendors` is the directory of people the team works with — contact records,
not accounts. It has no `DELETE`: see the note on `active` above. The two import
routes hand out an `.xlsx` template and take a filled one back (multipart field
`file`, max 2 MB and 5 000 rows), answering with a per-row verdict.

`/api/tracker/campaigns` proxies the external campaign tracker at
`api-tracker.meldit.ai`, mapping its `campaign_id`/`campaign_name` pairs to
`{ id, name }` and caching them briefly. It backs the tracker dropdown on the
campaign form. Tracker names are **not** unique, so the id is the only real
key; a campaign stores the id and the server resolves and denormalises the
name alongside it.

Authentication is enforced globally, so new routes are protected by default —
opt out with `@Public()`, restrict with `@Roles(Role.ADMIN)`.

## Commands (run from repo root)

| Command | What it does |
| --- | --- |
| `pnpm dev` | `turbo run dev` — all apps in watch mode |
| `pnpm build` | Build every package/app (respects dependency order) |
| `pnpm check-types` | Typecheck the whole repo |
| `pnpm test` | Run unit tests |
| `pnpm db:push` | Push schema without a migration |
| `pnpm db:migrate` | `prisma migrate dev` |
| `pnpm db:seed` | Create/restore the bootstrap ADMIN |
| `pnpm db:studio` | Open Prisma Studio |

Run a single app with a filter, e.g. `pnpm turbo run dev --filter=web`.

Conventions worth reading before contributing: [CLAUDE.md](CLAUDE.md).
Design record: [docs/superpowers/specs/](docs/superpowers/specs/).
