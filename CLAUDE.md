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

**Duplicate detection is a label per video, decided on arrival.** Every
submission and every reel gets `uniqueness` ∈ UNIQUE / PARTIAL / DUPLICATE
by being compared — through the engine at `COMPARISON_ENGINE_URL`, default
`http://127.0.0.1:8080` — against the campaign's **baseline** only: its
UNIQUE and PARTIAL videos, in arrival order. DUPLICATEs are never compared
against (everything in one is already in its parent). Match value =
highest `max(score, containment)` over the baseline; ≥ the campaign
threshold → DUPLICATE, ≥ 25 (the engine's NO_MATCH edge) → PARTIAL, else
UNIQUE; the best-matching baseline video is the parent
(`topMatchSubmissionId` / `originalReelId`), stored even for UNIQUE so a
threshold edit can re-label without the engine. `UniquenessService` owns
all of it; the design is
`docs/superpowers/specs/2026-09-17-incremental-duplicate-detection-design.md`.
Four things bite:

- **A row has four states, read off two columns.** `uniqueness` null +
  `duplicationCheckedAt`/`checkedAt` null = *pending* (the durable work
  queue — boot sweeps it); null + set = *unreadable* (the engine could not
  fingerprint it; terminal until a rebuild); set + set = labelled. Never
  test `duplicationScore !== null` to mean "checked".
- **Four events touch a label, and all go through `classifyPending`.**
  Arrival (upload, reel import, reel adoption) classifies what is pending;
  withdrawal of a UNIQUE/PARTIAL video resets its dependants to pending;
  the admin "check" buttons are a **rebuild** (reset everything, replay in
  arrival order — literally the same loop); a threshold edit re-labels from
  stored values in `CampaignsService.update`'s transaction with zero engine
  calls, and does *not* ripple forward — that is what the rebuild is for.
- **Work is serialised per `kind:campaignId`** in an in-process promise
  queue, because sequencing is the algorithm — the second video's baseline
  must include the first's label. Calls for one candidate go one at a time
  so the first fingerprints it and the rest hit the engine's cache.
- **The latest run is evidence, not truth.** A `VideoComparison` run holds
  one batch — usually one upload against the baseline, pairs for the
  candidate's side only — so most videos are not in the latest run, and the
  UI reads each card's state from its own row (`use-comparison.ts`).
- **The engine's cost is fingerprinting, once per URL; ours was waiting.**
  A fresh 2-minute video costs the engine ~30–40 s (decode + hash + embed);
  a cache-warm comparison costs it <1 s. So the classifier polls every
  second, fingerprints the next `COMPARISON_ENGINE_PREFETCH` candidates
  ahead of time on the engine's idle workers (`engine.warm`, a two-URL job
  whose result nobody reads), and runs a warmed candidate's pinned calls
  `COMPARISON_ENGINE_CALL_CONCURRENCY` at a time. A cold candidate's *first*
  call still runs alone — fired together, every call would download it.
- **Same bytes never reach the engine.** Every submission carries a sha256
  measured while it streamed (`measureStream`, on the upload engine and on
  reel adoption); every reel carries the ETag and size from a HEAD on its
  media (`headMedia`). `planPinnedCalls` treats a baseline video with the
  same identity as a *twin* — a perfect match, labelled DUPLICATE 100 with
  no engine call. A missing identity never matches.

**The engine takes at most 4 URLs per call, and that is its hard cap.**
`engineMaxUrls()` in `comparison-engine.client.ts` is the one place both
paths read it (env `COMPARISON_ENGINE_MAX_URLS`, default 4, clamped to 6
because a job's pair count is quadratic against one shared timeout). Confirm
the deployed engine before raising it: a 5-URL probe answering 422 means it
is still 4. `planPinnedCalls` puts the candidate first and `cap − 1`
baseline videos beside it, so a call covers exactly that many useful pairs;
pairs among the baseline videos are computed by the engine (cached after the
first time) and discarded by `matchesOf`. Full-queue refusals (`engine_busy`,
503) are waited out in `submitWithBackoff`, not reported.

Results are role-scoped in `ComparisonsService.toDto`, not by hiding UI: an
editor sees the verdict on **their own** videos with the counterpart redacted
to "Another submission", no evidence and no groups; an admin sees the whole
run. The history list and the rebuild are `@Roles(Role.ADMIN)`.
Five more things bite:

- **The engine is handed the plain, unsigned object URL**
  (`StorageService.publicObjectUrl`), not a presigned one. It derives a
  video's cache identity by hashing the URL string, so a signature — which
  carries a timestamp — would make the same file look new on every run. This
  only works because the bucket grants public read on *objects* (an unsigned
  GET on a submitted video answers 200; listing the bucket is still 403).
  Presigned playback URLs therefore buy unguessability, not confidentiality —
  the keys are random uuids, and that is what actually protects a submitted
  video. Turning object-read off would break this integration. The same
  applies to a reel's `mediaUrl`: never normalise it.
- **`pairs[].a`/`b` are engine keys, never URLs.** Getting from a pair back to
  a submission takes two hops: key → URL via `result.videos[]`, URL →
  submission via the entries we sent. `resolveResult` in
  `comparisons/engine-result.ts` is the only place that does it. The engine
  orders `a`/`b` by its own row ids, not by request order.
- **A per-video status of `cached` is a success**, not a failure. From the
  second call onwards most videos come back cached, and reading only `ready`
  as usable reports a healthy check as "these could not be read". Appearing
  in a pair also promotes a video to ready, whatever its status string said.
- **`result` is null until the job is terminal — except that a `failed` job
  still carries `result.videos[]`** with per-video statuses, which is how an
  unreadable candidate is told apart from a timed-out call (retried once,
  then left pending). `waitForJob` in the client polls to terminal; sleeps
  go through `common/pause.ts` so vitest's fake timers cover them —
  `node:timers/promises` is not faked.
- **`score` is floored at 1.0.** A 1.0 means "no signal at all", not "1%
  similar". Labels branch on the match value against `PARTIAL_FLOOR` and the
  threshold, never on the verdict string.

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
