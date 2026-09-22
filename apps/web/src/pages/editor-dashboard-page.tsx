import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import {
  ClapperboardIcon,
  CopyCheckIcon,
  LayersIcon,
  SparklesIcon,
  WalletIcon,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"

import { useAuth } from "@/auth/auth-context"
import { EmptyState } from "@/components/empty-state"
import { MetaDivider, PageHeader } from "@/components/page-header"
import { ProfileCard } from "@/components/profile-card"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { errorMessage } from "@/hooks/use-collection"
import { api } from "@/lib/api"
import { rupees } from "@/lib/format"
import type { EditorDashboardStats } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * The first screen a signed-in user lands on: their own submissions, summed.
 *
 * Open to both roles. An admin has usually submitted nothing and sees the
 * empty state, which is honest — the numbers are per-person, not per-team.
 */
export function EditorDashboardPage() {
  const { user } = useAuth()
  const [stats, setStats] = useState<EditorDashboardStats | null>(null)
  const [isLoading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .get<EditorDashboardStats>("/dashboard/me")
      .then((data) => {
        if (!cancelled) setStats(data)
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(errorMessage(caught))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={user ? `Hello, ${user.name.split(" ")[0]}` : "Dashboard"}
        description="Your submissions across every campaign."
        meta={
          stats === null ? null : (
            <>
              <span>
                {stats.videosUploaded === 1
                  ? "1 video"
                  : `${stats.videosUploaded} videos`}
              </span>
              <MetaDivider />
              <span>
                {stats.campaignsContributed === 1
                  ? "1 campaign"
                  : `${stats.campaignsContributed} campaigns`}
              </span>
            </>
          )
        }
      />

      <ProfileCard />

      {isLoading ? (
        <StatSkeletons />
      ) : error !== null ? (
        <EmptyState
          icon={LayersIcon}
          title="Could not load your dashboard"
          description={error}
        />
      ) : stats === null || stats.videosUploaded === 0 ? (
        <EmptyState
          icon={ClapperboardIcon}
          title="No videos submitted yet"
          description="Once you hand in a cut against a campaign brief, your stats will show up here."
        />
      ) : (
        <Dashboard stats={stats} />
      )}
    </div>
  )
}

function Dashboard({ stats }: { stats: EditorDashboardStats }) {
  // Out of what was actually checked, not out of everything handed in. The old
  // reading counted "no run has reached it yet" as clean, so an editor's score
  // started at 100% and only ever fell as the engine caught up with them.
  const checked = stats.uniqueCount + stats.duplicateCount
  const uniqueRate =
    checked === 0 ? null : Math.round((stats.uniqueCount / checked) * 100)

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Stat
          icon={ClapperboardIcon}
          label="Videos submitted"
          value={String(stats.videosUploaded)}
          hint={
            stats.uncheckedCount === 0
              ? undefined
              : `${stats.uncheckedCount} not checked yet`
          }
        />
        {/* The rate leads: "34 unique" means nothing without what it is out
            of, and the share of checked work is what an editor is judged on. */}
        <Stat
          icon={SparklesIcon}
          label="Original work"
          value={uniqueRate === null ? "—" : `${uniqueRate}%`}
          hint={
            uniqueRate === null
              ? "Nothing checked yet"
              : `${stats.uniqueCount} of ${checked} checked`
          }
          tone={
            uniqueRate === null
              ? "default"
              : uniqueRate >= 50
                ? "success"
                : "warning"
          }
        />
        <Stat
          icon={CopyCheckIcon}
          label="Duplicate"
          value={String(stats.duplicateCount)}
          hint={
            stats.duplicateCount === 0 && checked > 0
              ? "None so far"
              : undefined
          }
          tone={stats.duplicateCount > 0 ? "warning" : "default"}
        />
        {/* Not "average duplicacy": a mean across unique and duplicate
            videos alike is a number nobody can act on. How many briefs the
            editor is working against is something they recognise. */}
        <Stat
          icon={LayersIcon}
          label="Campaigns"
          value={String(stats.campaignsContributed)}
          hint={
            stats.averageDuplicationScore === null
              ? undefined
              : `${stats.averageDuplicationScore}% average match`
          }
        />
        <Stat
          icon={WalletIcon}
          label="Payable"
          value={
            stats.estimatedEarnings === null
              ? "—"
              : rupees(stats.estimatedEarnings)
          }
          hint={
            stats.rateCard === null
              ? "Rate not set"
              : `${stats.payableCount} of ${stats.videosUploaded} videos · ${rupees(stats.rateCard)} each`
          }
        />
      </div>

      <section className="space-y-3">
        <div className="flex items-center gap-3">
          <h2 className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
            By campaign
          </h2>
          <span aria-hidden className="h-px flex-1 bg-border" />
        </div>

        <Card className="overflow-hidden py-0">
          <CardContent className="divide-y p-0">
            {/* Without this the three numbers on each row are a guess. */}
            <div className="flex items-center justify-between gap-4 bg-muted/30 px-4 py-2 text-[11px] tracking-wide text-muted-foreground uppercase">
              <span className="min-w-0 flex-1">Campaign</span>
              <span className="shrink-0">Videos</span>
              <span className="flex w-40 shrink-0 items-center justify-end gap-2">
                <span className="text-success">Unique</span>
                <span aria-hidden className="text-border">/</span>
                <span>Duplicate</span>
              </span>
            </div>
            {stats.perCampaign.map((row) => (
              <div
                key={row.campaignId}
                className="flex items-center justify-between gap-4 px-4 py-3 transition-colors hover:bg-muted/20"
              >
                <Link
                  to={`/campaigns/${row.campaignId}`}
                  className="min-w-0 flex-1 truncate rounded text-[14px] outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  {row.campaignTitle}
                </Link>
                <Link
                  to={`/campaigns/${row.campaignId}`}
                  className="numeric shrink-0 rounded text-[13px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  {row.videos === 1 ? "1 video" : `${row.videos} videos`}
                </Link>
                {/* The split, in the same three words the rest of the app
                    uses. An unchecked video is named as such rather than
                    counted as clean. */}
                <span className="numeric flex w-40 shrink-0 items-center justify-end gap-2 text-[13px]">
                  <CountLink
                    to={`/campaigns/${row.campaignId}?uniqueness=UNIQUE`}
                    count={row.unique}
                    label="unique"
                    className="text-success"
                  />
                  <span aria-hidden className="text-border">
                    /
                  </span>
                  <CountLink
                    to={`/campaigns/${row.campaignId}?uniqueness=DUPLICATE`}
                    count={row.duplicates}
                    label="duplicate"
                    className={
                      row.duplicates > 0
                        ? "text-warning"
                        : "text-muted-foreground"
                    }
                  />
                  {row.unchecked > 0 && (
                    <CountLink
                      to={`/campaigns/${row.campaignId}?uniqueness=unchecked`}
                      count={row.unchecked}
                      label="not checked yet"
                      prefix="+"
                      className="text-muted-foreground"
                    />
                  )}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>

        <p className="text-[12px] text-muted-foreground">
          Payable counts your original work, and anything of yours that reached
          Instagram. Handing in the same cut twice is one piece of work, so a
          copy earns nothing unless it is the one that got posted. It is a
          measure of work done, not an invoice.
        </p>
      </section>
    </div>
  )
}

/**
 * One number in a row, opening the videos it counts.
 *
 * A zero is not a link: there is nothing to open, and a dead link that lands
 * on an empty list reads as a bug.
 */
function CountLink({
  to,
  count,
  label,
  prefix = "",
  className,
}: {
  to: string
  count: number
  label: string
  prefix?: string
  className?: string
}) {
  if (count === 0) {
    return (
      <span className={className}>
        {prefix}
        {count}
      </span>
    )
  }
  return (
    <Link
      to={to}
      title={`${count} ${label}`}
      className={cn(
        "rounded outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50",
        className,
      )}
    >
      {prefix}
      {count}
    </Link>
  )
}

function Stat({
  icon: Icon,
  label,
  value,
  hint,
  tone = "default",
  to,
}: {
  icon: LucideIcon
  label: string
  value: string
  hint?: string
  tone?: "default" | "warning" | "success"
  /**
   * Where this number lives. A count the reader cannot open is a dead end —
   * every stat that stands for a set of videos links to that set.
   */
  to?: string
}) {
  const body = (
    <CardContent className="flex flex-col gap-1.5 p-4">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Icon className="size-3.5" />
          <span className="text-[11px] font-medium tracking-wide uppercase">
            {label}
          </span>
        </div>
        <p
          className={cn(
            "numeric text-2xl leading-none font-semibold",
            tone === "warning" && "text-warning",
            tone === "success" && "text-success",
          )}
        >
          {value}
        </p>
        {hint !== undefined && (
          <p className="text-[12px] text-muted-foreground">{hint}</p>
        )}
      </CardContent>
  )

  if (to === undefined) return <Card className="py-0">{body}</Card>
  return (
    <Card className="py-0 transition-colors hover:border-ring hover:bg-muted/30">
      <Link to={to} className="block rounded-xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
        {body}
      </Link>
    </Card>
  )
}

function StatSkeletons() {
  return (
    // Five, matching the cards it stands in for: a skeleton of a different
    // shape makes the page jump when the data lands.
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
      {[0, 1, 2, 3, 4].map((index) => (
        <Card key={index} className="py-0">
          <CardContent className="flex flex-col gap-2.5 p-4">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-6 w-16" />
            <Skeleton className="h-3 w-20" />
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
