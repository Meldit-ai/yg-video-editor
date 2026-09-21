import { useEffect, useState } from "react"
import { Link, useParams } from "react-router-dom"
import {
  ArrowLeftIcon,
  ExternalLinkIcon,
  Loader2Icon,
  SparklesIcon,
  EyeIcon,
} from "lucide-react"
import { toast } from "sonner"

import { EmptyState } from "@/components/empty-state"
import { MetaDivider, PageHeader } from "@/components/page-header"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { errorMessage } from "@/hooks/use-collection"
import { api } from "@/lib/api"
import { compact, fullDate } from "@/lib/format"
import { cn } from "@/lib/utils"
import { MATCH_GROUP_SORTS, type MatchGroupSort } from "@/lib/types"
import type {
  Campaign,
  MatchedReel,
  MatchGroup,
  MatchRunResult,
  ReelEngagement,
} from "@/lib/types"

/** Reels read per run. Each is a download and a decode, so a run is bounded. */
const REEL_BATCH = 500

/**
 * Edits that also went out as Instagram reels on this campaign.
 *
 * Grouped by edit rather than listed pair by pair: one cut is often posted by
 * several accounts, and seeing them together is what shows how far it spread.
 * Every reel in a group is an exact match — the group is not a ranking, and
 * there is no weaker member in it.
 */
export function CampaignMatchesPage() {
  const { id } = useParams<{ id: string }>()
  const [campaign, setCampaign] = useState<Campaign | null>(null)
  const [groups, setGroups] = useState<MatchGroup[] | null>(null)
  const [isRunning, setRunning] = useState(false)
  // Most viewed first by default: "which edit performed best" is the question
  // this whole pipeline exists to answer.
  const [sort, setSort] = useState<MatchGroupSort>("views")

  useEffect(() => {
    if (id === undefined) return
    let cancelled = false
    Promise.all([
      api.get<Campaign>(`/campaigns/${id}`),
      api.get<MatchGroup[]>(`/campaigns/${id}/matches?sort=${sort}`),
    ])
      .then(([one, found]) => {
        if (cancelled) return
        setCampaign(one)
        setGroups(found)
      })
      .catch((caught: unknown) => {
        if (!cancelled) toast.error(errorMessage(caught))
      })
    return () => {
      cancelled = true
    }
  }, [id, sort])

  async function run() {
    setRunning(true)
    try {
      const result = await api.post<MatchRunResult>(
        `/campaigns/${id}/matches`,
        { reelLimit: REEL_BATCH },
      )
      setGroups(result.matches)
      toast.success(
        result.matchCount === 1
          ? "1 edit matched"
          : `${result.matchCount} edits matched`,
        {
          description:
            result.unhashedReels > 0
              ? `${result.unhashedReels} reels still to check — run again to continue.`
              : "Every reel on this campaign has been checked.",
        },
      )
    } catch (caught) {
      toast.error(errorMessage(caught))
    } finally {
      setRunning(false)
    }
  }

  const reelCount = (groups ?? []).reduce(
    (total, group) => total + group.reels.length,
    0,
  )

  // Null rather than 0 when no group reported anything: "we do not know" is
  // not "nobody watched it".
  const campaignViews =
    groups === null || groups.every((g) => g.totalEngagement.views === null)
      ? null
      : groups.reduce((total, g) => total + (g.totalEngagement.views ?? 0), 0)

  return (
    <div className="space-y-5">
      <Link
        to={`/campaigns/${id}`}
        className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeftIcon className="size-3.5" />
        Back to campaign
      </Link>

      <PageHeader
        title="Instagram matches"
        meta={
          campaign === null ? null : (
            <>
              <span>{campaign.title}</span>
              <MetaDivider />
              <span>
                {groups === null
                  ? "Loading"
                  : `${groups.length} ${groups.length === 1 ? "edit" : "edits"} across ${reelCount} ${reelCount === 1 ? "reel" : "reels"}`}
              </span>
            </>
          )
        }
        action={
          <Button size="sm" onClick={() => void run()} disabled={isRunning}>
            {isRunning ? (
              <Loader2Icon className="animate-spin" />
            ) : (
              <SparklesIcon />
            )}
            {isRunning ? "Checking" : "Check for matches"}
          </Button>
        }
      />

      {/* The campaign's whole reach in one line, then the ordering. Without
          the total, 52 separate numbers never add up to an answer. */}
      {groups !== null && groups.length > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          {campaignViews !== null && (
            <div className="flex items-baseline gap-2 rounded-lg border px-3 py-2">
              <span className="numeric text-xl leading-none font-semibold">
                {compact(campaignViews)}
              </span>
              <span className="text-[12px] text-muted-foreground">
                views across every matched edit
              </span>
            </div>
          )}
          <div className="ml-auto flex items-center gap-1 rounded-md border p-0.5">
            {MATCH_GROUP_SORTS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setSort(option.value)}
                className={cn(
                  "rounded px-2.5 py-1 text-[12px] transition-colors",
                  sort === option.value
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {groups === null ? (
        <div className="space-y-2">
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : groups.length === 0 ? (
        <EmptyState
          icon={SparklesIcon}
          title="No matches yet"
          description="Nothing handed in on this campaign is the same video as one of its Instagram reels. Run a check to look again after new videos arrive."
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {groups.map((group) => (
            <GroupRow key={group.submissionId} group={group} />
          ))}
        </ul>
      )}
    </div>
  )
}

function GroupRow({ group }: { group: MatchGroup }) {
  return (
    <li className="rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="truncate text-[13px] font-medium">
          {group.fileName}
        </span>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] tracking-wide uppercase">
          {group.reels.length === 1
            ? "1 reel"
            : `${group.reels.length} reels`}
        </span>
        {group.origin === "REEL" && (
          // The finding worth seeing first: the footage was already public
          // before the edit was handed in.
          <span className="rounded bg-[var(--warning,theme(colors.amber.500))]/15 px-1.5 py-0.5 text-[11px] tracking-wide text-amber-600 uppercase dark:text-amber-400">
            posted before hand-in
          </span>
        )}

        {/* What this edit earned, added across every reel carrying it. The
            reason the matching exists: one cut posted by nine accounts is one
            piece of work with nine sets of counts. */}
        <span className="ml-auto flex shrink-0 items-baseline gap-1.5">
          {group.totalEngagement.views === null ? (
            <span className="text-[12px] text-muted-foreground">
              No counts yet
            </span>
          ) : (
            <>
              <EyeIcon className="size-3.5 self-center text-muted-foreground" />
              <span className="numeric text-[15px] font-semibold">
                {compact(group.totalEngagement.views)}
              </span>
              <span className="text-[11px] tracking-wide text-muted-foreground uppercase">
                {group.totalEngagement.viewsFromReach ? "reach" : "views"}
              </span>
            </>
          )}
        </span>
      </div>

      {/* The rest of the totals, and how much of the group they cover. */}
      {group.totalEngagement.countedReels > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted-foreground">
          {group.totalEngagement.likes !== null && (
            <span className="numeric">
              {compact(group.totalEngagement.likes)} likes
            </span>
          )}
          {group.totalEngagement.comments !== null && (
            <span className="numeric">
              {compact(group.totalEngagement.comments)} comments
            </span>
          )}
          {group.totalEngagement.shares !== null && (
            <span className="numeric">
              {compact(group.totalEngagement.shares)} shares
            </span>
          )}
          {/* Said plainly when the total does not cover the whole group,
              rather than letting it read as complete. */}
          {group.totalEngagement.countedReels <
            group.totalEngagement.totalReels && (
            <span>
              from {group.totalEngagement.countedReels} of{" "}
              {group.totalEngagement.totalReels} reels
            </span>
          )}
        </div>
      )}

      <div className="mt-2.5 grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <Panel
          label="The edit"
          who={group.editorName}
          when={group.uploadedAt}
          isOriginal={group.origin === "EDITOR"}
          videoUrl={group.playbackUrl}
        />

        <div>
          <p className="mb-1.5 text-[11px] tracking-wide text-muted-foreground uppercase">
            Also posted as
          </p>
          {/* Every reel inline rather than one pair per row: the whole point
              is seeing how many accounts carried the same cut. */}
          <ul className="grid gap-2 sm:grid-cols-2">
            {group.reels.map((reel) => (
              <li key={reel.reelId}>
                <ReelPanel reel={reel} />
              </li>
            ))}
          </ul>
        </div>
      </div>
    </li>
  )
}

function ReelPanel({ reel }: { reel: MatchedReel }) {
  return (
    <Panel
      label={reel.contentHash === null ? "Re-encoded" : "Identical file"}
      who={`@${reel.username}`}
      when={reel.postedAt}
      isOriginal={reel.origin === "REEL"}
      link={reel.permalink}
      videoUrl={reel.reelUrl}
      engagement={reel.engagement}
    />
  )
}

function Panel({
  label,
  who,
  when,
  isOriginal,
  link,
  videoUrl,
  engagement,
}: {
  label: string
  who: string
  when: string | null
  isOriginal: boolean
  link?: string | null
  /** The video itself, so a claimed match can be checked by watching it. */
  videoUrl: string
  /** What this one post earned. Absent on the edit's own panel. */
  engagement?: ReelEngagement | null
}) {
  const [isUnplayable, setUnplayable] = useState(false)

  return (
    <div className="overflow-hidden rounded-md bg-muted/40">
      {videoUrl.length === 0 || isUnplayable ? (
        <div className="flex aspect-video items-center justify-center bg-black/80 text-[12px] text-muted-foreground">
          Video unavailable
        </div>
      ) : (
        <video
          controls
          preload="metadata"
          src={videoUrl}
          onError={() => setUnplayable(true)}
          className="aspect-video w-full bg-black"
        />
      )}

      <div className="px-2.5 py-2">
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] tracking-wide text-muted-foreground uppercase">
            {label}
          </span>
          {isOriginal && (
            <span className="rounded bg-[var(--success)]/15 px-1.5 text-[10px] font-medium tracking-wide text-[var(--success)] uppercase">
              first
            </span>
          )}
          {link != null && (
            <a
              href={link}
              target="_blank"
              rel="noreferrer"
              className="ml-auto text-muted-foreground transition-colors hover:text-foreground"
              aria-label="Open the post"
            >
              <ExternalLinkIcon className="size-3.5" />
            </a>
          )}
        </div>
        <p className="mt-0.5 truncate text-[13px]">{who}</p>
        <p className="text-[12px] text-muted-foreground">
          {when === null ? "Date unknown" : fullDate(when)}
        </p>

        {/* What this individual post did, next to who posted it — the reason
            one account is worth sharing to and another is not. */}
        {engagement !== undefined && (
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 border-t pt-1.5 text-[12px]">
            {engagement === null ? (
              <span className="text-muted-foreground">No counts</span>
            ) : (
              <>
                {engagement.views !== null && (
                  <span
                    className="numeric font-medium"
                    title={
                      engagement.viewsFromReach
                        ? "Reach, shown because this post reports no view count"
                        : "Views"
                    }
                  >
                    {compact(engagement.views)}
                    <span className="ml-1 font-normal text-muted-foreground">
                      {engagement.viewsFromReach ? "reach" : "views"}
                    </span>
                  </span>
                )}
                {engagement.likes !== null && (
                  <span className="numeric text-muted-foreground">
                    {compact(engagement.likes)} likes
                  </span>
                )}
                {engagement.shares !== null && engagement.shares > 0 && (
                  <span className="numeric text-muted-foreground">
                    {compact(engagement.shares)} shares
                  </span>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
