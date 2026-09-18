import { useEffect, useState } from "react"
import { Link, useParams } from "react-router-dom"
import {
  ArrowLeftIcon,
  ExternalLinkIcon,
  Loader2Icon,
  SparklesIcon,
} from "lucide-react"
import { toast } from "sonner"

import { EmptyState } from "@/components/empty-state"
import { MetaDivider, PageHeader } from "@/components/page-header"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { errorMessage } from "@/hooks/use-collection"
import { api } from "@/lib/api"
import { fullDate } from "@/lib/format"
import type {
  Campaign,
  CrossPlatformMatch,
  MatchRunResult,
} from "@/lib/types"

/** Reels hashed per run. Each is a download, so a run is bounded. */
const REEL_BATCH = 500

/**
 * Editor uploads that are the very same file as an Instagram reel.
 *
 * Both dates are shown side by side and the earlier one is named the original,
 * because that is the whole finding: who published it first. Nothing here is
 * scored — a match is an exact one or it is not a match.
 */
export function CampaignMatchesPage() {
  const { id } = useParams<{ id: string }>()
  const [campaign, setCampaign] = useState<Campaign | null>(null)
  const [matches, setMatches] = useState<CrossPlatformMatch[] | null>(null)
  const [isRunning, setRunning] = useState(false)

  useEffect(() => {
    if (id === undefined) return
    let cancelled = false
    Promise.all([
      api.get<Campaign>(`/campaigns/${id}`),
      api.get<CrossPlatformMatch[]>(`/campaigns/${id}/matches`),
    ])
      .then(([one, found]) => {
        if (cancelled) return
        setCampaign(one)
        setMatches(found)
      })
      .catch((caught: unknown) => {
        if (!cancelled) toast.error(errorMessage(caught))
      })
    return () => {
      cancelled = true
    }
  }, [id])

  async function run() {
    setRunning(true)
    try {
      const result = await api.post<MatchRunResult>(
        `/campaigns/${id}/matches`,
        { reelLimit: REEL_BATCH },
      )
      setMatches(result.matches)
      toast.success(
        result.matchCount === 1
          ? "1 match found"
          : `${result.matchCount} matches found`,
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
                {matches === null
                  ? "Loading"
                  : matches.length === 1
                    ? "1 match"
                    : `${matches.length} matches`}
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

      {matches === null ? (
        <div className="space-y-2">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : matches.length === 0 ? (
        <EmptyState
          icon={SparklesIcon}
          title="No matches yet"
          description="Nothing handed in on this campaign is the same file as one of its Instagram reels. Run a check to look again after new videos arrive."
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {matches.map((match) => (
            <MatchRow key={match.id} match={match} />
          ))}
        </ul>
      )}
    </div>
  )
}

function MatchRow({ match }: { match: CrossPlatformMatch }) {
  return (
    <li className="rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="truncate text-[13px] font-medium">
          {match.fileName}
        </span>
        <span className="text-muted-foreground">↔</span>
        <span className="text-[13px]">@{match.username}</span>
        <span className="ml-auto rounded bg-muted px-1.5 py-0.5 text-[11px] tracking-wide uppercase">
          {match.contentHash === null
            ? `${match.frameShare}% of frames`
            : "identical file"}
        </span>
      </div>

      <div className="mt-2.5 grid gap-2 sm:grid-cols-2">
        <Side
          label="Editor handed in"
          who={match.editorName}
          when={match.uploadedAt}
          isOriginal={match.origin === "EDITOR"}
          videoUrl={match.playbackUrl}
        />
        <Side
          label="Posted on Instagram"
          who={`@${match.username}`}
          when={match.postedAt}
          isOriginal={match.origin === "REEL"}
          link={match.permalink}
          videoUrl={match.reelUrl}
        />
      </div>

      {match.contentHash === null && (
        // Worth saying which kind of match this is: an identical file is
        // certain, while shared frames mean the same footage re-encoded.
        <p className="mt-2 text-[12px] text-muted-foreground">
          The same footage, re-encoded — the files differ but the picture does
          not.
        </p>
      )}

      {match.origin === "UNKNOWN" && (
        // Said plainly rather than defaulting to one side: without a post date
        // neither can be shown to have been first.
        <p className="mt-2 text-[12px] text-muted-foreground">
          The reel has no post date, so which came first is unknown.
        </p>
      )}
    </li>
  )
}

function Side({
  label,
  who,
  when,
  isOriginal,
  link,
  videoUrl,
}: {
  label: string
  who: string
  when: string | null
  isOriginal: boolean
  link?: string | null
  /** The video itself, so a claimed match can be checked by watching it. */
  videoUrl: string
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
            original
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
      </div>
    </div>
  )
}
