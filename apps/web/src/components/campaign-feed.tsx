import { useMemo, useState } from "react"
import {
  CheckIcon,
  ClapperboardIcon,
  RotateCwIcon,
  SendIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { motion, useReducedMotion } from "motion/react"

import { EmptyState } from "@/components/empty-state"
import { MetaDivider } from "@/components/page-header"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Skeleton } from "@/components/ui/skeleton"
import { useCollection } from "@/hooks/use-collection"
import { fileSize, relativeTime } from "@/lib/format"
import type { Campaign, VideoSubmission } from "@/lib/types"
import { cn } from "@/lib/utils"

/** The orderings the API offers, in the order they appear in the bar. */
const SORTS = [
  { value: "original", label: "Most original" },
  { value: "duplicate", label: "Most duplicated" },
  { value: "recent", label: "Newest" },
] as const

type Sort = (typeof SORTS)[number]["value"]

function feedPath(campaignId: string, sort: Sort, flaggedOnly: boolean): string {
  const params = new URLSearchParams({ sort })
  if (flaggedOnly) params.set("flagged", "true")
  return `/campaigns/${campaignId}/submissions?${params.toString()}`
}

/**
 * The campaign feed: every video on the campaign, least duplicated first.
 *
 * Admin-only, and separate from CampaignSubmissions — that one is the editor's
 * hand-in flow (upload, withdraw, check my own cut), this is the admin's read
 * of the whole campaign with selection for sharing.
 */
export function CampaignFeed({ campaign }: { campaign: Campaign }) {
  const [sort, setSort] = useState<Sort>("original")
  const [flaggedOnly, setFlaggedOnly] = useState(false)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const reduceMotion = useReducedMotion()

  const { items, isLoading, error, refetch } = useCollection<VideoSubmission>(
    feedPath(campaign.id, sort, flaggedOnly),
  )

  // Selection survives a re-sort but not a video leaving the list, so a share
  // can never carry an id that is no longer on screen.
  const visibleSelected = useMemo(
    () => items.filter((item) => selected.has(item.id)),
    [items, selected],
  )

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const checkedCount = items.filter(
    (item) => item.duplicationScore !== null,
  ).length

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          Campaign feed
        </h2>
        <span aria-hidden className="h-px flex-1 bg-border" />
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={() => void refetch()}
          aria-label="Refresh feed"
        >
          <RotateCwIcon className="size-3.5" />
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-md border p-0.5">
          {SORTS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => setSort(option.value)}
              className={cn(
                "relative rounded px-2.5 py-1 text-[12px] transition-colors",
                sort === option.value
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {sort === option.value && (
                <motion.span
                  layoutId="campaign-feed-sort"
                  transition={{ duration: reduceMotion ? 0 : 0.18 }}
                  className="absolute inset-0 rounded bg-muted"
                />
              )}
              <span className="relative">{option.label}</span>
            </button>
          ))}
        </div>

        <Button
          variant={flaggedOnly ? "secondary" : "outline"}
          size="sm"
          className="h-8 text-[12px]"
          onClick={() => setFlaggedOnly((on) => !on)}
        >
          <TriangleAlertIcon className="size-3.5" />
          Flagged only
        </Button>

        <span className="ml-auto text-[12px] text-muted-foreground">
          {isLoading
            ? null
            : `${checkedCount} of ${items.length} checked against ${campaign.duplicationThreshold}%`}
        </span>
      </div>

      {isLoading ? (
        <FeedSkeleton />
      ) : error !== null ? (
        <EmptyState
          icon={ClapperboardIcon}
          title="Could not load the feed"
          description={error}
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon={ClapperboardIcon}
          title={flaggedOnly ? "Nothing flagged" : "No videos yet"}
          description={
            flaggedOnly
              ? `No video on this campaign has reached ${campaign.duplicationThreshold}% duplication.`
              : "Videos handed in against this brief will appear here, least duplicated first."
          }
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {items.map((submission) => (
            <FeedCard
              key={submission.id}
              submission={submission}
              threshold={campaign.duplicationThreshold}
              isSelected={selected.has(submission.id)}
              onToggle={() => toggle(submission.id)}
            />
          ))}
        </div>
      )}

      {visibleSelected.length > 0 && (
        <div className="sticky bottom-4 z-10 flex items-center gap-3 rounded-lg border bg-background/95 px-4 py-2.5 shadow-lg backdrop-blur">
          <CheckIcon className="size-4 text-[var(--success)]" />
          <span className="text-[13px]">
            {visibleSelected.length === 1
              ? "1 video selected"
              : `${visibleSelected.length} videos selected`}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-8 text-[12px]"
            onClick={() => setSelected(new Set())}
          >
            Clear
          </Button>
          {/* Wired up on day 5, when the WhatsApp send lands. */}
          <Button size="sm" className="h-8 text-[12px]" disabled>
            <SendIcon className="size-3.5" />
            Send to vendors
          </Button>
        </div>
      )}
    </section>
  )
}

function FeedCard({
  submission,
  threshold,
  isSelected,
  onToggle,
}: {
  submission: VideoSubmission
  threshold: number
  isSelected: boolean
  onToggle: () => void
}) {
  const [isUnplayable, setUnplayable] = useState(false)

  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border transition-colors",
        isSelected && "border-ring bg-muted/30",
      )}
    >
      <div className="flex items-start gap-2 border-b px-3 py-2">
        <Checkbox
          checked={isSelected}
          onCheckedChange={onToggle}
          aria-label={`Select ${submission.fileName}`}
          className="mt-0.5"
        />
        <span
          className="min-w-0 flex-1 truncate text-[13px] font-medium"
          title={submission.fileName}
        >
          {submission.fileName}
        </span>
        <ScoreBadge submission={submission} threshold={threshold} />
      </div>

      {isUnplayable ? (
        <div className="flex aspect-video items-center justify-center bg-muted/40 px-4 text-center text-[12px] text-muted-foreground">
          This video cannot be played in the browser.
        </div>
      ) : (
        <video
          controls
          preload="metadata"
          src={submission.playbackUrl}
          onError={() => setUnplayable(true)}
          className="aspect-video w-full bg-black"
        />
      )}

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-[12px] text-muted-foreground">
        <span className="shrink-0">{submission.editorName}</span>
        <MetaDivider />
        <span className="numeric shrink-0">
          {fileSize(submission.sizeBytes)}
        </span>
        <MetaDivider />
        <span className="numeric shrink-0">
          {relativeTime(submission.createdAt)}
        </span>
      </div>
    </div>
  )
}

/**
 * The duplication readout.
 *
 * Null is its own state and says so: a video no run has reached yet is not a
 * 0% original one, and showing it as such would be a lie the feed's ordering
 * already takes care to avoid.
 */
function ScoreBadge({
  submission,
  threshold,
}: {
  submission: VideoSubmission
  threshold: number
}) {
  if (submission.duplicationScore === null) {
    return (
      <span className="numeric shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
        Not checked
      </span>
    )
  }

  const score = submission.duplicationScore
  const isFlagged = submission.overThreshold

  return (
    <span
      title={
        isFlagged
          ? `At or above this campaign's ${threshold}% limit`
          : `Below this campaign's ${threshold}% limit`
      }
      className={cn(
        "numeric shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium",
        isFlagged
          ? "bg-[color-mix(in_oklch,var(--warning)_18%,transparent)] text-[var(--warning)]"
          : score === 0
            ? "bg-[color-mix(in_oklch,var(--success)_16%,transparent)] text-[var(--success)]"
            : "bg-muted text-muted-foreground",
      )}
    >
      {score === 0 ? "Original" : `${score}% dup`}
    </span>
  )
}

function FeedSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {[0, 1].map((index) => (
        <div key={index} className="overflow-hidden rounded-lg border">
          <div className="flex items-center gap-2 border-b px-3 py-2">
            <Skeleton className="size-4 rounded" />
            <Skeleton className="h-3 w-40" />
          </div>
          <Skeleton className="aspect-video w-full rounded-none" />
          <div className="px-3 py-2">
            <Skeleton className="h-3 w-32" />
          </div>
        </div>
      ))}
    </div>
  )
}
