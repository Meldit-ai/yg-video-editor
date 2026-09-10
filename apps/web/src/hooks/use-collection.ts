import { useCallback, useEffect, useState } from "react"

import { ApiError, api } from "@/lib/api"

interface CollectionState<T> {
  items: T[]
  isLoading: boolean
  /** Message from the failed load, or null. 401s never land here — the api
   *  client redirects to /login before the caller sees them. */
  error: string | null
  refetch: () => Promise<void>
}

/**
 * Loads a list endpoint and exposes a refetch for use after mutations.
 *
 * Refetching after every write keeps the table honest about server-side
 * effects (trimming, defaults, soft-delete) that optimistic updates would
 * have to duplicate and could get wrong.
 */
export function useCollection<T>(path: string): CollectionState<T> {
  const [items, setItems] = useState<T[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setIsLoading(true)
    try {
      setItems(await api.get<T[]>(path))
      setError(null)
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : "Something went wrong.",
      )
    } finally {
      setIsLoading(false)
    }
  }, [path])

  useEffect(() => {
    void load()
  }, [load])

  return { items, isLoading, error, refetch: load }
}

/** Formats an ISO timestamp for table display. */
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  })
}

/** Pulls a human-readable message out of an unknown thrown value. */
export function errorMessage(caught: unknown): string {
  if (caught instanceof ApiError) return caught.message
  if (caught instanceof Error && caught.message) return caught.message
  return "Something went wrong."
}
