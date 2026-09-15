import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import {
  ClapperboardIcon,
  CopyCheckIcon,
  LayersIcon,
  WalletIcon,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"

import { useAuth } from "@/auth/auth-context"
import { EmptyState } from "@/components/empty-state"
import { MetaDivider, PageHeader } from "@/components/page-header"
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
  const cleanRate =
    stats.videosUploaded === 0
      ? null
      : Math.round(
          ((stats.videosUploaded - stats.duplicateCount) /
            stats.videosUploaded) *
            100,
        )

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          icon={ClapperboardIcon}
          label="Videos submitted"
          value={String(stats.videosUploaded)}
        />
        <Stat
          icon={CopyCheckIcon}
          label="Flagged as duplicate"
          value={String(stats.duplicateCount)}
          hint={cleanRate === null ? undefined : `${cleanRate}% clean`}
          tone={stats.duplicateCount > 0 ? "warning" : "default"}
        />
        <Stat
          icon={LayersIcon}
          label="Average duplicacy"
          // Null means nothing has been compared yet — not 0%.
          value={
            stats.averageDuplicationScore === null
              ? "—"
              : `${stats.averageDuplicationScore}%`
          }
          hint={
            stats.averageDuplicationScore === null
              ? "Nothing checked yet"
              : undefined
          }
        />
        <Stat
          icon={WalletIcon}
          label="Value submitted"
          value={
            stats.estimatedEarnings === null
              ? "—"
              : rupees(stats.estimatedEarnings)
          }
          hint={
            stats.rateCard === null
              ? "Rate not set"
              : `${rupees(stats.rateCard)} per video`
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
            {stats.perCampaign.map((row) => (
              <Link
                key={row.campaignId}
                to={`/campaigns/${row.campaignId}`}
                className="flex items-center justify-between gap-4 px-4 py-3 transition-colors hover:bg-muted/40"
              >
                <span className="min-w-0 flex-1 truncate text-[14px]">
                  {row.campaignTitle}
                </span>
                <span className="numeric shrink-0 text-[13px] text-muted-foreground">
                  {row.videos === 1 ? "1 video" : `${row.videos} videos`}
                </span>
                <span
                  className={cn(
                    "numeric w-24 shrink-0 text-right text-[13px]",
                    row.duplicates > 0
                      ? "text-[var(--warning)]"
                      : "text-muted-foreground",
                  )}
                >
                  {row.duplicates === 0
                    ? "none flagged"
                    : `${row.duplicates} flagged`}
                </span>
              </Link>
            ))}
          </CardContent>
        </Card>

        <p className="text-[12px] text-muted-foreground">
          Value submitted is your rate card times the videos you have handed
          in. It is a measure of work done, not an invoice.
        </p>
      </section>
    </div>
  )
}

function Stat({
  icon: Icon,
  label,
  value,
  hint,
  tone = "default",
}: {
  icon: LucideIcon
  label: string
  value: string
  hint?: string
  tone?: "default" | "warning"
}) {
  return (
    <Card className="py-0">
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
            tone === "warning" && "text-[var(--warning)]",
          )}
        >
          {value}
        </p>
        {hint !== undefined && (
          <p className="text-[12px] text-muted-foreground">{hint}</p>
        )}
      </CardContent>
    </Card>
  )
}

function StatSkeletons() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {[0, 1, 2, 3].map((index) => (
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
