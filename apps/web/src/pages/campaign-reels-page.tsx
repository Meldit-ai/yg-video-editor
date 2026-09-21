import { useCallback, useEffect, useRef, useState } from "react"
import { Link, useParams } from "react-router-dom"
import {
  ArrowLeftIcon,
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  Loader2Icon,
  ChevronDownIcon,
  ChevronRightIcon,
  RotateCwIcon,
  ScanSearchIcon,
  SparklesIcon,
} from "lucide-react"
import { motion, useReducedMotion } from "motion/react"
import { toast } from "sonner"

import { EmptyState } from "@/components/empty-state"
import { MetaDivider, PageHeader } from "@/components/page-header"
import { UniquenessBadge } from "@/components/status-badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { errorMessage } from "@/hooks/use-collection"
import { api } from "@/lib/api"
import { fullDate, shortDate, compact } from "@/lib/format"
import type {
  Campaign,
  CampaignReel,
  ReelCheckRun,
  ReelImportResult,
} from "@/lib/types"
import { groupDuplicates } from "@/lib/duplicate-groups"
import { cn } from "@/lib/utils"

/** While a check is running, the numbers move often enough to watch. */
const POLL_MS = 4_000

export function CampaignReelsPage() {
  const { id } = useParams<{ id: string }>()
  const [campaign, setCampaign] = useState<Campaign | null>(null)
  const [reels, setReels] = useState<CampaignReel[]>([])
  const [run, setRun] = useState<ReelCheckRun | null>(null)
  const [isLoading, setLoading] = useState(true)
  const [isImporting, setImporting] = useState(false)
  const [isStarting, setStarting] = useState(false)
  const reduceMotion = useReducedMotion()

  const isRunning = run?.status === "RUNNING" || run?.status === "QUEUED"

  const refresh = useCallback(async () => {
    if (id === undefined) return
    const [campaignData, reelData, runData] = await Promise.all([
      api.get<Campaign>(`/campaigns/${id}`),
      api.get<CampaignReel[]>(`/campaigns/${id}/reels`),
      api.get<ReelCheckRun | null>(`/campaigns/${id}/reels/check`),
    ])
    setCampaign(campaignData)
    setReels(reelData)
    // A campaign that has never been checked answers with an empty body,
    // which the api client reads as undefined — and `undefined !== null`.
    setRun(runData ?? null)
  }, [id])

  useEffect(() => {
    let cancelled = false
    refresh()
      .catch((caught: unknown) => {
        if (!cancelled) toast.error(errorMessage(caught))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [refresh])

  // Poll only while something is actually moving, so an idle page is silent.
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh
  useEffect(() => {
    if (!isRunning) return
    const timer = setInterval(() => void refreshRef.current(), POLL_MS)
    return () => clearInterval(timer)
  }, [isRunning])

  async function importReels() {
    setImporting(true)
    try {
      // No limit: the import takes the campaign whole, because the earliest
      // reel is what every later one is classified against.
      const result = await api.post<ReelImportResult>(
        `/campaigns/${id}/reels/import`,
        {},
      )
      toast.success(
        `${result.imported} new reel${result.imported === 1 ? "" : "s"} imported`,
        {
          description:
            (result.imported > 0 ? "Checking them in the background. " : "") +
            (result.skipped > 0
              ? `${result.totalReels} stored. ${result.skipped.toLocaleString()} more are available on the tracker.`
              : `${result.totalReels} stored.`),
        },
      )
      await refresh()
    } catch (caught) {
      toast.error(errorMessage(caught))
    } finally {
      setImporting(false)
    }
  }

  async function startCheck() {
    setStarting(true)
    try {
      setRun(await api.post<ReelCheckRun>(`/campaigns/${id}/reels/check`, {}))
      toast.success("Re-checking every reel", {
        description: "Labels appear as each reel is checked, in post order.",
      })
    } catch (caught) {
      toast.error(errorMessage(caught))
    } finally {
      setStarting(false)
    }
  }

  // Grouped by what each reel was measured against, so a cut posted by nine
  // accounts reads as one finding rather than nine rows.
  const groups = groupDuplicates(
    reels.map((reel) => ({ ...reel, parentId: reel.originalReelId })),
  )
  const checked = reels.filter((reel) => reel.uniqueness !== null)
  const copies = checked.filter((reel) => reel.uniqueness === "DUPLICATE")

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: reduceMotion ? 0 : 0.15, ease: "easeOut" }}
      className="flex w-full max-w-5xl flex-col gap-5"
    >
      <Link
        to={id === undefined ? "/campaigns" : `/campaigns/${id}`}
        className="-ml-1.5 inline-flex w-fit items-center gap-1.5 rounded-md px-1.5 py-1 text-[13px] text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <ArrowLeftIcon className="size-3.5" />
        Back to campaign
      </Link>

      <PageHeader
        title={campaign?.title ?? "Instagram reels"}
        description="Reels pulled from the tracker, each checked against the ones posted before it. The earliest post of a video is the original; later copies are labelled against it."
        meta={
          campaign === null ? null : (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span>
                <span className="numeric text-foreground">{reels.length}</span>{" "}
                reels
              </span>
              <MetaDivider />
              <span>
                Flags at{" "}
                <span className="numeric text-foreground">
                  {campaign.duplicationThreshold}%
                </span>
              </span>
            </div>
          )
        }
        action={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void importReels()}
              disabled={isImporting}
            >
              {isImporting ? (
                <Loader2Icon className="animate-spin" />
              ) : (
                <DownloadIcon />
              )}
              Import reels
            </Button>
            <Button
              size="sm"
              onClick={() => void startCheck()}
              disabled={isStarting || isRunning || reels.length < 2}
            >
              {isStarting || isRunning ? (
                <Loader2Icon className="animate-spin" />
              ) : (
                <ScanSearchIcon />
              )}
              {isRunning ? "Checking" : checked.length > 0 ? "Re-check all" : "Check duplicates"}
            </Button>
          </div>
        }
      />

      {run !== null && (
        <RunBanner run={run} checkedCount={checked.length} total={reels.length} />
      )}

      {isLoading ? (
        <ReelsSkeleton />
      ) : reels.length === 0 ? (
        <EmptyState
          icon={SparklesIcon}
          title="No reels imported yet"
          description="Import this campaign's Instagram reels from the tracker to check them for duplicates."
          action={
            <Button size="sm" onClick={() => void importReels()}>
              <DownloadIcon />
              Import reels
            </Button>
          }
        />
      ) : (
        <>
          <SummaryRow
            total={reels.length}
            checked={checked.length}
            copies={copies.length}
            distinct={groups.length}
            threshold={campaign?.duplicationThreshold ?? 0}
          />
          <ul className="flex flex-col gap-3">
            {groups.map((group, index) => (
              <ReelGroup
                key={group.head.id}
                head={group.head}
                copies={group.children}
                rank={index + 1}
              />
            ))}
          </ul>
        </>
      )}
    </motion.div>
  )
}

/** Live progress while a check runs, and the outcome once it stops. */
function RunBanner({
  run,
  checkedCount,
  total,
}: {
  run: ReelCheckRun
  checkedCount: number
  total: number
}) {
  const isRunning = run.status === "RUNNING" || run.status === "QUEUED"
  const percent =
    run.pairsTotal === 0
      ? 0
      : Math.min(100, Math.round((run.pairsDone / run.pairsTotal) * 100))

  if (run.status === "FAILED") {
    return (
      <div className="rounded-lg border border-[var(--warning)]/40 bg-[color-mix(in_oklch,var(--warning)_8%,transparent)] px-4 py-3 text-[13px]">
        <p className="font-medium">The last check did not finish</p>
        <p className="text-muted-foreground">
          {run.errorMessage ?? "Something went wrong."}
        </p>
      </div>
    )
  }

  if (!isRunning) return null

  return (
    <div className="rounded-lg border bg-muted/30 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
        <Loader2Icon className="size-3.5 animate-spin text-muted-foreground" />
        <span className="font-medium">Checking for duplicates</span>
        <MetaDivider />
        <span className="numeric text-muted-foreground">
          {checkedCount} of {total} reels scored
        </span>
        <span className="numeric ml-auto text-muted-foreground">
          {percent}%
        </span>
      </div>
      <div className="mt-2 h-1 overflow-hidden rounded-full bg-border">
        <div
          className="h-full rounded-full bg-foreground/60 transition-[width] duration-500"
          style={{ width: `${percent}%` }}
        />
      </div>
      <p className="mt-2 text-[12px] text-muted-foreground">
        The first check on a campaign takes a while — every reel has to be
        processed once. Later checks are quick.
      </p>
    </div>
  )
}

function SummaryRow({
  total,
  checked,
  copies,
  distinct,
  threshold,
}: {
  total: number
  checked: number
  copies: number
  /** Groups after folding copies under what they were measured against. */
  distinct: number
  threshold: number
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-4">
      <Stat label="Reels imported" value={String(total)} />
      <Stat
        label="Checked"
        value={`${checked} of ${total}`}
        hint={checked < total ? "Still working" : "All done"}
      />
      <Stat
        label="Copies found"
        value={String(copies)}
        hint={`At or above ${threshold}%`}
        tone={copies > 0 ? "warning" : "default"}
      />
      <Stat
        // The number the page is really about: how many different videos this
        // campaign holds, once the reposts of each are folded together.
        label="Distinct videos"
        value={String(distinct)}
        hint={
          total > distinct
            ? `${total - distinct} reels repost one of these`
            : "Every reel is its own video"
        }
      />
    </div>
  )
}

function Stat({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string
  value: string
  hint?: string
  tone?: "default" | "warning"
}) {
  return (
    <Card className="py-0">
      <CardContent className="flex flex-col gap-1 p-4">
        <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          {label}
        </span>
        <p
          className={cn(
            "numeric text-xl leading-none font-semibold",
            tone === "warning" && "text-[var(--warning)]",
          )}
        >
          {value}
        </p>
        {hint !== undefined && (
          <span className="text-[12px] text-muted-foreground">{hint}</span>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * One original and the reels found to carry the same cut.
 *
 * Collapsed to the original, because that is the finding: this video exists,
 * and N accounts posted it. The copies are a click away rather than filling
 * the page between unrelated originals.
 */
function ReelGroup({
  head,
  copies,
  rank,
}: {
  head: CampaignReel & { parentId: string | null }
  copies: (CampaignReel & { parentId: string | null })[]
  rank: number
}) {
  const [isOpen, setOpen] = useState(false)

  // Null, not 0, when nothing reported: "unknown" is not "nobody watched".
  const viewsOf = (reel: CampaignReel): number | null =>
    reel.postCounts?.views ?? reel.postCounts?.reach ?? null
  const counted = [head, ...copies]
    .map(viewsOf)
    .filter((value): value is number => value !== null)
  const groupViews =
    counted.length === 0
      ? null
      : counted.reduce((total, value) => total + value, 0)

  return (
    <li className="rounded-lg border">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <span className="numeric shrink-0 text-[11px] text-muted-foreground">
          {rank}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
          @{head.username}
        </span>
        {/* What this cut earned across every account that posted it — the
            same footage in nine places is one piece of work with nine sets
            of counts, and the sum is what says how far it travelled. */}
        {groupViews !== null && (
          <span
            className="numeric shrink-0 text-[12px] text-muted-foreground"
            title={
              copies.length === 0
                ? "Views on this reel"
                : `Views across all ${copies.length + 1} posts of this cut`
            }
          >
            {compact(groupViews)} views
          </span>
        )}
        <ScoreBadge reel={head} />
        {copies.length > 0 && (
          <button
            type="button"
            onClick={() => setOpen((open) => !open)}
            className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[12px] transition-colors hover:bg-muted"
          >
            {isOpen ? (
              <ChevronDownIcon className="size-3.5" />
            ) : (
              <ChevronRightIcon className="size-3.5" />
            )}
            {copies.length === 1
              ? "1 account posted this"
              : `${copies.length} accounts posted this`}
          </button>
        )}
      </div>

      <div className="grid gap-3 px-3 pb-3 sm:grid-cols-2 lg:grid-cols-3">
        <ReelCard reel={head} />
        {isOpen &&
          copies.map((copy) => (
            <ReelCard key={copy.id} reel={copy} derivedFrom={head.username} />
          ))}
      </div>
    </li>
  )
}

function ReelCard({
  reel,
  derivedFrom,
}: {
  reel: CampaignReel
  /** The handle this reel copied, when it is inside a group. */
  derivedFrom?: string
}) {
  const [isUnplayable, setUnplayable] = useState(false)
  const views = reel.postCounts?.views ?? reel.postCounts?.reach ?? null
  const isCopy = reel.uniqueness === "DUPLICATE"

  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border transition-colors",
        isCopy && "border-[var(--warning)]/50",
      )}
    >
      {isUnplayable ? (
        <div className="flex aspect-[9/16] items-center justify-center bg-muted/40 px-4 text-center text-[12px] text-muted-foreground">
          This reel cannot be played here.
        </div>
      ) : (
        /* The browser's own controls: scrubbing, volume and fullscreen are all
           wanted when comparing two cuts, and all already there.
           preload="metadata" fetches the header without pulling the file. */
        <video
          controls
          preload="metadata"
          src={reel.mediaUrl}
          onError={() => setUnplayable(true)}
          className="aspect-[9/16] w-full bg-black object-contain"
        />
      )}

      <div className="flex flex-col gap-1.5 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
            @{reel.username}
          </span>
          {/* `derivedFrom`, not the uniqueness label: what decides the word is
              where the card sits, and only a child card is given one. */}
          <ScoreBadge reel={reel} isCopy={derivedFrom !== undefined} />
        </div>

        {derivedFrom !== undefined && (
          <span className="inline-flex items-center gap-1 text-[12px] text-[var(--warning)]">
            <CopyIcon className="size-3" />
            same cut as @{derivedFrom}
          </span>
        )}

        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-muted-foreground">
          <span
            className="numeric"
            title={reel.postedAt === null ? undefined : fullDate(reel.postedAt)}
          >
            {reel.postedAt === null ? "No date" : shortDate(reel.postedAt)}
          </span>
          {views !== null && (
            <>
              <MetaDivider />
              <span className="numeric">{compact(views)} views</span>
            </>
          )}
          {reel.permalink !== null && (
            <a
              href={reel.permalink}
              target="_blank"
              rel="noreferrer"
              className="ml-auto inline-flex items-center gap-1 rounded transition-colors outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <ExternalLinkIcon className="size-3" />
              Post
            </a>
          )}
        </div>

        {reel.originalUsername !== null && (
          <span className="inline-flex items-center gap-1 text-[12px] text-[var(--warning)]">
            <CopyIcon className="size-3" />
            copy of @{reel.originalUsername}
          </span>
        )}
      </div>
    </div>
  )
}

/**
 * The verdict. Not-yet-checked is its own state and says so: a reel nobody
 * has looked at is not an original, and showing it as one would be a claim
 * the data does not support. "Unreadable" is a reel the engine could not
 * fetch or decode — checked, but with nothing to say.
 */
function ScoreBadge({
  reel,
  isCopy = false,
}: {
  reel: CampaignReel
  /** Whether this reel is listed under the one it was measured against. */
  isCopy?: boolean
}) {
  return (
    <UniquenessBadge
      uniqueness={reel.uniqueness}
      value={reel.duplicationScore}
      // Two labels on this page, not three: a PARTIAL wears whichever word
      // matches its place in the group. Its percentage still shows.
      partialAs={isCopy ? "DUPLICATE" : "UNIQUE"}
      pendingLabel={reel.checkedAt === null ? "Not checked" : "Unreadable"}
      className="shrink-0"
    />
  )
}

function ReelsSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      {[0, 1, 2, 3, 4].map((index) => (
        <div key={index} className="flex items-center gap-3 rounded-lg border px-3 py-3">
          <Skeleton className="size-4 rounded" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-40" />
            <Skeleton className="h-3 w-56" />
          </div>
        </div>
      ))}
    </div>
  )
}
