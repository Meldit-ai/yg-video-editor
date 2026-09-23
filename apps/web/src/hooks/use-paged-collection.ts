import { useCallback, useEffect, useRef, useState } from "react"
import type { RefObject } from "react"

import { ApiError, api } from "@/lib/api"
import type { Page } from "@/lib/types"

/** Rows per request. The server caps a page at 100. */
export const PAGE_SIZE = 24

/**
 * A list endpoint read a page at a time, accumulating as the reader scrolls.
 *
 * The difference from `usePagedList`, which slices an array already in memory:
 * this one never asks the server for the rest. A campaign's videos each carry
 * a signed URL, and rendering a page of them does nothing about the seconds
 * spent waiting for the other nine tenths to arrive.
 *
 * Rows are keyed by id on append, because an offset page is only as stable as
 * the list under it: a video uploaded, withdrawn or relabelled between two
 * requests shifts every row after it, and without this the reader would see
 * one video twice. The row already held wins — replacing it would swap the
 * signed URL of a video that may be playing.
 */
export function usePagedCollection<T extends { id: string }>(
  path: string,
  { pageSize = PAGE_SIZE }: { pageSize?: number } = {},
): PagedCollection<T> {
  const [items, setItems] = useState<T[]>([])
  const [total, setTotal] = useState(0)
  const [nextSkip, setNextSkip] = useState<number | null>(0)
  const [isLoading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)

  // Which read is the current one. A filter changed while a page was in
  // flight used to let the slower answer overwrite the newer list; anything
  // not carrying the current token is dropped on arrival.
  const readToken = useRef(0)
  // The read in progress, so a caller loading pages until it finds a row can
  // await the one already running rather than spin.
  const inFlight = useRef<Promise<void> | null>(null)

  const read = useCallback(
    (skip: number, mode: "replace" | "append"): Promise<void> => {
      if (inFlight.current !== null) return inFlight.current
      const token = readToken.current
      setLoading(true)

      const settled = (async () => {
        try {
          // A replace re-reads everything on screen, so a refetch after an
          // upload does not return a reader to the top of the list.
          const take = mode === "replace" ? Math.max(skip, pageSize) : pageSize
          const from = mode === "replace" ? 0 : skip
          const page = await api.get<Page<T>>(pagePath(path, take, from))
          if (token !== readToken.current) return
          setItems((current) =>
            mode === "replace" ? page.items : merge(current, page.items),
          )
          setTotal(page.total)
          setNextSkip(page.nextSkip)
          setError(null)
        } catch (caught) {
          if (token !== readToken.current) return
          setError(
            caught instanceof ApiError
              ? caught.message
              : "Something went wrong.",
          )
        } finally {
          inFlight.current = null
          if (token === readToken.current) setLoading(false)
        }
      })()

      inFlight.current = settled
      return settled
    },
    [path, pageSize],
  )

  // A new path is a different list: everything loaded so far belongs to the
  // old one, and the token invalidates any page still in flight for it.
  useEffect(() => {
    readToken.current += 1
    inFlight.current = null
    setItems([])
    setTotal(0)
    setNextSkip(0)
    setLoading(true)
    void read(0, "replace")
  }, [read])

  const hasMore = nextSkip !== null

  const loadMore = useCallback((): Promise<void> => {
    if (nextSkip === null) return Promise.resolve()
    return read(nextSkip, "append")
  }, [nextSkip, read])

  useEffect(() => {
    const node = sentinelRef.current
    if (node === null || !hasMore || isLoading) return
    if (typeof IntersectionObserver === "undefined") return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadMore()
      },
      // A page early, so a reader scrolling at a normal speed meets rendered
      // cards rather than the gap where the next page is about to land.
      { rootMargin: "800px 0px" },
    )
    observer.observe(node)
    return () => observer.disconnect()
    // `isLoading` is in here so the observer is rebuilt once a page settles:
    // when one page does not fill the viewport the sentinel is still on
    // screen afterwards, and an observer only reports a *change*.
  }, [hasMore, isLoading, loadMore])

  /**
   * Re-reads what is already on screen, for after an upload or a withdrawal.
   *
   * Reads back as many rows as are loaded rather than the first page, so the
   * reader keeps their place instead of being returned to the top of a list
   * they had scrolled halfway down.
   */
  const refetch = useCallback(async (): Promise<void> => {
    readToken.current += 1
    inFlight.current = null
    await read(items.length, "replace")
  }, [read, items.length])

  return {
    items,
    total,
    hasMore,
    isLoading,
    error,
    sentinelRef,
    refetch,
    loadMore,
  }
}

/** Appends rows the list does not already hold, keeping what it has. */
function merge<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  const held = new Set(current.map((item) => item.id))
  return [...current, ...incoming.filter((item) => !held.has(item.id))]
}

/** Adds the page parameters to a path that may already carry a filter. */
function pagePath(path: string, take: number, skip: number): string {
  const separator = path.includes("?") ? "&" : "?"
  return `${path}${separator}take=${take}&skip=${skip}`
}

interface PagedCollection<T> {
  items: T[]
  /** Rows matching the filter on the server, not the number loaded. */
  total: number
  hasMore: boolean
  isLoading: boolean
  error: string | null
  sentinelRef: RefObject<HTMLDivElement | null>
  refetch: () => Promise<void>
  /** Loads the next page, settling when it has landed. */
  loadMore: () => Promise<void>
}

/**
 * A page endpoint read whole, for a caller that has to see every row.
 *
 * The campaign feed folds copies under the video they were measured against
 * and then re-orders those groups by how many copies each has — both are
 * answers about the whole campaign, and computing them from a page would rank
 * the videos by whatever happened to be loaded.
 */
export function useWholeCollection<T>(path: string): {
  items: T[]
  isLoading: boolean
  error: string | null
  refetch: () => Promise<void>
} {
  const [items, setItems] = useState<T[]>([])
  const [isLoading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const readToken = useRef(0)

  const load = useCallback(async (): Promise<void> => {
    readToken.current += 1
    const token = readToken.current
    setLoading(true)
    try {
      const page = await api.get<Page<T>>(path)
      // A slower answer for an older filter must not replace a newer list.
      if (token !== readToken.current) return
      setItems(page.items)
      setError(null)
    } catch (caught) {
      if (token !== readToken.current) return
      setError(
        caught instanceof ApiError ? caught.message : "Something went wrong.",
      )
    } finally {
      if (token === readToken.current) setLoading(false)
    }
  }, [path])

  useEffect(() => {
    void load()
  }, [load])

  return { items, isLoading, error, refetch: load }
}
