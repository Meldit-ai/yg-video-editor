import { useEffect, useRef, useState } from "react"
import { Link, useParams } from "react-router-dom"
import {
  ArrowLeftIcon,
  ExternalLinkIcon,
  Loader2Icon,
  SparklesIcon,
  EyeIcon,
  TriangleAlertIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  HeartIcon,
} from "lucide-react"
import { toast } from "sonner"

import { EmptyState } from "@/components/empty-state"
import { ListSentinel } from "@/components/list-sentinel"
import { MetaDivider, PageHeader } from "@/components/page-header"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { errorMessage } from "@/hooks/use-collection"
import { api } from "@/lib/api"
import { useNearViewport } from "@/hooks/use-near-viewport"
import { usePagedList } from "@/hooks/use-paged-list"
import { compact, shortDate } from "@/lib/format"
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
/** Stable identity for "not loaded yet", so paging does not see a new list. */
const EMPTY_GROUPS: MatchGroup[] = []

export function CampaignMatchesPage() {
  const { id } = useParams<{ id: string }>()
  const [campaign, setCampaign] = useState<Campaign | null>(null)
  const [groups, setGroups] = useState<MatchGroup[] | null>(null)
  const [isRunning, setRunning] = useState(false)
  // Most viewed first by default: "which edit performed best" is the question
  // this whole pipeline exists to answer.
  const [sort, setSort] = useState<MatchGroupSort>("views")
  // A group carries a player per account, so a campaign with a hundred matched
  // edits is a very heavy page. Re-sorting is a different ranking of the same
  // rows and starts again from the top, which is where the answer now is.
  const paged = usePagedList(groups ?? EMPTY_GROUPS, { resetKey: sort })

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
      if (result.totalReels === 0) {
        // Nothing was compared, so "0 matches" would be a finding this run did
        // not make. Say why, and what to do about it.
        toast.warning("Nothing to match against", {
          description: result.trackerLinked
            ? "No reels have been imported for this campaign yet. Import them from the reels page, then check again."
            : "This campaign is not linked to a tracker campaign, so it has no reels. Link one in the campaign settings.",
        })
      } else {
        toast.success(
          result.matchCount === 1
            ? "1 edit matched"
            : `${result.matchCount} edits matched`,
          {
            description:
              result.unhashedReels > 0
                ? `${result.unhashedReels} reels still to check — run again to continue.`
                : `Checked against ${result.totalReels.toLocaleString()} reels.`,
          },
        )
      }
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
    <div className="space-y-3">
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

      {/* Said before the button is pressed, not only after: a run with nothing
          to match against comes back "0 matches", which reads exactly like a
          real check that found none. */}
      {campaign !== null && campaign.trackerCampaignId === null && (
        <div className="flex items-start gap-2 rounded-lg border border-dashed px-3 py-2.5 text-[13px]">
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-warning" />
          <p>
            This campaign is not linked to a tracker campaign, so it has no
            reels to match against. Link one in the campaign settings first.
          </p>
        </div>
      )}

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
                // Each ordering says what it measures on hover: "Best
                // response" means nothing without knowing what is rated.
                title={option.hint}
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
        <>
          <ul className="flex flex-col gap-2">
            {paged.visible.map((group) => (
              <GroupRow key={group.submissionId} group={group} />
            ))}
          </ul>
          {paged.hasMore && (
            <ListSentinel
              ref={paged.sentinelRef}
              shown={paged.shown}
              total={groups.length}
              noun="edits"
            />
          )}
        </>
      )}
    </div>
  )
}

/**
 * One edit, and every account that posted it.
 *
 * Built for one decision: is this cut worth pushing to more vendors? So the
 * reach leads, the accounts are ranked by what they earned rather than by
 * date, and the videos stay shut until someone asks for them — a wall of
 * autoloading players buries the numbers the decision actually rests on.
 */
function GroupRow({ group }: { group: MatchGroup }) {
  const [showVideos, setShowVideos] = useState(false)
  // Videos load only once this group is near the viewport, so a campaign with
  // fifty matches fetches the first few rather than all of them at once.
  const [rowRef, isNear] = useNearViewport<HTMLLIElement>()
  const total = group.totalEngagement

  // Best performing account first: which audience worked is the question, and
  // post order answers a different one.
  const reels = [...group.reels].sort(
    (left, right) =>
      (right.engagement?.views ?? -1) - (left.engagement?.views ?? -1),
  )
  const best = reels[0]?.engagement?.views ?? null
  const perReel =
    total.views === null || total.countedReels === 0
      ? null
      : Math.round(total.views / total.countedReels)

  return (
    <li ref={rowRef} className="rounded-lg border">
      {/* One band, not three. The file name, who made it, the reach and the
          secondary counts all sit on a single row so a screen holds several
          matches rather than one and a half. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
        <span
          className="min-w-0 flex-1 truncate text-[13px] font-medium"
          title={group.fileName}
        >
          {group.fileName}
        </span>

        <span className="shrink-0 text-[12px] text-muted-foreground">
          {group.editorName} &middot; {shortDate(group.uploadedAt)}
        </span>

        {group.origin === "REEL" && (
          <span
            className="shrink-0 rounded bg-warning/15 px-1.5 py-0.5 text-[11px] tracking-wide text-warning uppercase"
            title="This footage was public before the edit was handed in"
          >
            posted first
          </span>
        )}

        {/* The reach, and what it is made of, inline rather than as a band of
            stat blocks. The pairing that matters — total against the best
            single post — still reads left to right. */}
        <span className="flex shrink-0 items-baseline gap-1.5">
          <EyeIcon className="size-3.5 self-center text-muted-foreground" />
          <span className="numeric text-[15px] font-semibold">
            {total.views === null ? "—" : compact(total.views)}
          </span>
          <span className="text-[11px] text-muted-foreground">
            {total.viewsFromReach ? "reach" : "views"}
          </span>
        </span>

        {/* Reach says who saw it; this says who did something about it. The
            two disagree often enough that ranking on views alone picks the
            wrong cut to push. */}
        {total.engagement !== null && (
          <span className="flex shrink-0 items-baseline gap-1.5">
            <HeartIcon className="size-3.5 self-center text-muted-foreground" />
            <span className="numeric text-[15px] font-semibold">
              {compact(total.engagement)}
            </span>
            <span className="text-[11px] text-muted-foreground">
              engagement
            </span>
            {total.engagementRate !== null && (
              <span
                className="numeric text-[11px] text-muted-foreground"
                title="Engagement as a share of views"
              >
                ({total.engagementRate}%)
              </span>
            )}
          </span>
        )}

        <span className="numeric shrink-0 text-[12px] text-muted-foreground">
          {best === null ? null : `best ${compact(best)}`}
          {perReel === null ? null : ` · avg ${compact(perReel)}`}
          {` · ${total.countedReels === total.totalReels ? total.totalReels : `${total.countedReels}/${total.totalReels}`} posts`}
        </span>

        <button
          type="button"
          onClick={() => setShowVideos((open) => !open)}
          className="inline-flex shrink-0 items-center gap-1 rounded text-[12px] text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          {showVideos ? (
            <ChevronDownIcon className="size-3.5" />
          ) : (
            <ChevronRightIcon className="size-3.5" />
          )}
          {showVideos ? "Hide" : "Watch"}
        </button>
      </div>

      {/* Accounts on one horizontal line: the comparison is between them, and
          a wrapping grid breaks that reading. */}
      <div className="-mx-px overflow-x-auto border-t px-3 py-2">
        <ul className="flex w-max gap-2">
          <li className="w-44 shrink-0">
            <AccountCard
              handle={group.editorName}
              label="The edit"
              when={group.uploadedAt}
              isOriginal={group.origin === "EDITOR"}
              videoUrl={showVideos && isNear ? group.playbackUrl : null}
              engagement={undefined}
              share={null}
            />
          </li>
          {reels.map((reel) => (
            <li key={reel.reelId} className="w-44 shrink-0">
              <AccountCard
                handle={`@${reel.username}`}
                label={
                  reel.contentHash === null ? "Re-encoded" : "Identical file"
                }
                when={reel.postedAt}
                isOriginal={reel.origin === "REEL"}
                link={reel.permalink}
                videoUrl={showVideos && isNear ? reel.reelUrl : null}
                engagement={reel.engagement}
                share={
                  total.views === null ||
                  total.views === 0 ||
                  reel.engagement?.views == null
                    ? null
                    : Math.round((reel.engagement.views / total.views) * 100)
                }
              />
            </li>
          ))}
        </ul>
      </div>
    </li>
  )
}

/**
 * One account that posted this cut, with what it earned there.
 *
 * The video loads only when asked: `videoUrl` is null while the group is
 * collapsed, so a page of fifty matches does not open fifty players.
 */
function AccountCard({
  handle,
  label,
  when,
  isOriginal,
  link,
  videoUrl,
  engagement,
  share,
}: {
  handle: string
  label: string
  when: string | null
  isOriginal: boolean
  link?: string | null
  /** Null while collapsed — nothing is fetched until someone asks. */
  videoUrl: string | null
  engagement?: ReelEngagement | null
  /** This account's share of the cut's total reach, as a percentage. */
  share: number | null
}) {
  const [isUnplayable, setUnplayable] = useState(false)

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-md border bg-muted/30">
      {videoUrl !== null &&
        (videoUrl.length === 0 || isUnplayable ? (
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
        ))}

      <div className="flex min-w-0 flex-1 flex-col gap-0.5 px-2 py-1.5">
        <div className="flex items-center gap-1">
          {isOriginal && (
            <span
              aria-hidden
              className="size-1.5 shrink-0 rounded-full bg-success"
              title="Posted first"
            />
          )}
          <span
            className="min-w-0 flex-1 truncate text-[12px] font-medium"
            title={handle}
          >
            {handle}
          </span>
          {link != null && (
            <a
              href={link}
              target="_blank"
              rel="noreferrer"
              className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
              aria-label={`Open ${handle}'s post`}
            >
              <ExternalLinkIcon className="size-3" />
            </a>
          )}
        </div>

        {engagement === undefined ? (
          <p className="text-[11px] text-muted-foreground">{label}</p>
        ) : engagement === null ? (
          <p className="text-[11px] text-muted-foreground">No counts</p>
        ) : (
          <>
            <div className="flex items-baseline gap-1">
              <span className="numeric text-[14px] font-semibold">
                {engagement.views === null ? "—" : compact(engagement.views)}
              </span>
              <span className="text-[11px] text-muted-foreground">
                {engagement.viewsFromReach ? "reach" : "views"}
              </span>
            </div>

            {/* The counts themselves, not just a percentage. A bare "9.3%"
                on its own row read as the share of the group's reach, which
                is a different number entirely. */}
            <div className="flex flex-wrap items-baseline gap-x-2 text-[11px] text-muted-foreground">
              {engagement.likes !== null && (
                <span className="numeric">{compact(engagement.likes)} likes</span>
              )}
              {engagement.comments !== null && engagement.comments > 0 && (
                <span className="numeric">
                  {compact(engagement.comments)} comments
                </span>
              )}
              {engagement.saves !== null && engagement.saves > 0 && (
                <span className="numeric">{compact(engagement.saves)} saves</span>
              )}
            </div>
          </>
        )}

        {/* The bar is this account's share of the cut's total reach. The
            engagement rate beside the date is a different measure — response
            against this post's own views — so the two are kept apart and
            each is named. */}
        {share !== null && (
          <span
            aria-hidden
            title={`${share}% of this cut's reach`}
            className="h-0.5 overflow-hidden rounded-full bg-muted"
          >
            <span
              className="block h-full rounded-full bg-foreground/40"
              style={{ width: `${Math.max(share, 2)}%` }}
            />
          </span>
        )}

        <p className="flex items-baseline gap-x-2 text-[11px] text-muted-foreground">
          <span>{when === null ? "Date unknown" : shortDate(when)}</span>
          {engagement?.engagementRate != null && (
            <span
              className="numeric ml-auto"
              title={`${engagement.engagement?.toLocaleString("en-IN")} engagement from ${engagement.views?.toLocaleString("en-IN")} views`}
            >
              {engagement.engagementRate}% engagement
            </span>
          )}
        </p>
      </div>
    </div>
  )
}

