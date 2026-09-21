# Engine callback — design

**Date:** 2026-09-21
**Status:** Implemented (2026-09-21)
**Applies to:** `ComparisonEngineClient.waitForJob`, `EngineCallbackController`, `EngineJobNotifications`

---

## 1. Context / problem

`ComparisonEngineClient.waitForJob` learns a comparison's outcome by polling
`GET /v1/jobs/:id` — fast at first, slower once the job is clearly not a
quick one. That is a socket held open in a loop for as long as the engine
takes, and it means the editor never learns a result sooner than its next
poll tick. It works, but every classification pass pays polling latency it
does not need to, and every poll of a job that is still running is a wasted
round trip.

The engine can instead be handed a URL and asked to call back when a job
settles. That turns the relationship around: the editor learns the moment
the engine knows, and polling becomes a safety net rather than the only
mechanism. The trade is a new, unauthenticated, internet-facing endpoint —
the engine has no user token, so something other than a bearer header has to
prove a callback is genuine.

---

## 2. Decisions

- **The callback body is the full job document**, the same shape `GET
  /v1/jobs/:id` returns, not a bare "job N is done" ping. The client already
  knows how to parse a job document (`parseJob`); reusing it means the
  callback and the poll path share one parser and one idea of what a
  finished job looks like. It also means a callback that arrives is
  immediately usable without a confirming fetch.
- **A 60/120/180 s jittered fallback poll**, capped at 4 in flight
  (`FALLBACK_POLLS`), keeps running underneath every callback-mode wait. It
  is deliberately far sparser than the old poll cadence — a callback through
  a healthy tunnel lands within a second of the job settling, so a job still
  running at the first check is a long fingerprint, not a lost callback.
  The schedule's last entry repeats for as long as the job runs.
- **Opt-in via `API_PUBLIC_URL`.** Unset, nothing about `submit` or
  `waitForJob` changes — no `callback_url` is sent, and the client polls
  exactly as it always has. This keeps every environment without a stable
  public origin (a laptop with no tunnel running) working unmodified, and
  makes turning callback mode on or off a config change, not a deploy.
- **A retry ceiling on the engine's side is out of scope for the editor.**
  The editor cannot make the engine retry more or less; it only has to
  tolerate however many callback attempts show up (zero or several) and
  keep the fallback poll as the thing that is true regardless.

---

## 3. Wire protocol

### Request: `POST /v1/compare`

When `API_PUBLIC_URL` is set, `submit` adds one field to the existing
request body:

```json
{ "urls": ["...", "..."], "callback_url": "https://<public-origin>/api/comparisons/engine-callback" }
```

Absent, the engine's behaviour is unchanged (poll-only).

### Callback: `POST /api/comparisons/engine-callback`

**Headers** — `X-Engine-Signature: t=<unix-seconds>,v1=<hex hmac-sha256>`,
covering `"<t>." + <raw body bytes>` under the shared secret
(`COMPARISON_ENGINE_CALLBACK_SECRET` here, `CALLBACK_SECRET` on the engine).
Verified against the raw bytes, before JSON parsing — see
`engine-callback.signature.ts`. A timestamp more than 300 s from now, in
either direction, is refused, which bounds how long a captured request could
be replayed.

**Body** — the full job document (same shape as `GET /v1/jobs/:id`),
`Content-Type: application/json`, at most 2 MB.

**Ack** — `200 { "received": true, "outcome": "resolved" | "buffered" }` on
success. Any other status, or a 2xx whose body is not exactly this shape, is
a hard failure from the engine's point of view — there is no "partial
success" reading of this endpoint.

### Engine ack classification and backoff

The engine classifies its own callback attempt as successful only on a 2xx
whose body is `{"received": true, ...}`. Every other outcome is either
retried or terminal — never a third thing:

| | Outcomes | Behaviour |
| --- | --- | --- |
| **Retried** | 5xx, 408, 425, 429, a transport error (timeout, connection failure) | Backoff `(2, 5, 15, 45, 120, 300) s`, each jittered `×(0.8–1.2)`, for up to **7 attempts** total (the initial attempt plus the six backoff delays above). |
| **Terminal — no retry** | Any other 4xx (including a 401 from a bad signature), a 3xx (never followed), a 2xx without the `{"received": true}` body | The engine gives up on this callback for good; nothing more arrives for this job. |

A tunnel that is down for the first minute but recovers by the second is
still caught by the retry window above. A terminal outcome — a wrong shared
secret, a stale `API_PUBLIC_URL` pointing at a redirect or a 404, or any
other non-retryable response — means the callback is never delivered, and
the job is recovered by the editor's own fallback poll instead (§5).

---

## 4. Editor components

- **`EngineJobNotifications`** (`src/comparisons/engine-job-notifications.ts`)
  — the in-process registry the callback and the waiting request hand off
  through. `notify(jobId, payload)` resolves a live waiter or, if none is
  registered yet, buffers the payload for up to ten minutes
  (`EARLY_NOTIFICATION_TTL_MS`) — closing the real race where a sub-second
  cache-warm job's callback can beat the client's own `submit` response back
  to this process. `waitFor` checks the buffer before registering, so
  whichever side runs first still hands off correctly. Provided once, in
  `UniquenessModule`, and exported to both `ComparisonEngineClient` (which
  calls `waitFor`/`forget`) and `EngineCallbackController` (which calls
  `notify`) — one shared instance is the entire point; two would each see
  only half of every race.
- **`EngineCallbackController`** (`src/comparisons/engine-callback.controller.ts`)
  — `@Public()`, since the engine carries no user token. Reads
  `COMPARISON_ENGINE_CALLBACK_SECRET` fresh per request (503 naming it while
  unset), verifies the raw bytes, parses, requires a string `job_id`, then
  calls `notify` and returns its outcome. Lives on its own class rather than
  on `ComparisonsController`, which carries a `campaigns/:campaignId/…`
  prefix and `CampaignAccessGuard` that make no sense for a
  campaign-agnostic, HMAC-authenticated route.
- **`ComparisonEngineClient.waitForJob`** — with `API_PUBLIC_URL` set, races
  `awaitNotification` (waits on the registry, re-fetching only if a
  notification arrives that will not parse as a job) against `pollSparsely`
  (§2). Whichever settles first wins; the loser is aborted and the
  registry's entry for that job is forgotten in a `finally`, so a job is
  never left with a dangling waiter.

---

## 5. Failure handling

| Scenario | What happens |
|---|---|
| **Lost callback** (tunnel blips, one request dropped) | `pollSparsely` is running the whole time regardless of the engine's own retries; the job is picked up at the next 60/120/180 s tick. |
| **Engine restarts → janitor + resumed callback** | The engine is one process; a restart means every job it had in memory is gone. Its own startup janitor marks every job that was still running (no `finished_at` yet) failed at once, rather than the client waiting out the full job timeout for an answer that will never come — the fallback poll sees that failure on its next tick. Separately, a job that had already *finished* but whose callback delivery had not completed is resumed from its persisted delivery state (attempts so far, `pending`), so that callback still arrives, just later than usual. |
| **Editor restarts while a job is in flight** | The in-memory registry is gone — the original `waitFor` and its caller no longer exist. A callback that lands afterward finds no waiter, is buffered under `EngineJobNotifications`' early-notification path, and is pruned after ten minutes since nothing will ever collect it. The request that started the job is itself gone; nothing in the editor still needs that answer. |
| **Tunnel down for the engine's whole retry window** | The engine gives up on the callback once its `callback_max_attempts` budget is spent (its own concern, out of scope here — §2). The job itself is unaffected; the fallback poll is what actually recovers the result once the tunnel — or just `GET /v1/jobs/:id` — is reachable again. |

In every case above, correctness never depends on the callback arriving —
only latency does. That is the property callback mode is designed to have:
it can be silently absent for one job, all jobs, or forever, and the classifier
still finishes, just on the poll cadence instead of the callback's.

---

## 6. Rollout

1. **Engine first.** Deploy the engine version that accepts `callback_url`
   and attempts delivery, while every editor environment still has
   `API_PUBLIC_URL` unset. No `callback_url` is ever sent, so this step
   changes nothing observable — it only makes the capability available.
2. **Then env.** Once a stable public origin exists for an environment (a
   dev tunnel, or a real public host later), set `API_PUBLIC_URL` and
   `COMPARISON_ENGINE_CALLBACK_SECRET` (matching the engine's
   `CALLBACK_SECRET`) there. Callback mode turns on for that environment
   alone, with no code change and no redeploy — flipping it back off is the
   same env edit in reverse.
