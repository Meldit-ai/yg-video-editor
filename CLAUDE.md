# yg-video-editor — working notes

Turborepo + pnpm monorepo. `apps/api` (NestJS), `apps/web` (Vite/React),
`packages/database` (Prisma), `packages/typescript-config` (shared tsconfigs).

## Design direction (frontend)

**Dark, dense, keyboard-first** — Linear/Vercel territory. Near-black surfaces,
hairline borders instead of shadows, tight spacing, 13–14px base UI text,
restrained motion (120–200ms), one accent colour used sparingly. Dark is the
default; light must still look deliberate. Avoid loud gradients, drop shadows,
oversized headings, and decorative illustration.

The design system lives in `apps/web/src/index.css`: an oklch token set (the
shadcn set plus `--success` and `--warning`), Geist Variable / Geist Mono via
`@fontsource`, and two custom utilities — `.numeric` (tabular numerals, for IDs,
dates, counts, phone numbers) and `.panel-sheen` (hairline top highlight for
lifted dark panels). The sidebar is deliberately **darker** than the content
area.

Shared building blocks, so screens stay consistent: `PageHeader` + `MetaDivider`,
`EmptyState`, `CampaignStatusBadge` / `RoleBadge`, `ThemeToggle`, and the
formatters in `src/lib/format.ts` (`relativeTime`, `shortDate`, `fullDate`,
`initials`). Reach for these before inventing a one-off.

**shadcn is the component base**, extended with other libraries where they earn
it — currently `motion` (animation), `next-themes` (theme switching),
`date-fns`, and `cmdk` (via the command palette). Add official shadcn components
rather than hand-rolling equivalents:

```bash
cd apps/web && pnpm dlx shadcn@latest add <component> --yes --overwrite
```

Two CLI quirks, both of which bite every time: it writes
`import { cn } from "cn"` (correct import is `@/lib/utils`) and installs a bogus
`cn` package; and it prompts on overwrite unless you pass `--overwrite`. Fix the
imports immediately after adding:

```bash
sed -i 's|from "cn"|from "@/lib/utils"|' src/components/ui/*.tsx
```

## Conventions that are easy to get wrong

**`apps/api` is ESM.** Every relative import needs a `.js` extension
(`./users.service.js`), even though the source is `.ts`.

**Soft delete, never hard delete.** Every model has `active: Boolean`. `DELETE`
endpoints set `active = false`; lists filter `active: true`. On `Campaign`, the
soft-delete flag `active` is distinct from the business field `status`
(ACTIVE/INACTIVE) — do not conflate them.

**`Vendor.active` is the exception.** There it is a *visible status*, not a
soft-delete flag: inactive vendors stay listed and reachable by id, there is no
`DELETE` route, and `POST /vendors` returns 409 for an existing number instead
of reviving it (the message tells the admin to re-activate the row).

**Auth fails closed.** `JwtAuthGuard` + `RolesGuard` are global (`APP_GUARD`), so
new routes are protected by default. Opt out with `@Public()`; restrict with
`@Roles(Role.ADMIN)`. The JWT guard re-reads the user from the database on every
request, so a deleted or demoted user loses access immediately rather than at
token expiry.

**The API enforces self-lockout rules.** An admin cannot delete, demote, or
deactivate themselves (400 each). The UI hides those actions on your own row —
keep both sides in step.

**The rate card is editor-only.** `User.rateCard` is a nullable float — what
an editor charges per video. The server derives it from the *effective* role
rather than trusting the payload: promoting an editor to ADMIN clears it, and
sending a rate card for an admin is a 400. Null on an editor is a legitimate
state ("not agreed yet"), not a missing value. The user dialog only renders the
field while EDITOR is selected — keep both sides in step.

**The tracker integration is id-keyed, server-resolved.** Campaigns link to the
external tracker at `api-tracker.meldit.ai`, proxied through
`GET /api/tracker/campaigns` (cached ~5 min, serves stale on upstream failure).
Two rules that are easy to get wrong: tracker **names are not unique** (two
distinct ids both named "Airbnb"), so never key a list, map, or React `key` on
the name; and the client sends only `trackerCampaignId` — the server resolves
and stores `trackerCampaignName`. Sending the name yourself is a 400, because
the global ValidationPipe uses `forbidNonWhitelisted`.

**exceljs is CJS with `module.exports = <identifier>`,** which Node's CJS lexer
cannot see: `import { Workbook } from "exceljs"` type-checks and then throws at
boot. Use a default import for values (`import ExcelJS from "exceljs"`) and
`import type` for types. It lives in `apps/api` only — no spreadsheet code ships
to the browser.

**Two `.env` files.** `packages/database/.env` is read only by the Prisma CLI;
`apps/api/.env` is read by the API at runtime via `process.loadEnvFile()`. Keep
`DATABASE_URL` in sync across both.

**Version pins are deliberate.** Prisma is pinned to `^7.10.0` because npm's
`latest` tag points at an 8.0 RC. TypeScript is pinned `~6.0.2` (TS 7 is the new
native compiler; `@nestjs/cli` depends on 6). TS 6 removed `baseUrl`, requires an
explicit `rootDir`, and no longer auto-includes `@types/*`.

**Assume a dev server is watching the tree.** When adding a file that another
file imports, create the imported file *first*. A dangling import is a visible
crash, not a private intermediate state.

## Ports

API `8700` (routes under `/api`), web `8701` (Vite proxies `/api` → 8700, with
`strictPort` because the API pins its CORS origin to 8701).

## Commands

```bash
pnpm dev            # api + web
pnpm build
pnpm check-types
pnpm test
pnpm db:push        # apply schema
pnpm db:seed        # create the first ADMIN (ADMIN_MOBILE / ADMIN_NAME)
```

Login OTP is hardcoded to `1234` in `apps/api/src/auth/auth.constants.ts`.

Design records live in `docs/superpowers/specs/`.
