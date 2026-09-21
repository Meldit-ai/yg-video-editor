import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import {
  ClapperboardIcon,
  CopyCheckIcon,
  IndianRupeeIcon,
  LayersIcon,
  SparklesIcon,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"

import { EmptyState } from "@/components/empty-state"
import { MetaDivider, PageHeader } from "@/components/page-header"
import { ProfileCard } from "@/components/profile-card"
import { UniquenessBadge } from "@/components/status-badge"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { errorMessage } from "@/hooks/use-collection"
import { api } from "@/lib/api"
import { relativeTime } from "@/lib/format"
import type { AdminDashboardStats } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * The whole operation, for an admin.
 *
 * Separate page from the editor dashboard, which reads only the caller's own
 * submissions — an admin has usually handed in nothing, so that page greeted
 * them with an empty state.
 */
export function AdminDashboardPage() {
  const [stats, setStats] = useState<AdminDashboardStats | null>(null)
  const [isLoading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .get<AdminDashboardStats>("/dashboard/admin")
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
        title="Overview"
        description="Every campaign, and what has been handed in against them."
        meta={
          stats === null ? null : (
            <>
              <span>
                {stats.activeCampaigns === 1
                  ? "1 campaign"
                  : `${stats.activeCampaigns} campaigns`}
              </span>
              <MetaDivider />
              <span>
                {stats.editors === 1 ? "1 editor" : `${stats.editors} editors`}
              </span>
            </>
          )
        }
      />

      <ProfileCard />

      {isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} className="h-24 w-full rounded-xl" />
          ))}
        </div>
      ) : error !== null ? (
        <EmptyState
          icon={LayersIcon}
          title="Could not load the overview"
          description={error}
        />
      ) : stats === null ? null : (
        <AdminDashboard stats={stats} />
      )}
    </div>
  )
}

function AdminDashboard({ stats }: { stats: AdminDashboardStats }) {
  const checked = stats.unique + stats.duplicates
  const duplicateRate =
    checked === 0 ? null : Math.round((stats.duplicates / checked) * 100)

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          icon={ClapperboardIcon}
          label="Videos handed in"
          value={String(stats.videos)}
          hint={
            stats.unchecked === 0
              ? undefined
              : `${stats.unchecked} not checked yet`
          }
          to="/campaigns"
        />
        <Stat
          icon={SparklesIcon}
          label="Unique"
          value={String(stats.unique)}
          hint={
            duplicateRate === null
              ? "Nothing checked yet"
              : `${100 - duplicateRate}% of checked`
          }
          tone="success"
        />
        <Stat
          icon={CopyCheckIcon}
          label="Duplicate"
          value={String(stats.duplicates)}
          hint={
            duplicateRate === null ? undefined : `${duplicateRate}% of checked`
          }
          tone={stats.duplicates > 0 ? "warning" : "default"}
        />
        {/* A number worth acting on rather than only reading, so it links to
            where the acting happens. */}
        <Stat
          icon={IndianRupeeIcon}
          label="Rate requests"
          value={String(stats.pendingRates)}
          hint={stats.pendingRates === 0 ? "Nothing waiting" : "Waiting on you"}
          tone={stats.pendingRates > 0 ? "warning" : "default"}
          to={stats.pendingRates > 0 ? "/users" : undefined}
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
            <div className="flex items-center justify-between gap-4 bg-muted/30 px-4 py-2 text-[11px] tracking-wide text-muted-foreground uppercase">
              <span className="min-w-0 flex-1">Campaign</span>
              <span className="w-20 shrink-0 text-right">Editors</span>
              <span className="w-20 shrink-0 text-right">Videos</span>
              <span className="flex w-36 shrink-0 items-center justify-end gap-2">
                <span className="text-success">Unique</span>
                <span aria-hidden className="text-border">
                  /
                </span>
                <span>Dupe</span>
              </span>
            </div>
            {stats.perCampaign.map((row) => (
              <div
                key={row.campaignId}
                className="flex items-center justify-between gap-4 px-4 py-3 transition-colors hover:bg-muted/20"
              >
                <Link
                  to={`/campaigns/${row.campaignId}/feed`}
                  className="min-w-0 flex-1 truncate rounded text-[14px] outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  {row.campaignTitle}
                </Link>
                <span className="numeric w-20 shrink-0 text-right text-[13px] text-muted-foreground">
                  {row.editors}
                </span>
                <Link
                  to={`/campaigns/${row.campaignId}/feed`}
                  className="numeric w-20 shrink-0 rounded text-right text-[13px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  {row.videos}
                </Link>
                <span className="numeric flex w-36 shrink-0 items-center justify-end gap-2 text-[13px]">
                  <span className="text-success">{row.unique}</span>
                  <span aria-hidden className="text-border">
                    /
                  </span>
                  <span
                    className={
                      row.duplicates > 0
                        ? "text-warning"
                        : "text-muted-foreground"
                    }
                  >
                    {row.duplicates}
                  </span>
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      </section>

      <section className="space-y-3">
        <div className="flex items-center gap-3">
          <h2 className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
            Latest hand-ins
          </h2>
          <span aria-hidden className="h-px flex-1 bg-border" />
        </div>

        {stats.recent.length === 0 ? (
          <EmptyState
            icon={ClapperboardIcon}
            title="Nothing handed in yet"
            description="Videos editors submit against a brief will appear here."
          />
        ) : (
          <Card className="overflow-hidden py-0">
            <CardContent className="divide-y p-0">
              {stats.recent.map((row) => (
                <Link
                  key={row.submissionId}
                  to={`/campaigns/${row.campaignId}/feed`}
                  className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-muted/40"
                >
                  <span
                    className="min-w-0 flex-1 truncate text-[13px]"
                    title={row.fileName}
                  >
                    {row.fileName}
                  </span>
                  <span className="hidden shrink-0 text-[12px] text-muted-foreground sm:inline">
                    {row.editorName}
                  </span>
                  <UniquenessBadge
                    uniqueness={row.uniqueness}
                    value={row.duplicationScore}
                    pendingLabel="Checking"
                    className="shrink-0"
                  />
                  <span className="numeric w-16 shrink-0 text-right text-[12px] text-muted-foreground">
                    {relativeTime(row.createdAt)}
                  </span>
                </Link>
              ))}
            </CardContent>
          </Card>
        )}
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
  to,
}: {
  icon: LucideIcon
  label: string
  value: string
  hint?: string
  tone?: "default" | "warning" | "success"
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
      <Link
        to={to}
        className="block rounded-xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {body}
      </Link>
    </Card>
  )
}
