import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import {
  ClapperboardIcon,
  CopyCheckIcon,
  IndianRupeeIcon,
  LayersIcon,
  SparklesIcon,
  TriangleAlertIcon,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"

import { EmptyState } from "@/components/empty-state"
import { MetaDivider, PageHeader } from "@/components/page-header"
import { ProfileCard } from "@/components/profile-card"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { errorMessage } from "@/hooks/use-collection"
import { api } from "@/lib/api"
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
        {/* The rate leads, not the count. "34 unique" means nothing without
            what it is out of; "35% original" is the number an admin can judge
            a campaign on, with the counts underneath for the detail. */}
        <Stat
          icon={SparklesIcon}
          label="Original work"
          value={duplicateRate === null ? "—" : `${100 - duplicateRate}%`}
          hint={
            duplicateRate === null
              ? "Nothing checked yet"
              : `${stats.unique} of ${stats.unique + stats.duplicates} checked`
          }
          tone={
            duplicateRate === null
              ? "default"
              : duplicateRate > 50
                ? "warning"
                : "success"
          }
        />
        <Stat
          icon={CopyCheckIcon}
          label="Duplicates found"
          value={String(stats.duplicates)}
          hint={
            duplicateRate === null
              ? undefined
              : `${duplicateRate}% of what was checked`
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
              <span className="flex w-44 shrink-0 items-center justify-end gap-1.5">
                <span className="text-success">Unique</span>
                <span aria-hidden className="text-border">
                  /
                </span>
                <span>Duplicate</span>
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
                {/* The split and the total on one line: "34 / 64 of 99"
                    answers "how much, and how much of it is original" without
                    the reader holding two columns in their head. */}
                <span className="numeric flex w-44 shrink-0 items-baseline justify-end gap-1.5 text-[13px]">
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
                  <span className="text-[12px] text-muted-foreground">
                    of {row.videos}
                  </span>
                  {row.unchecked > 0 && (
                    <span
                      className="text-[12px] text-muted-foreground"
                      title={`${row.unchecked} not checked yet`}
                    >
                      ({row.unchecked}?)
                    </span>
                  )}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      </section>

      <section className="space-y-3">
        <div className="flex items-center gap-3">
          <h2 className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
            By editor
          </h2>
          <span aria-hidden className="h-px flex-1 bg-border" />
        </div>

        {stats.perEditor.length === 0 ? (
          <EmptyState
            icon={ClapperboardIcon}
            title="Nothing handed in yet"
            description="Once editors submit against a brief, how their work is landing shows up here."
          />
        ) : (
          <Card className="overflow-hidden py-0">
            <CardContent className="divide-y p-0">
              <div className="flex items-center justify-between gap-4 bg-muted/30 px-4 py-2 text-[11px] tracking-wide text-muted-foreground uppercase">
                <span className="min-w-0 flex-1">Editor</span>
                <span className="w-20 shrink-0 text-right">Videos</span>
                <span className="w-36 shrink-0 text-right">Original</span>
              </div>
              {stats.perEditor.map((row) => (
                <div
                  key={row.editorId}
                  className="flex items-center justify-between gap-4 px-4 py-3"
                >
                  <span className="min-w-0 flex-1 truncate text-[14px]">
                    {row.editorName}
                  </span>
                  <span className="numeric w-20 shrink-0 text-right text-[13px] text-muted-foreground">
                    {row.videos}
                  </span>
                  {/* The bar is the point: a percentage on its own does not
                      show how one editor compares to the next at a glance. */}
                  <span className="flex w-36 shrink-0 items-center justify-end gap-2">
                    {row.originalRate === null ? (
                      <span className="text-[12px] text-muted-foreground">
                        Not checked
                      </span>
                    ) : (
                      <>
                        <span
                          aria-hidden
                          className="h-1.5 w-16 overflow-hidden rounded-full bg-muted"
                        >
                          <span
                            className={cn(
                              "block h-full rounded-full",
                              row.originalRate >= 50
                                ? "bg-success"
                                : "bg-warning",
                            )}
                            style={{ width: `${row.originalRate}%` }}
                          />
                        </span>
                        <span className="numeric w-10 text-right text-[13px]">
                          {row.originalRate}%
                        </span>
                      </>
                    )}
                  </span>
                </div>
              ))}
            </CardContent>
          </Card>
        )}
        <p className="text-[12px] text-muted-foreground">
          Original is unique videos as a share of those checked, so an editor
          mid-run is not marked down for work the engine has not reached.
        </p>
      </section>

      {/* Only rendered when something is actually wrong: a panel that always
          says "0 failed" trains people to stop reading it. */}
      {(stats.attention.failedShares > 0 || stats.attention.failedRuns > 0) && (
        <section className="space-y-3">
          <div className="flex items-center gap-3">
            <h2 className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              Needs attention
            </h2>
            <span aria-hidden className="h-px flex-1 bg-border" />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {stats.attention.failedShares > 0 && (
              <Card className="py-0">
                <CardContent className="flex items-start gap-3 p-4">
                  <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-warning" />
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium">
                      {stats.attention.failedShares} of{" "}
                      {stats.attention.totalShareRecipients} vendor sends failed
                    </p>
                    <p className="text-[12px] text-muted-foreground">
                      Those vendors never received the videos. Usually an
                      unreachable number or an expired WhatsApp token.
                    </p>
                  </div>
                </CardContent>
              </Card>
            )}
            {stats.attention.failedRuns > 0 && (
              <Card className="py-0">
                <CardContent className="flex items-start gap-3 p-4">
                  <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-warning" />
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium">
                      {stats.attention.failedRuns} duplicate checks failed
                    </p>
                    <p className="text-[12px] text-muted-foreground">
                      {stats.attention.succeededRuns} succeeded. Videos in a
                      failed run stay unchecked until the next one reaches them.
                    </p>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </section>
      )}

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
