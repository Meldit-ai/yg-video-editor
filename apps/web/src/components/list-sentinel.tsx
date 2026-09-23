import type { RefObject } from "react"

import { cn } from "@/lib/utils"

/**
 * The end of a paged list: the marker that loads the next page when it is
 * reached, and the count that says how much is left.
 *
 * Deliberately not a spinner. Nothing is being fetched — the rows are already
 * in memory and the next page renders in the same frame the marker is reached,
 * so a spinner would report work that never happens. The count is the useful
 * part: it tells the reader the list continues past what they can see.
 */
export function ListSentinel({
  ref,
  shown,
  total,
  noun,
  className,
}: {
  ref: RefObject<HTMLDivElement | null>
  shown: number
  total: number
  /** Plural, for the readout: "videos", "reels", "matches". */
  noun: string
  className?: string
}) {
  return (
    <div
      ref={ref}
      // Read out rather than hidden: "24 of 97" is the only thing on the page
      // saying the list continues past the last card.
      role="status"
      className={cn(
        "numeric flex justify-center py-4 text-[12px] text-muted-foreground",
        className,
      )}
    >
      {shown} of {total} {noun}
    </div>
  )
}
