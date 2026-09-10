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

**Video submissions stream; they are never buffered.** Editors upload cuts to
Hetzner object storage (S3-compatible) from the campaign page. The file goes
socket → API → bucket through a custom multer storage engine
(`apps/api/src/submissions/video-upload.storage.ts`), so a 2 GB video costs
~30 MB of memory, not 2 GB. Four things bite here:

- `CampaignAccessGuard` exists because **guards run before interceptors** — it
  404s a bad campaign id before a byte is streamed. Never move that check into
  the handler.
- multer signals a size limit by emitting `limit` and then **ending the stream
  cleanly**, so a naive engine reports a truncated video as a success. The
  engine checks both `limit` and `stream.truncated`, and deletes the object.
- `upload.abort()` only raises a flag. The body has to be destroyed too, or the
  multipart upload dangles and its parts are billed forever.
- The engine's callback must fire **exactly once on every path**; multer hangs
  the request forever if it never comes.

Multer options are registered by `MulterModule.registerAsync` in
`SubmissionsModule` (the engine needs `StorageService` injected). Those options
are scoped to that module, which is what keeps the vendors importer on memory
storage — do not make them global.

Playback is a presigned `GetObject` URL, 6 hours, `inline`. No CORS policy is
needed: a plain `<video src>` without `crossorigin` is an ordinary media
request. `objectKey` never leaves the server.

The bucket denies *listing* (403) but grants public read on individual
objects — an unsigned GET on a submitted video answers 200. So the signature
is not what keeps a video private; the random-uuid key is. Verified, and the
comparison engine depends on it (see below).

**Duplicate detection is per-campaign, not per-video.** After every upload the
API asks the comparison engine (`COMPARISON_ENGINE_URL`, default
`http://127.0.0.1:8080`) to compare *every* active submission on the campaign
against every other. A new upload starts a fresh run and marks any run still
in flight `SUPERSEDED`.

**The engine takes at most 4 URLs per call** (`COMPARISON_ENGINE_MAX_URLS`) —
a 5th is answered with HTTP 422, not a truncated job, so a campaign past four
videos fails outright unless it is split. `planBatches` cuts the videos into
blocks of `maxUrls / 2` and submits every *pair of blocks*, which is what
keeps every pair covered: a run is therefore several `VideoComparisonJob`
rows, and finishes when all of them do. Batches overlap on purpose, so pairs
are merged with `skipDuplicates` on `pairKey` (the unordered {a,b} identity)
rather than replaced — the a/b columns keep the engine's order because
`evidence` has an A side and a B side.

Results are role-scoped in `ComparisonsService.toDto`, not by hiding UI: an
editor sees the verdict on **their own** videos with the counterpart redacted
to "Another submission", no evidence and no groups; an admin sees the whole
matrix. The history list and the manual re-run are `@Roles(Role.ADMIN)`.
Five more things bite:

- **The engine is handed the plain, unsigned object URL**
  (`StorageService.publicObjectUrl`), not a presigned one. It derives a
  video's cache identity by hashing the URL, so a signature — which carries a
  timestamp — would make the same file look new on every run. This only works
  because the bucket grants public read on *objects* (an unsigned GET on a
  submitted video answers 200; listing the bucket is still 403). Presigned
  playback URLs therefore buy unguessability, not confidentiality — the keys
  are random uuids, and that is what actually protects a submitted video.
  Turning object-read off would break this integration.
- **`pairs[].a`/`b` are engine keys, never URLs.** Getting from a pair back to
  a submission takes two hops: key → URL via `result.videos[]`, URL →
  submission via our own `VideoComparisonEntry` rows. `resolveResult` is the
  only place that does it.
- **A per-video status of `cached` is a success**, not a failure. From the
  second run of a campaign onwards most videos come back cached, and reading
  only `ready` as usable reports a healthy re-run as "these could not be
  read". Appearing in a pair also promotes a video to ready, whatever its
  status string said.
- **`result` is null until the job is terminal.** Polling lives in
  `ComparisonsService`, in-process and one poller per `VideoComparisonJob`, so
  the browser polls our database rather than the engine; calls left
  non-terminal are resumed on boot.
- **`score` is floored at 1.0.** A 1.0 means "no signal at all", not "1%
  similar". Branch on `verdict`, not on the number.

**Node's request timeout is a wall clock, not an idle timeout.** The 5-minute
default is measured from the first byte of a request to its last, so a healthy
2 GB upload dies mid-stream. `apps/api/src/main.ts` raises it to 30 minutes,
and `apps/web/vite.config.ts` raises the dev server's to match — the proxy
answers 408 otherwise, whatever the API allows.

**exceljs is CJS with `module.exports = <identifier>`,** which Node's CJS lexer
cannot see: `import { Workbook } from "exceljs"` type-checks and then throws at
boot. Use a default import for values (`import ExcelJS from "exceljs"`) and
`import type` for types. It lives in `apps/api` only — no spreadsheet code ships
to the browser.

**Two `.env` files.** `packages/database/.env` is read only by the Prisma CLI;
`apps/api/.env` is read by the API at runtime via `process.loadEnvFile()`. Keep
`DATABASE_URL` in sync across both. The `HETZNER_BUCKET_*` block lives in
`apps/api/.env` only, and is read lazily — the API still boots without it, and
the submission routes answer 503 naming what is missing.

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
