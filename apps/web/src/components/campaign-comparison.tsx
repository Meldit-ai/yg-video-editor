import { useState } from "react"
import {
  ChevronRightIcon,
  CircleDashedIcon,
  CopyCheckIcon,
  CornerDownRightIcon,
  Loader2Icon,
  RotateCwIcon,
  ScanSearchIcon,
  ShieldCheckIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { toast } from "sonner"

import { EmptyState } from "@/components/empty-state"
import { MetaDivider } from "@/components/page-header"
import {
  ComparisonVerdictBadge,
  UniquenessBadge,
} from "@/components/status-badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { errorMessage } from "@/hooks/use-collection"
import type { ComparisonState, SubmissionCheck } from "@/hooks/use-comparison"
import { scrollToSubmission } from "@/lib/scroll-to-submission"
import { fileSize, fullDate, relativeTime } from "@/lib/format"
import type {
  Comparison,
  ComparisonEvidence,
  ComparisonGroup,
  ComparisonPair,
  ComparisonVideo,
  VideoSubmission,
} from "@/lib/types"
import { cn } from "@/lib/utils"

const SECTION_LABEL =
  "text-[11px] font-medium tracking-wide text-muted-foreground uppercase"

/**
 * The score as a percentage — "64.4%".
 *
 * The engine's score is already 0-100, so this is a presentation choice, not
 * a conversion: "64.4 out of 100" reads like a mark out of a hundred, while a
 * percentage reads as "how alike these two are", which is what it means.
 *
 * One decimal, because the difference between 89.4 and 90.1 is the difference
 * between "likely duplicate" and "duplicate" — rounding it away would make
 * the badge beside it look arbitrary.
 */
function score(value: number): string {
  return `${value.toFixed(1)}%`
}

/**
 * What the headline number means, for the tooltip.
 *
 * Worth spelling out because a second percentage — containment — sits a few
 * pixels away and answers a different question.
 */
const SCORE_HINT =
  "How alike the two videos are overall. Containment is a different measure: how much of one appears inside the other."

/** "0:28", "1:04:12" — a video length, not a duration between two dates. */
function clock(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "—"
  const whole = Math.round(seconds)
  const parts = [Math.floor(whole / 60) % 60, whole % 60]
  if (whole >= 3600) parts.unshift(Math.floor(whole / 3600))
  return parts
    .map((part, index) => (index === 0 ? part : String(part).padStart(2, "0")))
    .join(":")
}

/** "62%" from the engine's 0–1 fractions. */
function percent(fraction: number | undefined): string {
  return fraction === undefined || !Number.isFinite(fraction)
    ? "—"
    : `${Math.round(fraction * 100)}%`
}

interface CampaignComparisonProps {
  state: ComparisonState
  /** False while fewer than two videos exist — there is no pair to compare. */
  canRun: boolean
  /**
   * The pair whose evidence is open, owned by the parent so a submission card
   * and this panel open the same dialog rather than one each.
   */
  openPair: ComparisonPair | null
  onOpenPair: (pair: ComparisonPair | null) => void
}

/**
 * The duplicate-check panel on the campaign page.
 *
 * Only admins ever see this, and that is a privacy line rather than a
 * permissions one: a result is inherently about *other* editors' work, and
 * editors are not shown each other's cuts anywhere else. The API enforces it;
 * this component simply is not rendered for them.
 *
 * The panel answers three questions in order of how much they matter — is a
 * check running, which videos look like the same cut, and what did each pair
 * actually score. The evidence behind a pair is one click away rather than on
 * the page, because it is diagnostic detail and reading it is the exception.
 */
export function CampaignComparison({
  state,
  canRun,
  openPair,
  onOpenPair,
}: CampaignComparisonProps) {
  const {
    comparison,
    isLoading,
    error,
    isRunning,
    isStarting,
    run,
    refetch,
    videoById,
  } = state
  const [showAllPairs, setShowAllPairs] = useState(false)
  const reduceMotion = useReducedMotion()

  async function start() {
    try {
      await run()
    } catch (caught) {
      toast.error(errorMessage(caught))
    }
  }

  const runButton = (
    <Button
      size="sm"
      variant="outline"
      disabled={!canRun || isStarting || isRunning}
      onClick={() => void start()}
    >
      {isStarting || isRunning ? <Loader2Icon className="animate-spin" /> : <ScanSearchIcon />}
      {comparison === null ? "Check everything" : "Re-check everything"}
    </Button>
  )

  return (
    <section className="panel-sheen space-y-3 rounded-lg border bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <p className={SECTION_LABEL}>Duplicate check</p>
          {comparison !== null && !isRunning && (
            <span className="numeric truncate text-[11px] text-muted-foreground">
              {comparison.videoCount} videos ·{" "}
              <span title={fullDate(comparison.completedAt ?? comparison.createdAt)}>
                {relativeTime(comparison.completedAt ?? comparison.createdAt)}
              </span>
            </span>
          )}
        </div>
        {runButton}
      </div>

      {isLoading && comparison === null ? (
        <div className="space-y-2 py-2">
          <Skeleton className="h-3 w-[220px]" />
          <Skeleton className="h-3 w-[160px]" />
        </div>
      ) : error !== null ? (
        <EmptyState
          icon={TriangleAlertIcon}
          title="Could not load the duplicate check"
          description={error}
          action={
            <Button variant="outline" size="sm" onClick={() => void refetch()}>
              <RotateCwIcon />
              Try again
            </Button>
          }
          className="py-8"
        />
      ) : comparison === null ? (
        <EmptyState
          icon={ScanSearchIcon}
          title={canRun ? "Not checked yet" : "Nothing to compare yet"}
          description={
            canRun
              ? "Label every submitted video against the ones uploaded before it, to find re-uploads and re-cuts of the same footage. Uploads are checked as they land; this replays the whole campaign."
              : "A check needs at least two submitted videos. The next upload starts one automatically."
          }
          action={canRun ? runButton : undefined}
          className="py-8"
        />
      ) : (
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={`${comparison.id}:${comparison.status}`}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: reduceMotion ? 0 : 0.15, ease: "easeOut" }}
            className="space-y-3"
          >
            <ComparisonBody
              comparison={comparison}
              videoById={videoById}
              showAllPairs={showAllPairs}
              onToggleAllPairs={() => setShowAllPairs((shown) => !shown)}
              onOpenPair={onOpenPair}
              onRetry={() => void start()}
              canRun={canRun}
            />
          </motion.div>
        </AnimatePresence>
      )}

      <PairDetailDialog
        pair={openPair}
        videoById={videoById}
        onClose={() => onOpenPair(null)}
      />
    </section>
  )
}

/**
 * Holds the last value a dialog was given, so its contents survive the close.
 *
 * Radix keeps DialogContent mounted through its exit animation and removes it
 * on `animationend`. Emptying that content the moment the dialog closes —
 * which is what a plain `{value !== null && ...}` does — re-renders the node
 * mid-animation, the end event is never delivered for the animation Radix is
 * waiting on, and a bare box with a lone Close button is left on screen for
 * good. Keeping the payload rendered lets the animation finish and the node
 * unmount as intended.
 *
 * The state update happens during render on purpose: an effect would show one
 * frame of the *previous* dialog's contents when a new one opens.
 *
 * `key` is what identity means here, and it is not optional. The values these
 * dialogs are given are rebuilt on every render — a fresh object per poll —
 * so comparing them by reference would set state on every render and loop
 * forever.
 */
function useHeldWhileClosing<T>(value: T | null, key: string | null): T | null {
  const [held, setHeld] = useState<{ key: string; value: T } | null>(
    value !== null && key !== null ? { key, value } : null,
  )
  if (value !== null && key !== null && held?.key !== key) {
    setHeld({ key, value })
  }
  // Live while open, last-captured while closing.
  return value ?? held?.value ?? null
}

/** One line under a video card, shared by every branch below. */
const CHECK_ROW =
  "flex items-center gap-2 border-t px-3 py-1.5 text-[11px] leading-tight"

/** Added when that line opens the full result, so it reads as a target. */
const CHECK_ROW_INTERACTIVE =
  "w-full text-left transition-colors outline-none hover:bg-accent/40 focus-visible:bg-accent/40"

/**
 * What the duplicate check says about the video on this card.
 *
 * The card is where an admin already is when they wonder about a video, so it
 * states its own position rather than making them map it onto the panel
 * below. Every branch is a distinct fact: "not checked yet", "could not be
 * read" and "no duplicates" would otherwise all look like an absence of news,
 * and only the last one means the video is clear.
 *
 * Matches drill into the same evidence dialog the panel opens — one dialog,
 * two ways in.
 */
export function SubmissionCheckStrip({
  check,
  onOpenResult,
}: {
  check: SubmissionCheck
  /** Opens the full result for this video. */
  onOpenResult: () => void
}) {
  if (check.kind === "none") {
    return (
      <div className={cn(CHECK_ROW, "text-muted-foreground")}>
        <CircleDashedIcon className="size-3 shrink-0" />
        Waiting to be checked for duplicates
      </div>
    )
  }

  if (check.kind === "running") {
    return (
      <div className={cn(CHECK_ROW, "text-muted-foreground")}>
        <Loader2Icon className="size-3 shrink-0 animate-spin" />
        Checking for duplicates…
        {check.pairsTotal > 0 && (
          <span className="numeric ml-auto shrink-0">
            {check.pairsDone}/{check.pairsTotal} pairs
          </span>
        )}
      </div>
    )
  }

  if (check.kind === "failed") {
    return (
      <div
        className={cn(CHECK_ROW, "text-muted-foreground")}
        title={check.message}
      >
        <TriangleAlertIcon className="size-3 shrink-0" />
        <span className="min-w-0 truncate">
          Duplicate check failed — {check.message}
        </span>
      </div>
    )
  }

  if (check.kind === "unreadable") {
    return (
      <button
        type="button"
        onClick={onOpenResult}
        className={cn(CHECK_ROW, CHECK_ROW_INTERACTIVE, "bg-warning/5 text-warning")}
      >
        <TriangleAlertIcon className="size-3 shrink-0" />
        {/* Not the same as "no duplicates": this one was never in a pair. */}
        <span className="min-w-0 truncate">
          The engine could not read this file — it was not compared
        </span>
        <CheckedAt at={check.checkedAt} />
      </button>
    )
  }

  if (check.kind === "clean") {
    return (
      <button
        type="button"
        onClick={onOpenResult}
        className={cn(CHECK_ROW, CHECK_ROW_INTERACTIVE, "text-muted-foreground")}
      >
        <ShieldCheckIcon className="size-3 shrink-0 text-success" />
        <span className="min-w-0 truncate">
          Unique
          {check.comparedWith !== null &&
            check.comparedWith > 0 &&
            ` · compared with ${check.comparedWith} other video${check.comparedWith === 1 ? "" : "s"}`}
        </span>
        <span className="numeric ml-auto shrink-0">
          {clock(check.durationSeconds)}
        </span>
        <CheckedAt at={check.checkedAt} className="ml-0" />
      </button>
    )
  }

  return (
    <div className="border-t bg-destructive/[0.05]">
      {/* The whole headline is the target, not just the badge: it is the line
          a reader points at when they want the rest of the answer. */}
      <button
        type="button"
        onClick={onOpenResult}
        aria-label="Show the full duplicate-check result for this video"
        className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-left transition-colors outline-none hover:bg-accent/40 focus-visible:bg-accent/40"
      >
        <UniquenessBadge uniqueness={check.uniqueness} />
        <span className="numeric text-[13px] font-medium" title={SCORE_HINT}>
          {score(check.topScore)} match
        </span>
        {/* The clip-inside-source signal, easy to miss behind a modest score. */}
        {check.topContainment !== null &&
          check.topContainment >= 80 &&
          check.uniqueness !== "DUPLICATE" && (
            <span className="numeric text-[11px] text-warning">
              {score(check.topContainment)} contained
            </span>
          )}
        <span className="numeric ml-auto shrink-0 text-[11px] text-muted-foreground">
          {clock(check.durationSeconds)}
        </span>
        <CheckedAt at={check.checkedAt} className="ml-0" />
        <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground" />
      </button>

      <ul className="pb-1.5">
        {/* The pairs live in the run that labelled this video. When the
            latest run is a later upload's, the row still knows its parent. */}
        {check.matches.length === 0 && (
          <li className="flex items-center gap-1 pr-2">
            <button
              type="button"
              onClick={onOpenResult}
              className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1 text-left text-[11px] transition-colors outline-none hover:bg-accent/50 focus-visible:bg-accent/50"
            >
              <CornerDownRightIcon className="size-3 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">
                {check.parent?.fileName ?? "Another submission"}
                {check.parent !== null && (
                  <span className="text-muted-foreground">
                    {" · "}
                    {check.parent.editorName}
                    <span className="numeric">
                      {" · "}
                      {relativeTime(check.parent.createdAt)}
                    </span>
                  </span>
                )}
              </span>
              <span className="numeric shrink-0">{score(check.topScore)}</span>
              <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground" />
            </button>
            {/* Separate from the row above, which opens the evidence. This
                answers the other question the row raises — which card is it? */}
            {check.parent !== null && (
              <button
                type="button"
                onClick={() => {
                  // An editor's list holds only their own videos, so a parent
                  // belonging to someone else has no card here. Say so rather
                  // than letting the click do nothing.
                  if (!scrollToSubmission(check.parent!.id)) {
                    toast.info("That video is not on screen", {
                      description:
                        "A filter may be hiding it, or it was handed in by someone whose work you cannot see.",
                    })
                  }
                }}
                title={`Show ${check.parent.fileName}`}
                className="shrink-0 rounded px-1.5 py-1 text-[11px] text-muted-foreground transition-colors outline-none hover:bg-accent/50 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                Show
              </button>
            )}
          </li>
        )}
        {check.matches.map(({ pair, other }) => (
          <li key={pair.id} className="flex items-center gap-1 pr-2">
            <button
              type="button"
              onClick={onOpenResult}
              className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1 text-left text-[11px] transition-colors outline-none hover:bg-accent/50 focus-visible:bg-accent/50"
            >
              <CornerDownRightIcon className="size-3 shrink-0 text-muted-foreground" />
              {/* The upload time is what tells two matches apart when they
                  share a file name — which is the norm for a re-upload. */}
              <span className="min-w-0 flex-1 truncate">
                {other?.fileName ?? "Removed video"}
                <span className="text-muted-foreground">
                  {" · "}
                  {other?.editorName ?? "Unknown editor"}
                  {/* Epoch marks a counterpart the API redacted for an
                      editor — there is no upload time to show, because there
                      is no video being named. */}
                  {other !== null && Date.parse(other.submittedAt) > 0 && (
                    <span className="numeric">
                      {" · "}
                      {relativeTime(other.submittedAt)}
                    </span>
                  )}
                </span>
              </span>
              <span className="numeric shrink-0">{score(pair.score)}</span>
              <ComparisonVerdictBadge verdict={pair.verdict} compact />
              <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground" />
            </button>
            {/* The same jump the no-pairs row offers. Without it here, "Show"
                appeared on some duplicates and not others — and this is the
                commoner branch, so it looked arbitrary.

                An epoch upload time marks a counterpart the API redacted for
                an editor: there is no card to jump to, because the video is
                not theirs and is not on the page. */}
            {other !== null && Date.parse(other.submittedAt) > 0 && (
              <button
                type="button"
                onClick={() => {
                  if (!scrollToSubmission(other.submissionId)) {
                    toast.info("That video is not on screen", {
                      description:
                        "A filter may be hiding it, or it was handed in by someone whose work you cannot see.",
                    })
                  }
                }}
                title={`Show ${other.fileName}`}
                className="shrink-0 rounded px-1.5 py-1 text-[11px] text-muted-foreground transition-colors outline-none hover:bg-accent/50 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                Show
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * When the run behind this verdict finished. The word is not decoration: a
 * bare relative time sitting beside a running time reads as another duration.
 */
function CheckedAt({ at, className }: { at: string; className?: string }) {
  return (
    <span
      className={cn(
        "numeric ml-auto shrink-0 text-[11px] text-muted-foreground",
        className,
      )}
      title={fullDate(at)}
    >
      checked {relativeTime(at)}
    </span>
  )
}

/** The panel's contents once a run exists — one branch per terminal state. */
function ComparisonBody({
  comparison,
  videoById,
  showAllPairs,
  onToggleAllPairs,
  onOpenPair,
  onRetry,
  canRun,
}: {
  comparison: Comparison
  videoById: Map<string, ComparisonVideo>
  showAllPairs: boolean
  onToggleAllPairs: () => void
  onOpenPair: (pair: ComparisonPair) => void
  onRetry: () => void
  canRun: boolean
}) {
  if (comparison.status === "QUEUED" || comparison.status === "RUNNING") {
    return <RunProgress comparison={comparison} />
  }

  if (comparison.status === "FAILED" || comparison.status === "TIMEOUT") {
    return (
      <EmptyState
        icon={TriangleAlertIcon}
        title={
          comparison.status === "TIMEOUT"
            ? "The check timed out"
            : "The check could not run"
        }
        description={
          comparison.errorMessage ??
          "The comparison engine did not return a result."
        }
        action={
          canRun ? (
            <Button variant="outline" size="sm" onClick={onRetry}>
              <RotateCwIcon />
              Try again
            </Button>
          ) : undefined
        }
        className="py-8"
      />
    )
  }

  if (comparison.status === "SUPERSEDED") {
    // Only reachable if the newer run has not been written yet; the poll that
    // follows replaces this within a few seconds.
    return (
      <p className="py-2 text-[13px] text-muted-foreground">
        Replaced by a newer check, which is starting now.
      </p>
    )
  }

  return (
    <Results
      comparison={comparison}
      videoById={videoById}
      showAllPairs={showAllPairs}
      onToggleAllPairs={onToggleAllPairs}
      onOpenPair={onOpenPair}
    />
  )
}

/**
 * A run in flight.
 *
 * The bar tracks pairs, not videos, because pairs are what the time is spent
 * on — and the denominator is known before the engine reports one, since the
 * pair count follows from the video count.
 */
function RunProgress({ comparison }: { comparison: Comparison }) {
  const { pairsDone, pairsTotal, stage } = comparison
  const done = pairsTotal > 0 ? Math.round((pairsDone / pairsTotal) * 100) : 0

  const STAGE_LABEL: Record<string, string> = {
    resolving: "Reading the videos",
    preparing: "Decoding and normalising",
    comparing: "Comparing every pair",
    done: "Finishing up",
  }

  return (
    <div className="space-y-2 rounded-lg border bg-muted/20 p-3">
      <div className="flex items-center gap-2 text-[13px]">
        <Loader2Icon className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        <span className="truncate font-medium">
          {stage === null
            ? "Queued"
            : (STAGE_LABEL[stage] ?? "Comparing every pair")}
        </span>
        <span className="numeric ml-auto shrink-0 text-muted-foreground">
          {pairsTotal > 0 ? `${pairsDone}/${pairsTotal} pairs` : `${comparison.videoCount} videos`}
        </span>
      </div>

      {/* Indeterminate until the engine has resolved the inputs — a bar sitting
          at 0% through a two-minute download reads as stuck. */}
      <Progress
        value={stage === null || stage === "resolving" ? undefined : done}
        className="h-1.5"
      />

      <p className="text-[11px] text-muted-foreground">
        Checking {comparison.videoCount} videos against the campaign's earlier ones. This takes
        a few minutes — the page updates on its own.
      </p>
    </div>
  )
}

/** A finished run: what was found, then every pair behind it. */
function Results({
  comparison,
  videoById,
  showAllPairs,
  onToggleAllPairs,
  onOpenPair,
}: {
  comparison: Comparison
  videoById: Map<string, ComparisonVideo>
  showAllPairs: boolean
  onToggleAllPairs: () => void
  onOpenPair: (pair: ComparisonPair) => void
}) {
  const flagged = comparison.pairs.filter((pair) => pair.verdict !== "NO_MATCH")
  const unready = comparison.videos.filter((video) => !video.ready)
  // With nothing flagged there is no shorter list to offer, so the full one is
  // what the section shows — a "Flagged pairs" heading over no rows would read
  // as a failure to render rather than as a clean result.
  const showAll = showAllPairs || flagged.length === 0
  const shown = showAll ? comparison.pairs : flagged

  return (
    <div className="space-y-3">
      {flagged.length === 0 ? (
        <div className="flex items-start gap-2.5 rounded-lg border border-success/25 bg-success/5 p-3">
          <ShieldCheckIcon className="mt-0.5 size-4 shrink-0 text-success" />
          <div className="space-y-0.5">
            <p className="text-[13px] font-medium">No duplicates found</p>
            <p className="numeric text-[11px] text-muted-foreground">
              {comparison.pairs.length} pair
              {comparison.pairs.length === 1 ? "" : "s"} compared across{" "}
              {comparison.videoCount} videos.
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {comparison.groups.map((group) => (
            <GroupCard
              key={group.submissionIds.join(":")}
              group={group}
              videoById={videoById}
            />
          ))}
        </div>
      )}

      {/* Videos the engine never fingerprinted are in no pair at all, so
          "no duplicates" above does not cover them. Saying so is the whole
          reason the roster is stored. */}
      {unready.length > 0 && (
        <div className="flex items-start gap-2.5 rounded-lg border border-warning/25 bg-warning/5 p-3">
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-warning" />
          <div className="min-w-0 space-y-0.5">
            <p className="text-[13px] font-medium">
              {unready.length} video{unready.length === 1 ? "" : "s"} could not
              be read
            </p>
            <p className="text-[11px] break-words text-muted-foreground">
              {unready.map((video) => video.fileName).join(", ")} — not compared
              against anything.
            </p>
          </div>
        </div>
      )}

      {comparison.pairs.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-3">
            <p className={SECTION_LABEL}>
              {showAll ? "All pairs" : "Flagged pairs"}
            </p>
            {flagged.length > 0 && flagged.length < comparison.pairs.length && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                onClick={onToggleAllPairs}
              >
                {showAll
                  ? `Flagged only (${flagged.length})`
                  : `Show all ${comparison.pairs.length}`}
              </Button>
            )}
          </div>

          <ul className="divide-y overflow-hidden rounded-lg border">
            {shown.map((pair) => (
              <li key={pair.id}>
                <PairRow
                  pair={pair}
                  videoById={videoById}
                  onOpen={() => onOpenPair(pair)}
                />
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="numeric text-[11px] text-muted-foreground">
        Checked {relativeTime(comparison.completedAt ?? comparison.createdAt)}
        {comparison.engineVersion !== null && (
          <>
            {" "}
            <MetaDivider /> engine {comparison.engineVersion}
          </>
        )}
      </p>
    </div>
  )
}

/** A cluster of videos that look like the same cut. */
function GroupCard({
  group,
  videoById,
}: {
  group: ComparisonGroup
  videoById: Map<string, ComparisonVideo>
}) {
  const videos = group.submissionIds
    .map((id) => videoById.get(id))
    .filter((video) => video !== undefined)

  // Distinct editors matter more than distinct files: one editor submitting
  // two cuts of their own work is ordinary, two editors submitting the same
  // cut is not.
  const editors = new Set(videos.map((video) => video.editorId))

  return (
    <div className="space-y-2 rounded-lg border border-destructive/20 bg-destructive/[0.04] p-3">
      <div className="flex items-center gap-2">
        <CopyCheckIcon className="size-4 shrink-0 text-destructive" />
        <p className="text-[13px] font-medium">
          {videos.length} videos look like the same cut
        </p>
        <span
          className="numeric ml-auto shrink-0 text-[11px] text-muted-foreground"
          title={SCORE_HINT}
        >
          {/* One % on the range, not one per end: "71.0–96.0%" reads as a
              span, "71.0%–96.0%" reads as two separate figures. */}
          {group.minScore === group.maxScore
            ? `${score(group.maxScore)} match`
            : `${group.minScore.toFixed(1)}–${score(group.maxScore)} match`}
        </span>
      </div>

      <ul className="space-y-1 pl-6">
        {videos.map((video) => (
          <li
            key={video.submissionId}
            className="flex flex-wrap items-center gap-x-2 text-[13px]"
          >
            <span className="min-w-0 truncate" title={video.fileName}>
              {video.fileName}
            </span>
            <MetaDivider />
            <span className="shrink-0 text-muted-foreground">
              {video.editorName}
            </span>
            <span
              className="numeric shrink-0 text-[11px] text-muted-foreground"
              title={fullDate(video.submittedAt)}
            >
              {clock(video.durationSeconds)} · {relativeTime(video.submittedAt)}
            </span>
          </li>
        ))}
      </ul>

      {editors.size > 1 && (
        <p className="pl-6 text-[11px] text-warning">
          Submitted by {editors.size} different editors.
        </p>
      )}
    </div>
  )
}

/** One pair: which two videos, how they scored, and the verdict. */
function PairRow({
  pair,
  videoById,
  onOpen,
}: {
  pair: ComparisonPair
  videoById: Map<string, ComparisonVideo>
  onOpen: () => void
}) {
  const a = videoById.get(pair.aSubmissionId)
  const b = videoById.get(pair.bSubmissionId)

  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-x-3 gap-y-1 px-3 py-2 text-left text-[13px] transition-colors outline-none hover:bg-accent/50 focus-visible:bg-accent/50"
    >
      <span className="min-w-0 flex-1 truncate">
        <span title={a?.fileName}>{a?.fileName ?? "Removed video"}</span>
        <span className="px-1.5 text-muted-foreground">↔</span>
        <span title={b?.fileName}>{b?.fileName ?? "Removed video"}</span>
      </span>

      {/* Containment is the clip-inside-source signal, and it is easy to miss:
          a 10s lift from a 60s video scores modestly but contains near 100. */}
      {pair.containment >= 80 && pair.verdict !== "MATCH" && (
        <span className="numeric hidden shrink-0 text-[11px] text-warning sm:inline">
          {score(pair.containment)} contained
        </span>
      )}

      <span className="numeric shrink-0 tabular-nums text-muted-foreground">
        {score(pair.score)}
      </span>
      <ComparisonVerdictBadge verdict={pair.verdict} compact />
    </button>
  )
}

/**
 * Everything the engine reported about one pair, without a frame around it.
 *
 * Ordered by how much it changes a reader's mind: the flags that explain a
 * surprising score first, then where the two videos actually overlap, then
 * the numbers behind it. Rendered inline inside the per-video result modal
 * and inside the pair dialog, so the two can never drift apart.
 */
function PairEvidence({
  pair,
  a,
  b,
}: {
  pair: ComparisonPair
  a: ComparisonVideo | undefined
  b: ComparisonVideo | undefined
}) {
  const evidence: ComparisonEvidence | null = pair.evidence
  const visual = evidence?.visual

  // Null means the API withheld it — an editor looking at a pair against
  // another editor's cut. Saying so beats rendering an empty timeline that
  // reads as "nothing matched".
  if (evidence === null) {
    return (
      <p className="rounded-md border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
        The detailed breakdown is only shown to admins, because it describes
        both videos.
      </p>
    )
  }

  return (
    <div className="space-y-3">
      {(visual?.flipped === true ||
        visual?.reordered === true ||
        evidence.audio?.boost_applied === true) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {visual?.flipped === true && (
            <Chip tone="warning">Mirrored horizontally</Chip>
          )}
          {visual?.reordered === true && (
            <Chip tone="warning">Scenes re-ordered</Chip>
          )}
          {evidence.audio?.boost_applied === true && <Chip>Same audio</Chip>}
        </div>
      )}

      <SpanTimeline
        spans={visual?.matched_spans ?? []}
        a={a}
        b={b}
        aCoverage={visual?.coverage?.a}
        bCoverage={visual?.coverage?.b}
      />

      <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        <Stat
          label="Containment"
          value={score(pair.containment)}
          hint="How much of the shorter video appears in the longer one."
        />
        <Stat
          label="Quality"
          value={percent(visual?.quality)}
          hint="Mean frame similarity along the matched path."
        />
        <Stat
          label="Speed"
          value={
            visual?.speed_ratio === undefined
              ? "—"
              : `${visual.speed_ratio.toFixed(2)}×`
          }
          hint="1.00 means the same tempo."
        />
        <Stat
          label="Audio"
          value={
            evidence.audio?.verdict === "match"
              ? "Matches"
              : evidence.audio?.verdict === "no_match"
                ? "Differs"
                : "—"
          }
          hint="Audio can only raise a score, never lower one."
        />
      </div>

      {/* The one field that can pull a score down, and the only reason a
          visually strong pair sits just under the duplicate band. */}
      {evidence.mpeg7?.status === "not_matched" && (
        <p className="rounded-md border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
          An independent signature check disagreed, so the score is capped
          below the duplicate band.
        </p>
      )}
    </div>
  )
}

/**
 * One pair, on its own. Opened from the admin panel's pair list, where the
 * question really is about the pair rather than about either video.
 */
function PairDetailDialog({
  pair,
  videoById,
  onClose,
}: {
  pair: ComparisonPair | null
  videoById: Map<string, ComparisonVideo>
  onClose: () => void
}) {
  const shown = useHeldWhileClosing(pair, pair?.id ?? null)
  const a = shown === null ? undefined : videoById.get(shown.aSubmissionId)
  const b = shown === null ? undefined : videoById.get(shown.bSubmissionId)

  return (
    <Dialog open={pair !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        {shown !== null && (
          <>
            <DialogHeader>
              <DialogTitle className="text-[15px]">
                {a?.fileName ?? "Removed video"} ↔{" "}
                {b?.fileName ?? "Removed video"}
              </DialogTitle>
              <DialogDescription className="text-[13px]">
                {a?.editorName ?? "Unknown"} and {b?.editorName ?? "Unknown"} —
                {" "}
                {score(shown.score)} match.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-3">
              <ComparisonVerdictBadge verdict={shown.verdict} />
              <PairEvidence pair={shown} a={a} b={b} />
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

/**
 * Where in each video the match sits.
 *
 * Two bars scaled to their own durations, with the matched spans filled in.
 * This is the field that makes a lifted clip obvious at a glance: a short
 * fully-filled bar against a long one with a single filled block is exactly
 * the clip-inside-source case that a modest score hides.
 */
function SpanTimeline({
  spans,
  a,
  b,
  aCoverage,
  bCoverage,
}: {
  spans: { a_start: number; a_end: number; b_start: number; b_end: number }[]
  a: ComparisonVideo | undefined
  b: ComparisonVideo | undefined
  aCoverage: number | undefined
  bCoverage: number | undefined
}) {
  if (spans.length === 0) {
    return (
      <p className="rounded-md border bg-muted/30 px-3 py-2 text-[13px] text-muted-foreground">
        No aligned segment survived — nothing in one video lines up with
        anything in the other.
      </p>
    )
  }

  const rows = [
    {
      video: a,
      coverage: aCoverage,
      spans: spans.map((span) => [span.a_start, span.a_end] as const),
    },
    {
      video: b,
      coverage: bCoverage,
      spans: spans.map((span) => [span.b_start, span.b_end] as const),
    },
  ]

  return (
    <div className="space-y-2">
      <p className={SECTION_LABEL}>Where they overlap</p>
      {rows.map((row, index) => {
        // Fall back to the last span's end so a bar still renders when the
        // engine could not probe a duration.
        const duration =
          row.video?.durationSeconds ??
          Math.max(...row.spans.map(([, end]) => end), 1)

        return (
          <div key={index} className="space-y-1">
            <div className="flex items-center gap-2 text-[11px]">
              <span
                className="min-w-0 truncate text-muted-foreground"
                title={row.video?.fileName}
              >
                {row.video?.fileName ?? "Removed video"}
              </span>
              <span className="numeric ml-auto shrink-0 text-muted-foreground">
                {percent(row.coverage)} of {clock(duration)}
              </span>
            </div>
            <div className="relative h-2 overflow-hidden rounded-full bg-muted">
              {row.spans.map(([start, end], spanIndex) => (
                <span
                  key={spanIndex}
                  className="absolute inset-y-0 rounded-full bg-destructive/70"
                  style={{
                    left: `${Math.max(0, Math.min(100, (start / duration) * 100))}%`,
                    // A floor of 1% so a sub-second match is still visible.
                    width: `${Math.max(1, Math.min(100, ((end - start) / duration) * 100))}%`,
                  }}
                />
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string
  value: string
  hint?: string
}) {
  return (
    <div className="space-y-0.5" title={hint}>
      <p className={SECTION_LABEL}>{label}</p>
      <p className="numeric text-[13px]">{value}</p>
    </div>
  )
}

function Chip({
  tone = "muted",
  children,
}: {
  tone?: "muted" | "warning"
  children: string
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px]",
        tone === "warning"
          ? "border-warning/30 bg-warning/10 text-warning"
          : "border-border bg-muted/40 text-muted-foreground",
      )}
    >
      {children}
    </span>
  )
}

/**
 * The whole duplicate-check result for **one** video.
 *
 * Opened from a card's status strip, and ordered the way the question is
 * actually asked: the verdict in one line at the top, then what it matched
 * and the evidence for each match, then the housekeeping — duration, how many
 * videos it was compared against, when, which engine. Anything the engine
 * reports that does not change a decision stays out; that detail is one more
 * click away in the admin panel's pair list.
 */
export function SubmissionResultDialog({
  submission,
  check,
  state,
  onClose,
}: {
  submission: VideoSubmission | null
  check: SubmissionCheck | null
  state: ComparisonState
  onClose: () => void
}) {
  const open = submission !== null && check !== null
  // Held as one value: the two always arrive and leave together, and holding
  // them apart could pair a stale check with a fresh video for a frame.
  const shown = useHeldWhileClosing(
    open ? { submission, check } : null,
    submission?.id ?? null,
  )

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-xl">
        {shown !== null && (
          <>
            <DialogHeader>
              <DialogTitle className="text-[15px] break-all">
                {shown.submission.fileName}
              </DialogTitle>
              <DialogDescription className="text-[13px]">
                {shown.submission.editorName} ·{" "}
                {fileSize(shown.submission.sizeBytes)} · submitted{" "}
                {relativeTime(shown.submission.createdAt)}
              </DialogDescription>
            </DialogHeader>

            <ResultBody check={shown.check} state={state} onClose={onClose} />
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** Verdict first, matches second, housekeeping last. */
function ResultBody({
  check,
  state,
  onClose,
}: {
  check: SubmissionCheck
  state: ComparisonState
  /** Closes the dialog, so a jump to the parent card is actually visible. */
  onClose: () => void
}) {
  if (check.kind === "none") {
    return (
      <p className="text-[13px] text-muted-foreground">
        This video is waiting to be checked. Every upload is compared against
        the campaign's existing videos as it lands; this page updates on its
        own.
      </p>
    )
  }

  if (check.kind === "running") {
    return (
      <p className="text-[13px] text-muted-foreground">
        A check is running now — {check.pairsDone} of {check.pairsTotal} pairs
        compared. This page updates on its own.
      </p>
    )
  }

  if (check.kind === "failed") {
    return (
      <div className="space-y-2">
        <p className="text-[13px] font-medium">The check could not run</p>
        <p className="text-[13px] break-words text-muted-foreground">
          {check.message}
        </p>
      </div>
    )
  }

  if (check.kind === "unreadable") {
    return (
      <div className="space-y-3">
        <div className="flex items-start gap-2.5 rounded-lg border border-warning/25 bg-warning/5 p-3">
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-warning" />
          <p className="text-[13px]">
            The engine could not read this file, so it was not compared against
            anything. Nothing here says whether it is a duplicate.
          </p>
        </div>
        <CheckFooter check={check} state={state} />
      </div>
    )
  }

  if (check.kind === "clean") {
    return (
      <div className="space-y-3">
        <div className="flex items-start gap-2.5 rounded-lg border border-success/25 bg-success/5 p-3">
          <ShieldCheckIcon className="mt-0.5 size-4 shrink-0 text-success" />
          <div className="space-y-0.5">
            <p className="text-[13px] font-medium">Unique</p>
            <p className="text-[13px] text-muted-foreground">
              {check.comparedWith === null
                ? "Nothing on this campaign resembled it when it was checked."
                : `Compared against ${check.comparedWith} other video${check.comparedWith === 1 ? "" : "s"} on this campaign. Nothing resembled it.`}
            </p>
          </div>
        </div>
        <CheckFooter check={check} state={state} />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* The answer, in one line. Everything below is why. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-destructive/20 bg-destructive/[0.05] px-3 py-2.5">
        <UniquenessBadge uniqueness={check.uniqueness} />
        <span
          className="numeric text-[20px] leading-none font-semibold"
          title={SCORE_HINT}
        >
          {score(check.topScore)}
        </span>
        <span className="text-[11px] text-muted-foreground">match</span>
        <span className="w-full text-[13px] text-muted-foreground sm:w-auto sm:flex-1 sm:text-right">
          {check.uniqueness === "DUPLICATE"
            ? "At or above this campaign's limit"
            : "Below this campaign's limit, but not unique"}
        </span>
      </div>

      <div className="space-y-2">
        <p className={SECTION_LABEL}>What it matches</p>
        {check.matches.length === 0 && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border p-3">
            {/* The name alone left the reader hunting through the grid for
                which card it meant. This jumps to it and flashes it. */}
            {check.parent === null ? (
              <span className="min-w-0 truncate text-[13px] font-medium">
                Another submission
              </span>
            ) : (
              <button
                type="button"
                onClick={() => {
                  // Closing only on success: leaving the dialog open is the
                  // honest outcome when there is no card to jump to.
                  if (scrollToSubmission(check.parent!.id)) {
                    onClose()
                  } else {
                    toast.info("That video is not on screen", {
                      description:
                        "A filter may be hiding it, or it was handed in by someone whose work you cannot see.",
                    })
                  }
                }}
                title={`Show ${check.parent.fileName}`}
                className="min-w-0 truncate rounded text-[13px] font-medium underline-offset-2 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                {check.parent.fileName}
              </button>
            )}
            {check.parent !== null && (
              <>
                <MetaDivider />
                <span className="text-[13px] text-muted-foreground">
                  {check.parent.editorName}
                </span>
                <MetaDivider />
                <span
                  className="numeric text-[11px] text-muted-foreground"
                  title={fullDate(check.parent.createdAt)}
                >
                  {relativeTime(check.parent.createdAt)}
                </span>
              </>
            )}
            <span
              className="numeric ml-auto text-[13px] font-medium"
              title={SCORE_HINT}
            >
              {score(check.topScore)} match
            </span>
          </div>
        )}
        {check.matches.map(({ pair, other }) => (
          <div key={pair.id} className="space-y-3 rounded-lg border p-3">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="min-w-0 truncate text-[13px] font-medium">
                {other?.fileName ?? "Removed video"}
              </span>
              <MetaDivider />
              <span className="text-[13px] text-muted-foreground">
                {other?.editorName ?? "Unknown editor"}
              </span>
              {other !== null && Date.parse(other.submittedAt) > 0 && (
                <>
                  <MetaDivider />
                  <span
                    className="numeric text-[11px] text-muted-foreground"
                    title={fullDate(other.submittedAt)}
                  >
                    {relativeTime(other.submittedAt)}
                  </span>
                </>
              )}
              <span
                className="numeric ml-auto text-[13px] font-medium"
                title={SCORE_HINT}
              >
                {score(pair.score)} match
              </span>
              <ComparisonVerdictBadge verdict={pair.verdict} compact />
            </div>

            <PairEvidence
              pair={pair}
              a={state.videoById.get(pair.aSubmissionId)}
              b={state.videoById.get(pair.bSubmissionId)}
            />
          </div>
        ))}
      </div>

      <CheckFooter check={check} state={state} />
    </div>
  )
}

/** The housekeeping line: what was checked, when, and by which engine. */
function CheckFooter({
  check,
  state,
}: {
  check: Extract<SubmissionCheck, { checkedAt: string }>
  state: ComparisonState
}) {
  const duration = "durationSeconds" in check ? check.durationSeconds : null
  const version = state.comparison?.engineVersion ?? null

  return (
    <p className="numeric flex flex-wrap items-center gap-x-2 gap-y-1 border-t pt-3 text-[11px] text-muted-foreground">
      {duration !== null && (
        <>
          <span>{clock(duration)} long</span>
          <MetaDivider />
        </>
      )}
      <span title={fullDate(check.checkedAt)}>
        checked {relativeTime(check.checkedAt)}
      </span>
      {version !== null && (
        <>
          <MetaDivider />
          <span>engine {version}</span>
        </>
      )}
    </p>
  )
}
