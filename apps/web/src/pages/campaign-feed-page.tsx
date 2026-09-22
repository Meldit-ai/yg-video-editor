import { useEffect, useState } from "react"
import { Link, useParams } from "react-router-dom"
import { ArrowLeftIcon, ClapperboardIcon, RotateCwIcon } from "lucide-react"
import { motion, useReducedMotion } from "motion/react"

import { CampaignFeed } from "@/components/campaign-feed"
import { EmptyState } from "@/components/empty-state"
import { MetaDivider, PageHeader } from "@/components/page-header"
import { CampaignStatusBadge } from "@/components/status-badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { errorMessage } from "@/hooks/use-collection"
import { api } from "@/lib/api"
import { relativeTime } from "@/lib/format"
import type { Campaign } from "@/lib/types"

/**
 * The campaign feed on its own page.
 *
 * Split out from the campaign detail page so the feed is a destination an
 * admin can navigate to and link to, rather than a section to scroll past.
 */
export function CampaignFeedPage() {
  const { id } = useParams<{ id: string }>()
  const [campaign, setCampaign] = useState<Campaign | null>(null)
  const [isLoading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const reduceMotion = useReducedMotion()

  useEffect(() => {
    if (id === undefined) return
    let cancelled = false
    setLoading(true)
    setError(null)
    api
      .get<Campaign>(`/campaigns/${id}`)
      .then((data) => {
        if (!cancelled) setCampaign(data)
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
  }, [id, attempt])

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: reduceMotion ? 0 : 0.15, ease: "easeOut" }}
      className="flex w-full max-w-7xl flex-col gap-4"
    >
      <Link
        to={id === undefined ? "/campaigns" : `/campaigns/${id}`}
        className="-ml-1.5 inline-flex w-fit items-center gap-1.5 rounded-md px-1.5 py-1 text-[13px] text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <ArrowLeftIcon className="size-3.5" />
        Back to campaign
      </Link>

      {isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-7 w-64" />
          <Skeleton className="h-4 w-40" />
        </div>
      ) : error !== null || campaign === null ? (
        <EmptyState
          icon={ClapperboardIcon}
          title="Could not open this campaign"
          description={error ?? "It may have been deleted or paused."}
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
      ) : (
        <>
          <PageHeader
            title={campaign.title}
            description="Every video handed in against this brief, least duplicated first."
            meta={
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <CampaignStatusBadge status={campaign.status} />
                <MetaDivider />
                <span>
                  Flags at{" "}
                  <span className="numeric text-foreground">
                    {campaign.duplicationThreshold}%
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

          <CampaignFeed campaign={campaign} />
        </>
      )}
    </motion.div>
  )
}
