import { ArrowRightIcon } from "lucide-react"
import { Link } from "react-router-dom"

import { CampaignStatusBadge } from "@/components/status-badge"
import { Skeleton } from "@/components/ui/skeleton"
import { relativeTime } from "@/lib/format"
import type { Campaign } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * The tracker label, as a quiet chip. Prefers the denormalised display name
 * and falls back to the raw id — monospaced, so a uuid stays scannable — for
 * campaigns linked before the name was stored. Renders nothing when the
 * campaign is not linked at all, rather than leaving an empty slot.
 */
function TrackerChip({ campaign }: { campaign: Campaign }) {
  const name = campaign.trackerCampaignName?.trim() ?? ""
  const text = name || campaign.trackerCampaignId
  if (!text) return null
  return (
    <span
      title={text}
      className={cn(
        "max-w-[18ch] truncate rounded-md border bg-muted/40 px-1.5 py-0.5 text-[11px] text-muted-foreground",
        name === "" && "numeric font-mono",
      )}
    >
      {text}
    </span>
  )
}

/**
 * A campaign as an editor meets it: a browsable tile that opens the read-only
 * brief. The whole card is the link — one tab stop, one focus ring — so the
 * grid stays keyboard-navigable without nesting interactive elements.
 */
export function CampaignCard({ campaign }: { campaign: Campaign }) {
  return (
    <Link
      to={`/campaigns/${campaign.id}`}
      aria-label={`View brief for ${campaign.title}`}
      className={cn(
        "panel-sheen group flex h-full flex-col rounded-lg border bg-card p-3.5",
        "transition-colors duration-150 outline-none",
        "hover:border-ring/40 hover:bg-muted/30",
        "focus-visible:border-ring/40 focus-visible:ring-[3px] focus-visible:ring-ring/50",
      )}
    >
      <div className="flex items-center gap-2">
        <CampaignStatusBadge status={campaign.status} />
        <TrackerChip campaign={campaign} />
      </div>

      <h3 className="mt-2.5 line-clamp-2 text-[14px] leading-snug font-semibold">
        {campaign.title}
      </h3>

      {campaign.briefText ? (
        <p className="mt-1.5 line-clamp-3 text-[13px] leading-relaxed text-muted-foreground">
          {campaign.briefText}
        </p>
      ) : (
        <p className="mt-1.5 text-[13px] text-muted-foreground">
          No brief written yet.
        </p>
      )}

      <div className="mt-3.5 flex items-center justify-between gap-2 border-t pt-2.5">
        <span className="numeric text-[12px] text-muted-foreground">
          {relativeTime(campaign.updatedAt)}
        </span>
        <span className="flex items-center gap-1 text-[12px] font-medium text-muted-foreground transition-colors duration-150 group-hover:text-foreground">
          View brief
          <ArrowRightIcon
            aria-hidden
            className="size-3.5 transition-transform duration-150 group-hover:translate-x-0.5"
          />
        </span>
      </div>
    </Link>
  )
}

/**
 * Widths differ per card so a grid of them does not read as a barcode — the
 * same trick the admin table plays with SKELETON_ROWS.
 */
const SKELETON_WIDTHS = [
  { chip: "w-[64px]", title: "w-[82%]", lines: ["w-full", "w-[92%]", "w-[58%]"] },
  { chip: "w-[88px]", title: "w-[64%]", lines: ["w-[96%]", "w-full", "w-[41%]"] },
  { chip: "w-[52px]", title: "w-[91%]", lines: ["w-full", "w-[86%]", "w-[70%]"] },
  { chip: "w-[76px]", title: "w-[73%]", lines: ["w-[90%]", "w-full", "w-[35%]"] },
]

/**
 * Mirrors CampaignCard's geometry so the grid does not reflow when the real
 * cards land. `index` picks one of a few width sets; pass the map index.
 */
export function CampaignCardSkeleton({ index = 0 }: { index?: number }) {
  const widths =
    SKELETON_WIDTHS[Math.abs(index) % SKELETON_WIDTHS.length] ??
    SKELETON_WIDTHS[0]!

  return (
    <div className="panel-sheen flex h-full flex-col rounded-lg border bg-card p-3.5">
      <div className="flex items-center gap-2">
        <Skeleton className="h-5 w-[70px] rounded-full" />
        <Skeleton className={cn("h-4 rounded-md", widths.chip)} />
      </div>

      <Skeleton className={cn("mt-2.5 h-3.5", widths.title)} />

      <div className="mt-3 space-y-2">
        {widths.lines.map((line, lineIndex) => (
          <Skeleton key={lineIndex} className={cn("h-2.5", line)} />
        ))}
      </div>

      <div className="mt-3.5 flex items-center justify-between border-t pt-2.5">
        <Skeleton className="h-3 w-14" />
        <Skeleton className="h-3 w-[68px]" />
      </div>
    </div>
  )
}
