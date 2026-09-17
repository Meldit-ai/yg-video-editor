# Incremental duplicate detection — design

**Date:** 2026-09-17
**Status:** Implemented (2026-09-17). Four amendments were made during implementation, after checking the engine — see §11.
**Applies to:** editor submissions (`VideoSubmission`) and Instagram reels (`CampaignReel`)

---

## 1. The problem in one paragraph

Today, every time a video lands on a campaign we ask the engine to compare
**every video against every other video** on that campaign. Ten videos is 45
pairs; fifty videos is 1,225 pairs; a hundred is 4,950. Most of that work is
wasted, because once we know video B is a copy of video A, checking a new
video C against B tells us nothing that checking it against A did not already
tell us. This document replaces "everyone against everyone" with "the new one
against the ones that matter".

---

## 2. The idea, in very simple terms

Think of a campaign as a queue of videos standing in the order they arrived.

Every video gets **one of three labels**:

| Label | Plain meaning |
|---|---|
| **UNIQUE** | Nothing that came before it looks like it. It is an original. |
| **PARTIAL** | Something before it looks *a bit* like it, but not enough to call it a copy. It has some new material of its own. |
| **DUPLICATE** | Something before it looks *so much* like it that we call it a copy. It adds nothing new. |

The line between PARTIAL and DUPLICATE is the campaign's **threshold** — a
number from 0 to 100 that the admin sets (default 90). The line between
UNIQUE and PARTIAL is not a number the admin sets: it is 25, the point below
which the engine itself reports no resemblance at all.

Now the one rule that makes everything cheap:

> **A new video is only ever compared against the UNIQUE and PARTIAL videos
> that came before it. DUPLICATEs are skipped.**

We call the UNIQUE + PARTIAL videos the campaign's **baseline**. It is the set
of videos that together contain every piece of footage the campaign has seen
so far. A DUPLICATE, by definition, contains nothing that its original does
not already contain — so comparing against it is pointless.

Why do PARTIALs stay in the baseline? Because a PARTIAL is *partly* new. If
video B shares 40% of its footage with A, the other 60% is footage nobody
else has handed in. A later video C could be a straight copy of that 60%. If
we only compared C against A, we would miss it. Keeping B in the baseline is
what catches it.

### The three questions, in order

For each new video, we ask:

1. **Is there anything in the baseline yet?**
   No → it is **UNIQUE**. Done, no engine call.
2. **How similar is it to the *closest* baseline video?**
   We compare it against every baseline video and keep the *highest* number.
   That number is the video's **match value**, and the baseline video it
   matched is its **parent**.
3. **Where does that number fall?**
   - Match value **≥ threshold** → **DUPLICATE** of its parent.
   - Match value **≥ 25** but **< threshold** → **PARTIAL** of its parent.
   - Match value **< 25** → **UNIQUE**. (The parent is still recorded — see §3.)

That is the whole algorithm. Everything else in this document is about the
edges: what "similar" means precisely, what happens when videos are removed or
the threshold changes, and how it maps onto the code.

---

## 3. What "similar" means precisely

The engine returns two numbers per pair, both 0–100:

- **`score`** — overall similarity.
- **`containment`** — how much of the *shorter* video appears inside the
  longer one. A 10-second clip cut out of a 2-minute video has a modest
  `score` (most of the long video is unmatched) but a `containment` near 100.

A clip lifted wholesale out of an existing video *is* a copy, so the match
value for a pair is:

```
pairValue = max(score, containment)
```

and a video's **match value** is the highest `pairValue` over every baseline
video it was compared against.

The UNIQUE/PARTIAL line is drawn on the match value, at 25 — the engine's
own `NO_MATCH` edge (its bands: `MATCH` ≥ 90, `LIKELY_MATCH` 60–89.9,
`UNCERTAIN` 25–59.9, `NO_MATCH` < 25) — rather than on the verdict string.
The difference matters for a clip that is half-contained in a longer video:
its `score` may be 6 and its verdict `no_match`, but its containment is 50,
and that is a PARTIAL. If an admin sets the threshold *below* 25, the
threshold wins: the PARTIAL band is empty and anything at or above the
threshold is a DUPLICATE. Remember the engine floors `score` at 1.0, so
"1.0" means "no signal", not "1% similar".

**The best match is recorded even for a UNIQUE video.** V3's parent is V1
at 3 — not because V3 copied anything, but because a later threshold edit
below 25 has to be able to re-label from stored values without asking the
engine again. The UI shows a parent only for PARTIAL and DUPLICATE.

### Ordering

"Came before" is decided once and never re-argued:

- **Submissions:** `createdAt` (the moment the upload finished).
- **Reels:** `postedAt` (when it went live on Instagram), then `createdAt` as
  the tie-break. Reels with no `postedAt` sort after every reel that has one.

This is the same "whoever was first is the original" rule the reels check
already uses. The change is only *which* earlier videos we look at.

---

## 4. Detailed example

Campaign **"Summer Launch"**, threshold **90**. Seven videos arrive over a
week. The engine numbers below are `max(score, containment)` for each pair.

### Day 1 — V1 arrives

Baseline is empty. **V1 → UNIQUE.** No engine call.

```
Baseline: [V1]
```

### Day 1 — V2 arrives

Compare V2 against the baseline: one call, `[V2, V1]`.

| vs | value | verdict |
|---|---|---|
| V1 | 96 | MATCH |

Match value 96 ≥ 90. **V2 → DUPLICATE, parent V1.**

```
Baseline: [V1]          (V2 is NOT added)
```

### Day 2 — V3 arrives

Compare V3 against the baseline. The baseline is still just `[V1]`, so one
call, `[V3, V1]`. **V2 is never looked at** — it is a copy of V1, and
anything V3 shares with V2 it also shares with V1.

| vs | value | verdict |
|---|---|---|
| V1 | 3 | NO_MATCH |

Nothing matched. **V3 → UNIQUE.**

```
Baseline: [V1, V3]
```

### Day 3 — V4 arrives

One call, `[V4, V1, V3]`.

| vs | value | verdict |
|---|---|---|
| V1 | 41 | UNCERTAIN |
| V3 | 2 | NO_MATCH |

Highest is 41, which is below 90 but the engine did see a resemblance to V1.
**V4 → PARTIAL, parent V1.** V4 shares some footage with V1 but most of it is
new, so it joins the baseline.

```
Baseline: [V1, V3, V4]
```

### Day 4 — V5 arrives

One call, `[V5, V1, V3, V4]`.

| vs | value | verdict |
|---|---|---|
| V1 | 12 | NO_MATCH |
| V3 | 4 | NO_MATCH |
| V4 | 93 | MATCH |

**V5 → DUPLICATE, parent V4.** This is exactly the case that keeping PARTIALs
in the baseline exists for: V5 copied the part of V4 that V1 does *not*
contain. Had we compared only against UNIQUE videos, V5 would have scored 12
against V1 and been called UNIQUE.

```
Baseline: [V1, V3, V4]
```

### Day 5 — V6 arrives (a short clip)

One call, `[V6, V1, V3, V4]`.

| vs | score | containment | value | verdict |
|---|---|---|---|---|
| V1 | 8 | 5 | 8 | NO_MATCH |
| V3 | 31 | 97 | **97** | UNCERTAIN |
| V4 | 2 | 1 | 2 | NO_MATCH |

V6 is a 12-second cut from the middle of V3's 90 seconds. Its `score` against
V3 is only 31 (most of V3 is not in V6), but its `containment` is 97 — nearly
all of V6 is inside V3. Because we take `max(score, containment)`, the value
is 97. **V6 → DUPLICATE, parent V3.**

```
Baseline: [V1, V3, V4]
```

### Day 6 — V7 arrives

One call, `[V7, V1, V3, V4]`. Nothing matches. **V7 → UNIQUE.**

```
Baseline: [V1, V3, V4, V7]
```

### The campaign after a week

| Video | Label | Parent (stored) | Match value |
|---|---|---|---|
| V1 | UNIQUE | — | 0 |
| V2 | DUPLICATE | V1 | 96 |
| V3 | UNIQUE | V1 (not shown) | 3 |
| V4 | PARTIAL | V1 | 41 |
| V5 | DUPLICATE | V4 | 93 |
| V6 | DUPLICATE | V3 | 97 |
| V7 | UNIQUE | V1 (not shown) | 9 |

**Engine work:** 6 calls, 1+1+2+3+3+4 = **14 pairs**.
The old approach would have compared all 21 pairs, and re-compared all of
them on every single upload (1+3+6+10+15+21 = 56 pair-checks over the week).

### Day 7 — the admin lowers the threshold to 40

No engine call. Every video is re-labelled from its **stored** match value:

| Video | Match value | Old label | New label |
|---|---|---|---|
| V4 | 41 | PARTIAL | **DUPLICATE** (41 ≥ 40) |
| everyone else | — | unchanged | unchanged |

V4 has left the baseline. Note what does **not** happen: V5 (which matched V4)
is not re-checked against the new baseline. Its stored record still says
"DUPLICATE of V4 at 93", which is still true and still useful. The baseline
now being `[V1, V3, V7]` only affects videos that arrive *from now on*. An
admin who wants the whole campaign re-argued under the new threshold presses
**Re-check**, which is a rebuild (below).

### Day 8 — the editor withdraws V1

V1 was UNIQUE and two videos point at it as parent: V2 (DUPLICATE) and V4
(DUPLICATE since day 7).

1. **Promote the oldest dependant.** V2 is older than V4, so V2 steps into
   V1's place. It is classified as if it were the first video after V1 was
   removed: compared against the baseline *without* V1, which is `[V3, V7]`.
   Nothing matches → **V2 → UNIQUE.** (Its previous result against V1 is
   kept as history but no longer decides its label.)
2. **Re-check the remaining dependants in order.** V4 is compared against the
   baseline, which is now `[V2, V3, V7]`. V4 scores 41 against V2 (V2 is a
   copy of V1, so it looks the same). 41 ≥ 40 → **V4 → DUPLICATE, parent V2.**

Videos whose parent was not V1 (V5, V6) are untouched.

```
Baseline: [V2, V3, V7]
```

### Day 9 — the admin presses Re-check (rebuild)

Every active video is replayed in arrival order under the current threshold
(40) as if it were being uploaded for the first time. V2 is first → UNIQUE;
V3 → UNIQUE; V4 → DUPLICATE of V2; V5 → DUPLICATE of… V4 is no longer in the
baseline, and V5 scores 12 against V2 → **V5 becomes UNIQUE**. This is
correct: with the threshold at 40, V4 counts as a copy of V1/V2, and the part
of V4 that V5 copied is now considered footage that nobody "owns". V6 →
DUPLICATE of V3; V7 → UNIQUE.

The rebuild is the only operation that lets a baseline change ripple forward.
It is still cheap: the engine caches fingerprints by URL, so a rebuild
re-downloads and re-hashes nothing — it only recomputes pair scores.

---

## 5. Cost

For a campaign with *n* videos of which *b* are in the baseline (*b* ≤ *n*):

| Event | Old: pairs checked | New: pairs checked | New: engine calls |
|---|---|---|---|
| One upload | n(n−1)/2 | b | ⌈b / (cap−1)⌉ |
| Threshold edit | n(n−1)/2 (if re-run) | **0** | **0** |
| Withdraw a baseline video with *d* dependants | n(n−1)/2 | ≈ d × b | ≈ d × ⌈b / (cap−1)⌉ |
| Rebuild | n(n−1)/2 | Σ over videos of the baseline size at that moment ≤ n·b | ≤ n × ⌈b / (cap−1)⌉ |

The engine's cap is **4 URLs per job** — hard-coded in its request schema,
in both the local checkout and the deployed one (`049e9d5`) — so with the
candidate pinned in every call, 3 baseline videos fit per call. The cap is
read from one place (`engineMaxUrls()`, env `COMPARISON_ENGINE_MAX_URLS`,
default 4) by both paths, so no two callers can disagree about it; confirm
the deployed engine with a 5-URL probe (422 means it is still 4) before
raising it. A 50-video campaign where 30 are DUPLICATEs has a baseline of
20: an upload costs **7 calls and 20 pairs**, versus 45 calls and 1,225
pairs before.

In the worst case (every video UNIQUE, so *b* = *n*) a rebuild is still
O(n²) pairs — but that is the same as the reels check does today and is the
floor for any exact method. What changes is that ordinary uploads are O(b),
and *b* is usually far smaller than *n*, because the whole reason the check
exists is that editors hand in copies.

---

## 6. When labels change

Labels are **assigned once, by arrival order, and revisited only on four
events**. Nothing else touches them.

| Event | What is recomputed | Engine calls |
|---|---|---|
| **New video** (upload, reel import, reel adoption) | Only the new video, against the baseline. | ⌈b/3⌉ per new video |
| **Threshold edit** | Every video's label, from its *stored* match value. Baseline membership may change. Later videos are *not* re-checked. | 0 |
| **Baseline video withdrawn** | Oldest dependant is promoted (classified against the remaining baseline). Other dependants are re-classified in order against the baseline including the promoted one. Non-dependants untouched. | ≈ d × ⌈b/3⌉ |
| **Rebuild** (admin re-check) | Everything, replayed in arrival order. | ≤ n × ⌈b/3⌉ |

Withdrawing a DUPLICATE changes nothing — it was never in the baseline and
nothing points at it.

A **bulk arrival** (reel import of 40 reels, or adopting 5 reels as
submissions) is processed as a sequence of single arrivals in arrival order,
each seeing the baseline as it stands *including the ones before it in the
same batch*. This is what makes an import and a rebuild produce the same
answer.

---

## 7. What the admin and editor see

Nothing new in principle — the label is the missing word for things the UI
already shows:

- The campaign feed's "most original first" ordering is UNIQUE, then
  PARTIAL, then DUPLICATE, then by match value ascending within each group.
- "Duplicate of X" / "Partial of X" reads from the parent id.
- The threshold field on the campaign keeps its meaning: the DUPLICATE line.
- Editor view is unchanged in scope: an editor sees the label and match value
  on **their own** videos; the parent is redacted to "another submission" as
  the pair view already does.
- Reels: `isOriginal` is `label === UNIQUE`; the reel page gains the PARTIAL
  state between "original" and "copy".

---

## 8. Implementation notes

### 8.1 Schema

```prisma
/// Where a video stands against everything that arrived before it.
/// See docs/superpowers/specs/2026-09-17-incremental-duplicate-detection-design.md
enum Uniqueness {
  UNIQUE
  PARTIAL
  DUPLICATE
}
```

On **`VideoSubmission`** and **`CampaignReel`**:

```prisma
  /// Null = not classified yet. Assigned once on arrival, revisited only on a
  /// threshold edit, the withdrawal of the parent, or a rebuild.
  uniqueness Uniqueness?
```

Existing columns are reused, not duplicated:

| Existing column | Meaning under this design |
|---|---|
| `VideoSubmission.duplicationScore` / `CampaignReel.duplicationScore` | The **match value** — highest `max(score, containment)` against the baseline, stored even when it is below the NO_MATCH band (V3 keeps its 3). 0 only when there was nothing to compare against. Was: max `score` against every other video. |
| `VideoSubmission.topMatchSubmissionId` / `CampaignReel.originalReelId` | The **parent**: the best-matching baseline video, set whenever the baseline was non-empty — even for UNIQUE, so a threshold edit below 25 can re-label without the engine. The UI names it only for PARTIAL and DUPLICATE. |
| `VideoSubmission.overThreshold` | Derived: `uniqueness === DUPLICATE`. Kept one release for the feed and dashboard, then removed. Its "frozen on threshold change" comment is retired — labels now follow the threshold. |
| `CampaignReel.isOriginal` | Derived: `uniqueness === UNIQUE`. Same retirement plan. |
| `averageDuplicationScore` | Mean over the *baseline* pairs only. Display-only, as before. |
| `duplicationCheckedAt` / `checkedAt` | Unchanged. |

Indexes: `@@index([campaignId, active, uniqueness])` on both tables, backing
the baseline query (`where uniqueness in (UNIQUE, PARTIAL)`).

`Campaign.duplicationThreshold` is unchanged.

### 8.2 One classifier, two callers

A new `UniquenessService` (or a pure module plus a thin service) owns the
rule. It is deliberately generic over "a thing with an id, a URL and an
arrival time", so submissions and reels share one implementation:

```ts
interface Candidate { id: string; url: string; arrivedAt: Date }

// The only three operations anything outside needs.
classifyArrivals(campaignId, candidates: Candidate[])   // new video(s), in order
reclassifyForThreshold(campaignId)                       // no engine
withdraw(campaignId, id)                                 // promote + re-check
rebuild(campaignId)                                      // replay all
```

Internally:

1. **Load the baseline** — active rows on the campaign with
   `uniqueness IN (UNIQUE, PARTIAL)`, ordered by arrival.
2. **Plan pinned calls** — `[candidate, ...slice of cap−1 baseline]`
   (`planPinnedCalls`). Pairs not involving the candidate are discarded
   (`matchesOf`). A baseline video with the candidate's own URL cannot be
   sent (the engine refuses a repeated URL) and is scored as a perfect match
   instead. This replaced `planBatches`, the overlapping-blocks planner.
3. **Score** — for each returned pair with the candidate on one side,
   `value = max(score, containment)`; keep the highest, and whether *any*
   pair's verdict was not `NO_MATCH`.
4. **Label** — as in §2 step 3.
5. **Write** — `uniqueness`, `duplicationScore`, parent id, mean, checked-at,
   and the derived boolean, in one update. Written per candidate, not at the
   end, so a long import shows progress.

Execution is sequential and awaited — submit, poll to terminal, next call —
inside an in-process promise queue keyed by `kind:campaignId`. Arrival,
withdrawal and rebuild all run the same `classifyPending` loop. Restart
safety comes from the rows: a pending row is the durable work queue, and boot
marks live run rows failed and re-enqueues every campaign with pending rows.
The engine queue back-off (retry on `engine_busy`) moved into the client as
`submitWithBackoff`, beside `waitForJob`.

### 8.3 Hook points

| Where | Today | After |
|---|---|---|
| `SubmissionsService.create` → `ComparisonsService.triggerAfterUpload` | full-matrix run | `classifyArrivals(campaignId, [newSubmission])`, fire-and-forget as now |
| `SubmissionsService.remove` | nothing | `withdraw(campaignId, id)` if the row was UNIQUE or PARTIAL |
| `ReelAdoptService` (after copying bytes) → `runForCampaign` | full-matrix run | `classifyArrivals` over the adopted rows, in reel order |
| `ReelsService` import | nothing (admin presses Check) | `classifyArrivals` over *new* reels only, in `postedAt` order. Re-ingested reels that already have a label are skipped. |
| `CampaignsService.update` with a changed `duplicationThreshold` | nothing | `reclassifyForThreshold(campaignId)` — inside the same transaction, it is a pure DB update |
| `POST /api/campaigns/:id/comparisons` (admin re-run) | full-matrix run | `rebuild(campaignId)` |
| `POST /api/campaigns/:id/reels/check` | against-all-earlier check | `rebuild(campaignId)` for reels |
| Reel deactivation on re-ingest (post left the tracker feed) | nothing | `withdraw` if it was in the baseline |

### 8.4 The audit trail

`VideoComparison` / `VideoComparisonJob` / `VideoComparisonEntry` /
`VideoComparisonPair` stay. Each engine call still produces a job row (the
candidate first in `submissionIds`) and the candidate's pairs, so the pair
detail view and evidence JSON keep working. What changes is the *shape* of a
run: **one run per classification batch**, not per candidate. An upload is a
batch of one, with `triggerSubmissionId` set and `pairsTotal` = the baseline
size; a bulk arrival, a withdrawal re-check or a rebuild is one run with
live `pairsDone`/`pairsTotal`, which is what keeps the pages' "poll while the
latest run is live" logic working. Reels get one `ReelMatchRun` per batch
(with a new `triggerReelId`) and no pair rows: the existing `ReelMatchJob`
and `ReelMatchPair` tables model a submission against reels and are left
alone.

`ComparisonsService.toDto`'s role scoping (editor sees own videos only,
counterpart redacted) is unchanged.

### 8.5 Rebuild is idempotent with arrival

The rebuild must produce **exactly** what a sequence of arrivals would have
produced. The way to guarantee that is to make it literally that: `rebuild`
clears every label on the campaign, then calls `classifyArrivals` with every
active video in arrival order. No second code path.

### 8.6 Withdrawal, precisely

```
withdraw(campaignId, id):
  row = the withdrawn video
  if row.uniqueness not in (UNIQUE, PARTIAL): return     // was never a parent
  dependants = active rows whose parent == id, ordered by arrival
  if dependants empty: return
  // Promote: the oldest dependant is classified against the baseline
  // *without* the withdrawn row. The baseline query already excludes it
  // because the row is now active = false.
  classifyArrivals(campaignId, [dependants[0]])
  // The rest see the promoted one as part of the baseline.
  classifyArrivals(campaignId, dependants[1..])
```

`classifyArrivals` processes its list in order and re-reads the baseline
before each candidate, so the two calls above could be one; they are shown
separately only to make the promotion visible.

### 8.7 Migration of existing data

A data migration sets `uniqueness = null` everywhere (the column default) and
then runs `rebuild` for every active campaign that has ≥ 1 checked video.
Because the engine caches fingerprints by URL, this costs pair computation
only, not re-ingestion. Run it as a one-off script after deploy, not inside
the Prisma migration.

### 8.8 Tests

Unit tests on the pure classifier — given a candidate's pairs and a
threshold, assert the label, match value and parent. Cases that must exist,
straight from the example in §4:

- Empty baseline → UNIQUE, no engine call.
- Value ≥ threshold → DUPLICATE (including *exactly* at the threshold).
- Verdict not NO_MATCH but below threshold → PARTIAL.
- All pairs NO_MATCH → UNIQUE even if the raw score is > 0.
- `containment` alone lifting a pair over the threshold (V6).
- Highest pair wins the parent, not the first one returned.
- A DUPLICATE is not in the baseline for the next candidate (V3 never sees V2).
- A PARTIAL *is* in the baseline (V5 caught via V4).
- Threshold edit re-labels from stored values and calls the engine zero times.
- Withdrawal promotes the oldest dependant and re-checks the rest in order.
- Rebuild after the sequence in §4 reproduces the same table.
- Bulk arrival of [A, B, B-copy] labels B-copy DUPLICATE of B, not UNIQUE.

Service tests cover the hook points with the engine client mocked, as
`comparisons.service.spec.ts` does now.

---

## 9. Decisions made, and why

| Decision | Alternative rejected | Reason |
|---|---|---|
| One threshold, on similarity | Two thresholds (unique/partial line as well) | The engine already has a "no resemblance" verdict; a second admin number would be one more thing to explain. |
| PARTIALs stay in the baseline | UNIQUE-only baseline | A partial's new footage is real; a later copy of *that* footage would be missed. Costs a slightly larger baseline. |
| Highest single pair decides | Aggregate across several baseline videos | The engine gives no combined number; "stitched from three sources" is out of scope. |
| `max(score, containment)` | Score only | A clip lifted from a longer video is a copy; score alone calls it partial. |
| Threshold edit re-labels from stored values | Keep labels frozen (current `overThreshold` behaviour) | Admins move the threshold *because* they want the classification to change. The stored match value makes this free. |
| Threshold edit does **not** ripple forward | Rebuild on every edit | Ripple = rebuild; make it an explicit button, not a side-effect of a form field. |
| Withdrawal promotes oldest dependant | Leave dependants pointing at a withdrawn parent | "Duplicate of a video that no longer exists" is not a useful thing to show. First-come stays fair. |
| Rebuild is literally a replay of arrivals | Separate rebuild algorithm | Two code paths would drift; one path cannot. |
| Same rule for reels | Submissions only | Reels already use first-posted-is-original; the baseline is the natural next step, and one classifier is less code than two. |

---

## 10. Known approximation

`duplicationScore` is now measured against the baseline, not against every
video. A video that copies a DUPLICATE will be scored against that
duplicate's *parent* instead of the duplicate itself. Because a DUPLICATE is,
by the threshold's own definition, nearly the same as its parent, the score
will be nearly the same too — but it can differ by a few points, and the
parent shown will be the original rather than the intermediate copy. That is
the intended reading ("this is a copy of V1"), not a bug.

The one case where this loses real information is a *chain*: V2 is a
DUPLICATE of V1 at exactly the threshold, V3 is a DUPLICATE of V2 at exactly
the threshold, but V3 against V1 falls just below. V3 would be labelled
PARTIAL of V1 rather than DUPLICATE of V2. Accepted: the threshold is a line,
and something two steps removed from the original landing just under it is a
defensible answer. A lower threshold closes the gap.

---

## 11. Amendments made during implementation

Checked against the engine repo and the deployed engine before coding:

1. **Cap is 4, not 10.** The engine hard-codes 2–4 URLs per job. The API's
   reels check had been sending 10, which the engine answers with 422. One
   env-driven cap (`COMPARISON_ENGINE_MAX_URLS`, default 4) now serves both
   paths; §5 and §6 were corrected from ⌈b/9⌉ to ⌈b/3⌉.
2. **UNIQUE/PARTIAL line = match value ≥ 25**, not "verdict ≠ NO_MATCH"
   (§2, §3). A half-contained clip with a low score is a PARTIAL.
3. **Best match stored even for UNIQUE** (§3, §8.1), so a threshold edit
   below 25 re-labels with zero engine calls.
4. **One run row per batch**, not per candidate (§8.4).

Two things the implementation surfaced that the design did not cover:

- Rows scored by the old all-pairs run carry a `duplicationCheckedAt` with no
  label, which the four-state model reads as *unreadable*, so the boot sweep
  leaves them alone. `apps/api/src/scripts/backfill-uniqueness.ts` rebuilds
  every campaign once to label them.
- The web derived each card's state from membership in the latest run.
  Under one-batch runs most cards are not in the latest run, so
  `use-comparison.ts` now reads the label from the submission row and uses
  the run's pairs only as supporting evidence.
