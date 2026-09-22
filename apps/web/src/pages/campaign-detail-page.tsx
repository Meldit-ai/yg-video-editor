import { useEffect, useState } from "react"
import type { ReactNode } from "react"
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  LayersIcon,
  SparklesIcon,
  RotateCwIcon,
  SearchXIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { motion, useReducedMotion } from "motion/react"
import { Link, useParams } from "react-router-dom"

import { useAuth } from "@/auth/auth-context"
import { CampaignSubmissions } from "@/components/campaign-submissions"
import { PostedVideos } from "@/components/posted-videos"
import { EmptyState } from "@/components/empty-state"
import { MetaDivider, PageHeader } from "@/components/page-header"
import { CampaignStatusBadge } from "@/components/status-badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { errorMessage } from "@/hooks/use-collection"
import { ApiError, api } from "@/lib/api"
import { fullDate, relativeTime, shortDate } from "@/lib/format"
import type { Campaign } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * One message covers both "this campaign was deleted" and "this campaign is
 * paused, so it is not yours to see": the API answers 404 either way, and
 * saying more here would leak the existence of campaigns an editor cannot open.
 */
const NOT_FOUND_DESCRIPTION =
  "It may have been deleted, paused, or never existed. Campaigns that are not currently running are not listed."

type LoadState =
  | { status: "loading" }
  | { status: "ready"; campaign: Campaign }
  /** `notFound` splits the 404 wording from every other failure. */
  | { status: "error"; notFound: boolean; message: string }

/** Section label shared by every panel — carried over from the admin sheet. */
function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
      {children}
    </p>
  )
}

function DetailField({
  label,
  className,
  children,
}: {
  label: string
  className?: string
  children: ReactNode
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <FieldLabel>{label}</FieldLabel>
      {children}
    </div>
  )
}

/**
 * A long-form field in its own panel. The text is never truncated or clamped —
 * reading the whole brief is the entire purpose of this page — and line breaks
 * survive exactly as they were typed.
 */
function ProsePanel({
  label,
  text,
  placeholder,
}: {
  label: string
  text: string | null
  placeholder: string
}) {
  const hasText = (text ?? "").trim().length > 0
  return (
    <section className="panel-sheen space-y-2.5 rounded-lg border bg-card p-4">
      <FieldLabel>{label}</FieldLabel>
      {hasText ? (
        // `pre-wrap` keeps typed line breaks but will not break inside a long
        // unbroken token; briefs routinely carry pasted URLs and asset paths.
        <p className="text-[13px] leading-relaxed break-words whitespace-pre-wrap">
          {text}
        </p>
      ) : (
        <p className="text-[13px] text-muted-foreground">{placeholder}</p>
      )}
    </section>
  )
}

/**
 * The tracker label in the header strip. Shows the denormalised display name
 * when there is one and falls back to the raw id — monospaced, so a uuid stays
 * scannable — matching how the campaigns table labels the same link.
 */
function TrackerChip({ campaign }: { campaign: Campaign }) {
  const name = campaign.trackerCampaignName?.trim() ?? ""
  const text = name || campaign.trackerCampaignId
  if (!text) return null
  return (
    <span
      title={text}
      className={cn(
        "inline-block max-w-[22ch] truncate rounded-md border bg-muted/40 px-1.5 py-0.5 text-[11px] text-muted-foreground sm:max-w-[36ch]",
        name === "" && "numeric font-mono",
      )}
    >
      {text}
    </span>
  )
}

/** The two things an editor does on a campaign: hand work in, and see how it did. */
const EDITOR_TABS = [
  { value: "submissions", label: "Submissions" },
  { value: "posted", label: "On Instagram" },
] as const

type EditorTab = (typeof EDITOR_TABS)[number]["value"]

/**
 * Submissions and posted work as tabs rather than stacked panels.
 *
 * Stacked, the posted panel pushed the upload button and the videos below the
 * fold on every campaign. They are also two different questions — "hand this
 * in" and "how did it do" — and switching reads better than scrolling past
 * one to reach the other.
 */
function EditorTabs({ campaignId }: { campaignId: string }) {
  const [tab, setTab] = useState<EditorTab>("submissions")
  const reduceMotion = useReducedMotion()

  return (
    <div className="flex flex-col gap-3">
      <div className="flex w-fit items-center gap-1 rounded-lg border bg-muted/40 p-0.5">
        {EDITOR_TABS.map((option) => {
          const isSelected = tab === option.value
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={isSelected}
              onClick={() => setTab(option.value)}
              className={cn(
                "relative rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                isSelected
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {isSelected && (
                <motion.span
                  aria-hidden
                  layoutId="campaign-editor-tab"
                  transition={
                    reduceMotion
                      ? { duration: 0 }
                      : { type: "spring", stiffness: 520, damping: 42 }
                  }
                  className="absolute inset-0 rounded-md border bg-background"
                />
              )}
              <span className="relative">{option.label}</span>
            </button>
          )
        })}
      </div>

      {/* Both stay mounted: switching back should not refetch the list or
          restart a video somebody was part way through. */}
      <div hidden={tab !== "submissions"}>
        <CampaignSubmissions campaignId={campaignId} />
      </div>
      <div hidden={tab !== "posted"}>
        <PostedVideos campaignId={campaignId} />
      </div>
    </div>
  )
}

function BackLink() {
  return (
    <Link
      to="/campaigns"
      className="-ml-1.5 inline-flex w-fit items-center gap-1.5 rounded-md px-1.5 py-1 text-[13px] text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <ArrowLeftIcon className="size-3.5" />
      All campaigns
    </Link>
  )
}

/** Mirrors the real layout — header block, then two panels — so the page does
 *  not reflow when the data lands. */
function DetailSkeleton() {
  return (
    <div className="flex w-full max-w-6xl flex-col gap-4">
      <div className="space-y-2.5">
        <Skeleton className="h-4 w-[240px]" />
        <div className="flex items-center gap-2">
          <Skeleton className="h-5 w-[70px] rounded-full" />
          <Skeleton className="h-5 w-[120px] rounded-md" />
          <Skeleton className="h-3 w-[150px]" />
        </div>
      </div>

      {["brief", "guidance"].map((panel) => (
        <div
          key={panel}
          className="panel-sheen space-y-3 rounded-lg border bg-card p-4"
        >
          <Skeleton className="h-2.5 w-[64px]" />
          <div className="space-y-2">
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-[92%]" />
            <Skeleton className="h-3 w-[78%]" />
          </div>
        </div>
      ))}
    </div>
  )
}

/**
 * Campaign detail, for every role. The brief itself is read-only here — admins
 * still edit campaigns from the table — and the one thing this page can change
 * is the submissions panel, which is where an editor hands in a cut.
 */
export function CampaignDetailPage() {
  const { id } = useParams<{ id: string }>()
  // Bumped by "Try again" — the effect keys off it, so a retry re-runs the
  // same fetch without duplicating the load logic.
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<LoadState>({ status: "loading" })
  const reduceMotion = useReducedMotion()
  const { user } = useAuth()
  // Presentation only — the API scopes what each role can actually read.
  const isAdmin = user?.role === "ADMIN"

  useEffect(() => {
    if (id === undefined || id.length === 0) {
      setState({
        status: "error",
        notFound: true,
        message: NOT_FOUND_DESCRIPTION,
      })
      return
    }

    // A slow response for the previous id must not overwrite the new one.
    let cancelled = false
    setState({ status: "loading" })

    void (async () => {
      try {
        const campaign = await api.get<Campaign>(
          `/campaigns/${encodeURIComponent(id)}`,
        )
        if (!cancelled) setState({ status: "ready", campaign })
      } catch (caught) {
        if (cancelled) return
        setState({
          status: "error",
          notFound: caught instanceof ApiError && caught.status === 404,
          message: errorMessage(caught),
        })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [id, attempt])

  if (state.status === "loading") return <DetailSkeleton />

  if (state.status === "error") {
    return (
      <div className="flex w-full max-w-6xl flex-col gap-4">
        <BackLink />
        <div className="panel-sheen rounded-lg border bg-card">
          {state.notFound ? (
            <EmptyState
              icon={SearchXIcon}
              title="Campaign not found"
              description={NOT_FOUND_DESCRIPTION}
              action={
                <Button asChild variant="outline" size="sm">
                  <Link to="/campaigns">
                    <ArrowLeftIcon />
                    All campaigns
                  </Link>
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={TriangleAlertIcon}
              title="Could not load campaign"
              description={state.message}
              action={
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setAttempt((count) => count + 1)}
                  >
                    <RotateCwIcon />
                    Try again
                  </Button>
                  <Button asChild variant="ghost" size="sm">
                    <Link to="/campaigns">All campaigns</Link>
                  </Button>
                </div>
              }
            />
          )}
        </div>
      </div>
    )
  }

  const { campaign } = state

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: reduceMotion ? 0 : 0.15, ease: "easeOut" }}
      className="flex w-full max-w-6xl flex-col gap-4"
    >
      {/* The feed sits on this row rather than below the page: a campaign can
          carry hundreds of videos, and a link under them is a link nobody
          reaches. Admin-only — an editor is never shown other people's cuts. */}
      <div className="flex items-center justify-between gap-3">
        <BackLink />
        {isAdmin && (
          <Link
            to={`/campaigns/${campaign.id}/feed`}
            className="group -mr-1.5 inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[13px] text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <LayersIcon className="size-3.5" />
            Campaign feed
            <ArrowRightIcon className="size-3.5 transition-transform group-hover:translate-x-0.5" />
          </Link>
        )}
        {isAdmin && campaign.trackerCampaignId !== null && (
          <Link
            to={`/campaigns/${campaign.id}/matches`}
            className="group -mr-1.5 inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[13px] text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <SparklesIcon className="size-3.5" />
            Instagram matches
            <ArrowRightIcon className="size-3.5 transition-transform group-hover:translate-x-0.5" />
          </Link>
        )}
      </div>

      <PageHeader
        title={campaign.title}
        meta={
          // PageHeader's meta row does not wrap, and this strip is longer than
          // any other caller's. Wrapping it in one flex item lets it break
          // between phrases at phone widths instead of mid-phrase.
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <CampaignStatusBadge status={campaign.status} />
            <TrackerChip campaign={campaign} />
            <MetaDivider />
            <span>
              Created{" "}
              <span className="numeric text-foreground">
                {shortDate(campaign.createdAt)}
              </span>
            </span>
            <MetaDivider />
            <span>
              Updated{" "}
              <span className="numeric text-foreground">
                {relativeTime(campaign.updatedAt)}
              </span>
            </span>
          </div>
        }
      />

      <ProsePanel
        label="Brief"
        text={campaign.briefText}
        placeholder="No brief written yet."
      />

      <ProsePanel
        label="Guidance note"
        text={campaign.guidanceNote}
        placeholder="No guidance note yet."
      />

      {/* Above the record metadata on purpose: handing in a cut is what an
          editor opens this page to do, the ids at the bottom are reference. */}
      {/* Editors get two tabs; an admin has the matches page for the same
          findings across every editor, so there is nothing to switch between
          and the submissions stand alone. */}
      {isAdmin ? (
        <CampaignSubmissions campaignId={campaign.id} />
      ) : (
        <EditorTabs campaignId={campaign.id} />
      )}

      <section className="grid grid-cols-2 gap-4 rounded-lg border bg-muted/20 p-4">
        <DetailField label="Created">
          <p className="numeric text-[13px] text-muted-foreground">
            {fullDate(campaign.createdAt)}
          </p>
        </DetailField>
        <DetailField label="Updated">
          <p className="numeric text-[13px] text-muted-foreground">
            {fullDate(campaign.updatedAt)}
          </p>
        </DetailField>

        {/* The header shows the tracker's display name; the id only appears
            here, so a linked campaign is still traceable back to the tracker. */}
        {campaign.trackerCampaignId && (
          <DetailField label="Tracker" className="col-span-2">
            <p className="numeric font-mono text-[11px] break-all text-muted-foreground">
              {campaign.trackerCampaignId}
            </p>
          </DetailField>
        )}

        <DetailField label="Record" className="col-span-2">
          <p className="numeric font-mono text-[11px] break-all text-muted-foreground">
            {campaign.id}
          </p>
        </DetailField>
      </section>
    </motion.div>
  )
}
