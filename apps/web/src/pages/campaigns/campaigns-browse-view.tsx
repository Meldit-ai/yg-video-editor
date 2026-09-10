import { useMemo, useRef, useState } from "react"
import type { ReactNode } from "react"
import {
  ClapperboardIcon,
  RotateCwIcon,
  SearchIcon,
  SearchXIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { motion, useReducedMotion } from "motion/react"

import { CampaignCard, CampaignCardSkeleton } from "@/components/campaign-card"
import { EmptyState } from "@/components/empty-state"
import { MetaDivider, PageHeader } from "@/components/page-header"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { useCollection } from "@/hooks/use-collection"
import type { Campaign } from "@/lib/types"
import { cn } from "@/lib/utils"

const GRID_CLASS = "grid gap-3 sm:grid-cols-2 xl:grid-cols-3"

/** Enough tiles to fill the fold on a wide screen without overshooting it. */
const SKELETON_COUNT = 6

/** Cards land in sequence, but the tail is capped so a long list never crawls. */
const STAGGER_STEP = 0.02
const STAGGER_CAP = 0.2

/** Title, tracker label and brief — the three things an editor scans for. */
function matchesQuery(campaign: Campaign, needle: string): boolean {
  return [
    campaign.title,
    campaign.trackerCampaignName,
    campaign.briefText,
  ].some((field) => field?.toLowerCase().includes(needle) ?? false)
}

/**
 * Framing for the states that stand in for the grid. The admin table gets its
 * composure from the panel it sits in; an empty state on a bare page would
 * float loose without the same hairline border under it.
 */
function StatePanel({ children }: { children: ReactNode }) {
  return <div className="panel-sheen rounded-lg border bg-card">{children}</div>
}

/**
 * The editor's view of campaigns: a browsable grid of briefs, each opening the
 * read-only detail page. No status tabs and no create action — an editor reads
 * campaigns, they do not curate them.
 */
export function CampaignsBrowseView() {
  // The API scopes editors to ACTIVE campaigns server-side, so everything that
  // arrives here is already fair game — no client-side status filtering.
  const { items, isLoading, error, refetch } = useCollection<Campaign>(
    "/campaigns",
  )

  const [query, setQuery] = useState("")
  const searchRef = useRef<HTMLInputElement>(null)
  const reduceMotion = useReducedMotion()

  const needle = query.trim().toLowerCase()
  const isFiltering = needle !== ""

  // The list is small — a handful of live briefs — so filtering in memory beats
  // a round trip, and stays instant enough that debouncing would only add lag.
  const visible = useMemo(
    () =>
      needle === ""
        ? items
        : items.filter((campaign) => matchesQuery(campaign, needle)),
    [items, needle],
  )

  function clearSearch() {
    setQuery("")
    searchRef.current?.focus()
  }

  const isSettled = !isLoading && !error
  const showEmpty = isSettled && items.length === 0
  const showNoMatches = isSettled && items.length > 0 && visible.length === 0
  const showCards = isSettled && visible.length > 0

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Campaigns"
        description="Briefs ready to work from."
        meta={
          isLoading || error ? undefined : (
            <>
              <span>
                <span className="numeric text-foreground">{items.length}</span>{" "}
                available
              </span>
              {isFiltering && (
                <>
                  <MetaDivider />
                  <span>
                    <span className="numeric text-foreground">
                      {visible.length}
                    </span>{" "}
                    matching
                  </span>
                </>
              )}
            </>
          )
        }
      />

      <div className="flex items-center justify-between gap-3">
        <div className="relative w-full max-w-xs">
          <SearchIcon
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setQuery("")
            }}
            aria-label="Search campaigns by title, tracker or brief"
            placeholder="Search briefs…"
            className="h-8 border-transparent bg-muted/40 pl-8 text-[13px] shadow-none transition-colors hover:bg-muted/60 dark:bg-muted/40 dark:hover:bg-muted/60 [&::-webkit-search-cancel-button]:hidden"
          />
        </div>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Refresh campaigns"
              disabled={isLoading}
              onClick={() => void refetch()}
              className="text-muted-foreground hover:text-foreground"
            >
              <RotateCwIcon className={cn(isLoading && "animate-spin")} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Refresh</TooltipContent>
        </Tooltip>
      </div>

      {isLoading && (
        <div className={GRID_CLASS}>
          {Array.from({ length: SKELETON_COUNT }, (_, index) => (
            <CampaignCardSkeleton key={index} index={index} />
          ))}
        </div>
      )}

      {!isLoading && error && (
        <StatePanel>
          <EmptyState
            icon={TriangleAlertIcon}
            title="Could not load campaigns"
            description={error}
            action={
              <Button
                variant="outline"
                size="sm"
                onClick={() => void refetch()}
              >
                <RotateCwIcon />
                Try again
              </Button>
            }
          />
        </StatePanel>
      )}

      {showEmpty && (
        <StatePanel>
          <EmptyState
            icon={ClapperboardIcon}
            title="No campaigns yet"
            description="Nobody has briefed a campaign for you yet. As soon as an admin publishes one, it turns up here with its brief and guidance note."
          />
        </StatePanel>
      )}

      {showNoMatches && (
        <StatePanel>
          <EmptyState
            icon={SearchXIcon}
            title="No matching campaigns"
            description={`Nothing here matches “${query.trim()}”. Try a different title or tracker name.`}
            action={
              <Button variant="outline" size="sm" onClick={clearSearch}>
                Clear search
              </Button>
            }
          />
        </StatePanel>
      )}

      {showCards && (
        <div className={GRID_CLASS}>
          {visible.map((campaign, index) => (
            <motion.div
              key={campaign.id}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{
                duration: reduceMotion ? 0 : 0.15,
                delay: reduceMotion
                  ? 0
                  : Math.min(index * STAGGER_STEP, STAGGER_CAP),
                ease: "easeOut",
              }}
            >
              <CampaignCard campaign={campaign} />
            </motion.div>
          ))}
        </div>
      )}
    </div>
  )
}
