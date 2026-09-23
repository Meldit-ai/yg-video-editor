import { useEffect, useMemo, useRef, useState } from "react"
import type { RefObject } from "react"

/**
 * How many rows a list shows before the reader scrolls. Roughly two screens of
 * a three-column grid, so the sentinel below the fold is reached by scrolling
 * rather than on arrival.
 */
export const DEFAULT_PAGE_SIZE = 24

/**
 * The slice of a loaded list that is actually rendered, grown a page at a time
 * as the reader reaches the end of it.
 *
 * This pages what is already in memory, not what crosses the wire: the list
 * endpoints answer with the whole campaign today, and a card's cost is not its
 * row but its player — mounting four hundred of them at once is four hundred
 * requests and a DOM nobody scrolls to the bottom of.
 *
 * `resetKey` is what a new list is recognised by, and it is deliberately not
 * the array's identity. Every refetch — after an upload, a withdrawal, a poll
 * while a check runs — builds a fresh array holding the same videos, and
 * collapsing back to the first page there would throw away the reader's place
 * mid-scroll. A filter or a sort change is a different list and does reset.
 */
export function usePagedList<T>(
  items: readonly T[],
  { pageSize = DEFAULT_PAGE_SIZE, resetKey = "" }: PagedListOptions = {},
): PagedList<T> {
  const [shown, setShown] = useState(pageSize)
  const sentinelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setShown(pageSize)
  }, [resetKey, pageSize])

  // Not clamped in state: a list that shrinks (a withdrawal, a narrower
  // filter) and grows again should show what the reader had already reached.
  const visible = useMemo(() => items.slice(0, shown), [items, shown])
  const hasMore = items.length > shown

  useEffect(() => {
    const node = sentinelRef.current
    if (node === null || !hasMore) return
    // Without IntersectionObserver the whole list renders at once, which is
    // the behaviour this replaces rather than a regression.
    if (typeof IntersectionObserver === "undefined") {
      setShown(items.length)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setShown((current) => current + pageSize)
        }
      },
      // A page early, so scrolling at a normal speed meets rendered cards
      // rather than the gap where the next page is about to appear.
      { rootMargin: "800px 0px" },
    )
    observer.observe(node)
    return () => observer.disconnect()
    // `shown` is a dependency because an observer only reports a *change* in
    // intersection: when one page does not fill the viewport the sentinel is
    // still on screen afterwards and would never fire again. Re-observing
    // re-reads the current position, so short pages keep filling.
  }, [hasMore, pageSize, shown, items.length])

  return {
    visible,
    hasMore,
    sentinelRef,
    shown,
    revealThrough: (index: number) =>
      setShown((current) => (index < current ? current : index + 1)),
  }
}

interface PagedListOptions {
  pageSize?: number
  /** Changing this starts the list over at its first page. */
  resetKey?: string
}

interface PagedList<T> {
  /** The rows to render. */
  visible: T[]
  /** Whether anything is held back — the sentinel is pointless without it. */
  hasMore: boolean
  /** Put on an element below the last row; reaching it loads the next page. */
  sentinelRef: RefObject<HTMLDivElement | null>
  /** How many rows are rendered, for a "showing N of M" readout. */
  shown: number
  /**
   * Renders far enough down the list to include the row at `index`, for
   * reaching a card that a link points at but paging has not got to yet.
   */
  revealThrough: (index: number) => void
}
