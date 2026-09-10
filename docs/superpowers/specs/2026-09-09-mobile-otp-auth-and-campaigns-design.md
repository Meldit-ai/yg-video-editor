# Mobile + OTP auth, users and campaigns CRUD

Date: 2026-09-09
Status: approved, implemented

## Problem

The monorepo scaffold had a placeholder `User` (email-based) and `Project` model
and no authentication at all. We need mobile + OTP login, role-based access, and
admin CRUD over users and campaigns.

## Decisions

Four questions settled the shape of this work:

1. **EDITOR has no features in this build.** Both user CRUD and campaign CRUD are
   ADMIN-only. `EDITOR` exists as a role value for future use; editors can log in
   and see a "nothing assigned yet" state.
2. **Bootstrap by seed, reject unknown numbers.** `pnpm db:seed` upserts the first
   ADMIN from `ADMIN_MOBILE` / `ADMIN_NAME`. Login rejects any mobile that is not
   already a user, so there is no signup path — accounts come only from an admin.
3. **JWT in localStorage.** `verify-otp` returns a 7-day signed token; the SPA
   sends it as a bearer header. No session table.
4. **Soft delete everywhere.** Every model carries `active: Boolean @default(true)`
   plus `createdAt` / `updatedAt`. `DELETE` sets `active = false`; rows are never
   physically removed.

## Data model

`User { id, mobile @unique, name, role: Role, active, createdAt, updatedAt }`
`Campaign { id, title, contentLink?, briefText?, guidanceNote?, status: CampaignStatus, trackerCampaignId?, active, createdAt, updatedAt }`

`Campaign.status` (ACTIVE/INACTIVE) is the *business* state and is deliberately
separate from `active`, the soft-delete flag: a campaign can be paused
(`status = INACTIVE`) without being deleted.

`title` is the only required campaign field, so a campaign can be drafted before
the tracker id or content link is known.

## Authentication

`POST /auth/request-otp` → looks the mobile up, 401 if unknown or soft-deleted.
`POST /auth/verify-otp` → compares against `DEV_OTP` ("1234"), returns `{ token, user }`.
`GET /auth/me` → the caller's row.

The stubbed OTP lives in exactly one constant (`auth.constants.ts`). Swapping in a
real SMS provider means generating, persisting and comparing a per-request code
there; no other file changes.

## Authorization

`JwtAuthGuard` and `RolesGuard` are registered **globally** via `APP_GUARD`, so
routes are authenticated by default and an endpoint that forgets to think about
auth fails closed. Exemptions are explicit: `@Public()` on login and health.
`@Roles(Role.ADMIN)` restricts the CRUD controllers.

The guard re-reads the user from the database on every request instead of
trusting token claims. Tokens live for days, so without that lookup a
soft-deleted or demoted user would keep their old access until expiry.

## Guardrails

- An admin cannot soft-delete their own account, demote themselves, or set
  themselves inactive. With no signup path, any of those is unrecoverable
  without direct database access.
- Creating a user whose mobile matches a **soft-deleted** row revives that row
  rather than hitting the unique constraint. A duplicate *active* mobile is a
  409.

## Known limitations

- `request-otp` reveals whether a mobile is registered. Acceptable for an
  internal admin tool; revisit before any public exposure.
- JWTs cannot be revoked before expiry. The per-request user lookup covers the
  cases that matter (deletion, demotion); a true revocation list would need a
  session table.
