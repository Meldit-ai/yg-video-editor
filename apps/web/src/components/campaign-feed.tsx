import { useMemo, useState, type ReactNode } from "react"
import {
  CheckIcon,
  ChevronRightIcon,
  ClapperboardIcon,
  CopyIcon,
  RotateCwIcon,
  SendIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { motion, useReducedMotion } from "motion/react"

import { EmptyState } from "@/components/empty-state"
import { ListSentinel } from "@/components/list-sentinel"
import { VendorShareDialog } from "@/components/vendor-share-dialog"
import { MetaDivider } from "@/components/page-header"
import { UniquenessBadge } from "@/components/status-badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { useWholeCollection } from "@/hooks/use-paged-collection"
import { useNearViewport } from "@/hooks/use-near-viewport"
import { usePagedList } from "@/hooks/use-paged-list"
import { fileSize, relativeTime } from "@/lib/format"
import {
  MAX_SHARE_MEDIA,
  type Campaign,
  type VideoSubmission,
} from "@/lib/types"
import {
  groupDuplicates,
  isCopy,
  type DuplicateGroup,
} from "@/lib/duplicate-groups"
import { cn } from "@/lib/utils"

/** The orderings the API offers, in the order they appear in the bar. */
const SORTS = [
  { value: "original", label: "Most original" },
  { value: "duplicate", label: "Most duplicated" },
  { value: "recent", label: "Newest" },
] as const

type Sort = (typeof SORTS)[number]["value"]

/**
 * How the feed arranges what it holds.
 *
 * "All" is the default: every video is a card, which is what someone scanning
 * a campaign wants. "Grouped" folds copies under the original for reading the
 * duplication itself. Neither hides anything — the same videos are on the page
 * either way.
 */
const FEED_VIEWS = [
  { value: "all", label: "All videos", hint: "Every video as its own card" },
  {
    value: "grouped",
    label: "Grouped",
    hint: "Copies folded under the video they were measured against",
  },
] as const

type FeedView = (typeof FEED_VIEWS)[number]["value"]

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
  const [isShareOpen, setShareOpen] = useState(false)
  // Which group is being compared. One at a time, and in a panel: expanding
  // several inline reflowed the grid and buried the original a copy belonged
  // to, which is the one thing this view exists to answer.
  const [openGroupId, setOpenGroupId] = useState<string | null>(null)
  // Grouped folds copies under the original; all shows every video as its own
  // card. Same data and the same selection either way — only the arrangement
  // changes, so switching never loses what is ticked.
  const [view, setView] = useState<FeedView>("all")
  const reduceMotion = useReducedMotion()

  // Read whole rather than a page at a time: the folding below and the
  // ordering it applies are answers about the campaign, and computing them
  // from a page would rank the videos by whatever happened to be loaded.
  // What keeps the page usable is that only a slice of it is rendered.
  const { items, isLoading, error, refetch } =
    useWholeCollection<VideoSubmission>(
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

  // Folded by what each video was measured against, so a cut handed in nine
  // times reads as one row with nine beneath it rather than nine rows apart.
  //
  // Re-sorted after folding, because the server sorted 97 rows and the page
  // shows 32. Duplication is a property of the copies, not of the original
  // they were measured against: a video with sixteen copies at 99% is the most
  // duplicated thing on the campaign while its own score reads 16.7, so
  // ordering the groups by the head's score put the worst offenders nowhere
  // near the top.
  const groups = useMemo(() => {
    const folded = groupDuplicates(
      items.map((item) => ({ ...item, parentId: item.topMatchSubmissionId })),
    )
    if (sort === "recent") return folded
    const worst = (group: (typeof folded)[number]) =>
      group.children.reduce(
        (highest, child) => Math.max(highest, child.duplicationScore ?? 0),
        0,
      )
    // Ascending by default: the clean videos first, the worst offenders last,
    // so the list reads from what is fine towards what needs attention.
    // "Most duplicated" reverses it for someone going straight to the problems.
    return [...folded].sort((left, right) => {
      const byCount = left.children.length - right.children.length
      if (byCount !== 0) return sort === "duplicate" ? -byCount : byCount
      const byScore = worst(left) - worst(right)
      return sort === "duplicate" ? -byScore : byScore
    })
  }, [items, sort])

  // The same groups, flattened: each original followed immediately by the
  // videos taken from it. Derived from `groups` rather than re-sorting `items`
  // so both views order identically and a copy never drifts away from the
  // original it was measured against.
  // "Duplicate of <name>" in the flat view, where there is no original pinned
  // above the card to point at. A parent outside this page resolves to nothing
  // and the line falls back to "another submission".
  const nameById = useMemo(
    () => new Map(items.map((item) => [item.id, item.fileName])),
    [items],
  )

  const flat = useMemo(
    () => groups.flatMap((group) => [group.head, ...group.children]),
    [groups],
  )

  const checkedCount = items.filter((item) => item.uniqueness !== null).length

  // Repeated work on this campaign, from the grouping already computed above.
  // A count of duplicates reads like that many problems; the number of cuts
  // handed in more than once is the number of conversations worth having.
  const repeated = useMemo(() => {
    const clusters = groups.filter((group) => group.children.length > 0)
    return {
      clusters: clusters.length,
      videos: clusters.reduce((sum, group) => sum + group.children.length, 0),
      worst: clusters.reduce<(typeof clusters)[number] | null>(
        (worst, group) =>
          worst === null || group.children.length > worst.children.length
            ? group
            : worst,
        null,
      ),
    }
  }, [groups])

  // One per view, because the two arrange the same videos into different rows
  // and paging one by the other's position would cut a list short. Both keys
  // carry the sort and the filter: those really are a different list, and the
  // reader's place in the old one means nothing in the new one.
  const pagedGroups = usePagedList(groups, {
    resetKey: `grouped:${sort}:${String(flaggedOnly)}`,
  })
  const pagedFlat = usePagedList(flat, {
    resetKey: `all:${sort}:${String(flaggedOnly)}`,
  })
  const paged = view === "grouped" ? pagedGroups : pagedFlat

  return (
    <section className="space-y-2.5">
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

        {/* Arrangement, not filtering: both views hold every video, so this
            never changes what is on the page — only whether copies sit under
            their original or stand as cards of their own. */}
        <div className="flex items-center gap-1 rounded-md border p-0.5">
          {FEED_VIEWS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => setView(option.value)}
              title={option.hint}
              className={cn(
                "relative rounded px-2.5 py-1 text-[12px] transition-colors",
                view === option.value
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {view === option.value && (
                <motion.span
                  layoutId="campaign-feed-view"
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
            : view === "grouped"
              ? // Said plainly, because the grid shows 32 cards while the
                // campaign holds 97 videos — without this the two numbers
                // look like a bug.
                `${groups.length} of ${items.length} shown · ${checkedCount} checked against ${campaign.duplicationThreshold}%`
              : `${checkedCount} of ${items.length} checked against ${campaign.duplicationThreshold}%`}
        </span>
      </div>

      {/* Repeated work on this campaign, named. A filename and a count can
          start a conversation with an editor; a percentage cannot. Lives here
          rather than on the dashboard because it is about this campaign. */}
      {!isLoading && repeated.clusters > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-dashed px-3 py-2 text-[12px]">
          <CopyIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span>
            <strong className="font-medium">
              {repeated.clusters === 1
                ? "1 cut"
                : `${repeated.clusters} cuts`}
            </strong>{" "}
            handed in more than once, {repeated.videos} extra{" "}
            {repeated.videos === 1 ? "copy" : "copies"} between them
          </span>
          {repeated.worst !== null && (
            <span
              className="min-w-0 truncate text-muted-foreground"
              title={repeated.worst.head.fileName}
            >
              worst: {repeated.worst.head.fileName} ×
              {repeated.worst.children.length + 1}
            </span>
          )}
        </div>
      )}

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
        <>
          <ul
            className={cn(
              "grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4",
              // Room for the floating selection bar, which otherwise covers the
              // last row of cards.
              visibleSelected.length > 0 && "pb-20",
            )}
          >
            {view === "grouped"
              ? pagedGroups.visible.map((group) => (
                  <FeedGroup
                    key={group.head.id}
                    head={group.head}
                    copies={group.children}
                    threshold={campaign.duplicationThreshold}
                    selected={selected}
                    onToggle={toggle}
                    onCompare={() => setOpenGroupId(group.head.id)}
                  />
                ))
              : pagedFlat.visible.map((submission) => (
                  <li key={submission.id}>
                    <FeedCard
                      submission={submission}
                      threshold={campaign.duplicationThreshold}
                      parentName={
                        submission.parentId === null
                          ? null
                          : (nameById.get(submission.parentId) ?? null)
                      }
                      isSelected={selected.has(submission.id)}
                      onToggle={() => toggle(submission.id)}
                      // A copy in the flat list has no original pinned above it,
                      // so it names what it copied on the card itself.
                      role={isCopy(submission) ? "copy" : "head"}
                    />
                  </li>
                ))}
          </ul>
          {paged.hasMore && (
            <ListSentinel
              ref={paged.sentinelRef}
              shown={paged.shown}
              total={view === "grouped" ? groups.length : flat.length}
              noun={view === "grouped" ? "groups" : "videos"}
            />
          )}
        </>
      )}

      <DuplicateGroupSheet
        group={groups.find((group) => group.head.id === openGroupId) ?? null}
        threshold={campaign.duplicationThreshold}
        selected={selected}
        onToggle={toggle}
        onClose={() => setOpenGroupId(null)}
      />

      {visibleSelected.length > 0 && (
        /* Fixed, not sticky. As the last child of the section, `sticky` pinned
           it to the bottom of the feed rather than the viewport, so on any
           campaign taller than the screen it scrolled away with the content —
           exactly when a long selection most needs its count and Send button. */
        <div className="fixed inset-x-4 bottom-4 z-30 mx-auto flex max-w-3xl items-center gap-3 rounded-lg border bg-background/95 px-4 py-2.5 shadow-lg backdrop-blur">
          <CheckIcon
            className={
              visibleSelected.length > MAX_SHARE_MEDIA
                ? "size-4 text-destructive"
                : "size-4 text-[var(--success)]"
            }
          />
          <span className="text-[13px]">
            {visibleSelected.length === 1
              ? "1 video selected"
              : `${visibleSelected.length} videos selected`}
            {visibleSelected.length > MAX_SHARE_MEDIA && (
              // Said while they are still choosing, rather than after the
              // dialog is filled in: the share cannot be sent like this.
              <span className="ml-2 text-destructive">
                max {MAX_SHARE_MEDIA} per share
              </span>
            )}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-8 text-[12px]"
            onClick={() => setSelected(new Set())}
          >
            Clear
          </Button>
          <Button
            size="sm"
            className="h-8 text-[12px]"
            onClick={() => setShareOpen(true)}
          >
            <SendIcon className="size-3.5" />
            Send to vendors
          </Button>
        </div>
      )}

      <VendorShareDialog
        campaignId={campaign.id}
        campaignTitle={campaign.title}
        submissionIds={visibleSelected.map((item) => item.id)}
        open={isShareOpen}
        onOpenChange={setShareOpen}
        onSent={() => setSelected(new Set())}
      />
    </section>
  )
}

/**
 * One video, with a way in to the hand-ins found to be the same cut.
 *
 * The card never expands. Twenty-two copies cannot be read inside a grid cell,
 * and opening one inline pushed every other card down the page — so the copies
 * live in a panel instead. See DuplicateGroupSheet.
 */
function FeedGroup({
  head,
  copies,
  threshold,
  selected,
  onToggle,
  onCompare,
}: {
  head: VideoSubmission & { parentId: string | null }
  copies: (VideoSubmission & { parentId: string | null })[]
  threshold: number
  selected: ReadonlySet<string>
  onToggle: (id: string) => void
  onCompare: () => void
}) {
  const selectedCopies = copies.filter((copy) => selected.has(copy.id)).length

  // The group's duplication is a property of its copies, not of the original
  // they were measured against: a video with sixteen copies at 99% is the most
  // duplicated thing here while its own score reads 16.7.
  const worstCopy = copies.reduce(
    (highest, copy) => Math.max(highest, copy.duplicationScore ?? 0),
    0,
  )
  const overThreshold = copies.filter((copy) => copy.overThreshold).length

  return (
    <li>
      <FeedCard
        submission={head}
        threshold={threshold}
        parentName={null}
        isSelected={selected.has(head.id)}
        onToggle={() => onToggle(head.id)}
        role="head"
        footer={
          copies.length === 0 ? null : (
            // Inside the card's own border: one border per video, the way the
            // rest of the app reads.
            <button
              type="button"
              onClick={onCompare}
              className="flex w-full items-center gap-2 border-t px-3 py-2 text-left text-[12px] transition-colors hover:bg-muted/50"
            >
              <CopyIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="text-muted-foreground">
                {copies.length === 1
                  ? "1 duplicate"
                  : `${copies.length} duplicates`}
              </span>
              <span
                className={cn(
                  "numeric rounded px-1.5 py-0.5 text-[11px]",
                  overThreshold > 0
                    ? "bg-destructive/10 text-destructive"
                    : "bg-muted text-muted-foreground",
                )}
                title={
                  overThreshold > 0
                    ? `${overThreshold} of ${copies.length} reach the campaign threshold`
                    : "None reach the campaign threshold"
                }
              >
                up to {Math.round(worstCopy)}%
              </span>
              <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 text-muted-foreground">
                {selectedCopies > 0 && (
                  <span className="numeric rounded bg-primary/10 px-1.5 py-0.5 text-[11px] text-primary">
                    {selectedCopies} selected
                  </span>
                )}
                <ChevronRightIcon className="size-3.5" />
              </span>
            </button>
          )
        }
      />
    </li>
  )
}

/**
 * The original, and everything handed in that matched it.
 *
 * A panel rather than an inline expansion. The question is "what is a copy of
 * this one", and it stays answerable only while the original is on screen
 * beside its copies — inline, a group of twenty-two scrolled the original away
 * and reflowed every card around it.
 */
function DuplicateGroupSheet({
  group,
  threshold,
  selected,
  onToggle,
  onClose,
}: {
  group: DuplicateGroup<VideoSubmission & { parentId: string | null }> | null
  threshold: number
  selected: ReadonlySet<string>
  onToggle: (id: string) => void
  onClose: () => void
}) {
  // The original counts too: it is selectable in the panel like any copy.
  const selectedHere =
    group === null
      ? 0
      : [group.head, ...group.children].filter((video) => selected.has(video.id))
          .length

  return (
    <Sheet open={group !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        // Wider than the default sm:max-w-sm: two videos have to sit side by
        // side for a comparison to be worth opening.
        className="w-full gap-0 p-0 sm:max-w-3xl"
      >
        {group !== null && (
          <>
            {/* shrink-0: the header is a flex sibling of the scroll area, and
                without it a long list of copies squeezes the title. */}
            <SheetHeader className="shrink-0 gap-1 border-b px-5 py-4 pr-12">
              <SheetTitle className="truncate text-[15px]">
                {group.head.fileName}
              </SheetTitle>
              <SheetDescription className="text-[12px]">
                {group.children.length === 1
                  ? "1 hand-in matched this video"
                  : `${group.children.length} hand-ins matched this video`}
                , against this campaign&rsquo;s {threshold}% limit.
              </SheetDescription>
            </SheetHeader>

            <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
              {/* Scrolls away with everything else. Pinned, a whole video card
                  ate most of the panel and left a letterbox to read the copies
                  through; the header above already keeps the original named. */}
              <div className="pt-4 pb-4">
                <p className="mb-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                  Original
                </p>
                <FeedCard
                  submission={group.head}
                  threshold={threshold}
                  parentName={null}
                  isSelected={selected.has(group.head.id)}
                  onToggle={() => onToggle(group.head.id)}
                  role="head"
                />
              </div>

              {/* This one line does stick: it costs a row of height rather
                  than a video, and keeps a long list of copies labelled. */}
              <p
                className="sticky top-0 z-10 -mx-5 truncate bg-background px-5 pt-1 pb-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase"
                title={group.head.fileName}
              >
                Duplicates of {group.head.fileName}
              </p>
              <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                {group.children.map((copy) => (
                  <FeedCard
                    key={copy.id}
                    submission={copy}
                    threshold={threshold}
                    // The sticky heading above names the original; repeating it
                    // on every card would print the same line once per copy.
                    parentName={null}
                    isSelected={selected.has(copy.id)}
                    onToggle={() => onToggle(copy.id)}
                    role="copy"
                  />
                ))}
              </div>
            </div>

            {/* The feed's own selection bar is sticky inside the page behind
                this overlay, so it is invisible while the panel is open. The
                count has to be readable where the selecting happens. */}
            {selectedHere > 0 && (
              <div className="flex shrink-0 items-center gap-3 border-t bg-background px-5 py-3">
                <CheckIcon className="size-4 shrink-0 text-primary" />
                <span className="numeric text-[13px]">
                  {selectedHere} selected here
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto h-8 text-[12px]"
                  onClick={onClose}
                >
                  Done
                </Button>
              </div>
            )}
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}

function FeedCard({
  submission,
  threshold,
  parentName,
  isSelected,
  onToggle,
  role,
  footer,
}: {
  submission: VideoSubmission
  threshold: number
  /** The file name of the video this one was labelled against, if known. */
  parentName: string | null
  isSelected: boolean
  onToggle: () => void
  /**
   * Which half of a group this card is. The feed shows two labels only, so a
   * PARTIAL reads as UNIQUE when it heads a group and DUPLICATE when it sits
   * under one — the score it carries is unchanged either way.
   */
  role: "head" | "copy"
  /** Rendered inside the card's own border, below everything else. */
  footer?: ReactNode
}) {
  const [isUnplayable, setUnplayable] = useState(false)
  // Even preload="metadata" is a request per player, so a campaign feed of a
  // hundred cards fetches only the ones near the reader.
  const [cardRef, isNear] = useNearViewport<HTMLDivElement>()
  const relation = relationLine(submission, parentName, role)

  return (
    <div
      ref={cardRef}
      className={cn(
        "overflow-hidden rounded-lg border transition-colors",
        isSelected && "border-ring bg-muted/30",
      )}
    >
      {/* Name and verdict on one row, the relation folded under it rather than
          taking a band of its own. Two bands became one. */}
      <div className="flex items-start gap-2 border-b px-3 py-1.5">
        <Checkbox
          checked={isSelected}
          onCheckedChange={onToggle}
          aria-label={`Select ${submission.fileName}`}
          className="mt-1"
        />
        <span className="min-w-0 flex-1">
          <span
            className="block truncate text-[13px] font-medium"
            title={submission.fileName}
          >
            {submission.fileName}
          </span>
          {relation !== null && (
            <span
              className="block truncate text-[11px] text-muted-foreground"
              title={`Against this campaign's ${threshold}% limit`}
            >
              {relation}
            </span>
          )}
        </span>
        <UniquenessBadge
          uniqueness={submission.uniqueness}
          partialAs={role === "head" ? "UNIQUE" : "DUPLICATE"}
          value={submission.duplicationScore}
          pendingLabel={
            submission.duplicationCheckedAt === null ? "Checking" : "Unreadable"
          }
          className="mt-0.5 shrink-0"
        />
      </div>

      {isUnplayable ? (
        <div className="flex aspect-video items-center justify-center bg-muted/40 px-4 text-center text-[12px] text-muted-foreground">
          This video cannot be played in the browser.
        </div>
      ) : isNear ? (
        <video
          controls
          preload="metadata"
          src={submission.playbackUrl}
          onError={() => setUnplayable(true)}
          className="aspect-video w-full bg-black"
        />
      ) : (
        // Holds the card's height so the grid does not reflow underneath the
        // reader when a video further up finally arrives.
        <div className="aspect-video w-full bg-muted/30" />
      )}

      <div className="flex items-center gap-x-2 px-3 py-1.5 text-[11px] text-muted-foreground">
        <span className="min-w-0 truncate">{submission.editorName}</span>
        <MetaDivider />
        <span className="numeric shrink-0">
          {fileSize(submission.sizeBytes)}
        </span>
        <span className="numeric ml-auto shrink-0">
          {relativeTime(submission.createdAt)}
        </span>
      </div>

      {footer}
    </div>
  )
}

/**
 * "Duplicate of final-cut.mp4" — the one line that turns a label into a
 * finding. UNIQUE videos get nothing: the best match a UNIQUE video carries
 * is bookkeeping for a later threshold edit, not something it was copied
 * from, and naming it would read as an accusation.
 */
function relationLine(
  submission: VideoSubmission,
  parentName: string | null,
  role: "head" | "copy",
): string | null {
  // A head is the thing others were measured against, so it has nothing to be
  // "of" — including a PARTIAL head, whose own best match is bookkeeping for a
  // later threshold edit rather than something it was copied from.
  if (role === "head") return null
  return `Duplicate of ${parentName ?? "another submission"}`
}

function FeedSkeleton() {
  return (
    <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
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
