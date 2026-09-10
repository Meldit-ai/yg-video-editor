import { useCallback, useEffect, useMemo, useState } from "react"

import { errorMessage } from "@/hooks/use-collection"
import { api } from "@/lib/api"
import { isComparisonLive } from "@/lib/types"
import type {
  Comparison,
  ComparisonPair,
  ComparisonSummary,
  ComparisonVerdict,
  ComparisonVideo,
} from "@/lib/types"

/** How often to ask the API for a run's progress while it is moving. */
const POLL_MS = 3_000

/**
 * How long to keep polling after an upload, waiting for the run it triggers
 * to appear.
 *
 * The API starts that run *after* answering the upload, so the first refetch
 * usually still sees the previous one — there is no id to wait for, only a
 * short window in which a new run is expected. Twenty-five seconds covers a
 * slow round trip to the engine; past that, the run either failed to start
 * (and was recorded as such) or never will.
 */
const WATCH_WINDOW_MS = 25_000

/**
 * What the duplicate check currently says about **one** video.
 *
 * Every branch is derived from stored data — the run's status, that video's
 * entry row, and the pairs it appears in — so a card can state its own
 * position without the reader having to map it onto the panel below.
 *
 * The distinctions matter: "not checked yet", "could not be read" and "no
 * duplicates" all look like silence on a card, and only the last one means
 * the video is clear.
 */
export type SubmissionCheck =
  /** No run covers this video, and none is on its way. */
  | { kind: "none" }
  | { kind: "running"; pairsDone: number; pairsTotal: number }
  | { kind: "failed"; message: string }
  /** The engine never fingerprinted it, so it is in no pair at all. */
  | { kind: "unreadable"; checkedAt: string }
  | {
      kind: "clean"
      /** Other videos in the run that the engine actually compared it to. */
      comparedWith: number
      durationSeconds: number | null
      checkedAt: string
    }
  | {
      kind: "flagged"
      /** The strongest verdict across every pair this video is in. */
      verdict: ComparisonVerdict
      topScore: number
      topContainment: number
      durationSeconds: number | null
      checkedAt: string
      /** Strongest first. `other` is null if the counterpart was removed. */
      matches: { pair: ComparisonPair; other: ComparisonVideo | null }[]
    }

/** Strongest first, for picking one headline verdict out of several pairs. */
const VERDICT_STRENGTH: Record<ComparisonVerdict, number> = {
  MATCH: 3,
  LIKELY_MATCH: 2,
  UNCERTAIN: 1,
  NO_MATCH: 0,
}

export interface ComparisonState {
  /** The campaign's current run, whatever its state, or null if never run. */
  comparison: Comparison | null
  isLoading: boolean
  error: string | null
  /**
   * Flagged pairs indexed by *both* of their submission ids, so a card can
   * ask "what does this video match?" without scanning every pair. NO_MATCH
   * pairs are left out: they are results, but not ones worth a badge.
   */
  matches: Map<string, ComparisonPair[]>
  /** The run's video roster, by submission id — pairs reference it by id. */
  videoById: Map<string, ComparisonVideo>
  /** What the check says about one video, for the card that shows it. */
  checkFor: (submissionId: string) => SubmissionCheck
  /** A run is in flight, or one is expected imminently after an upload. */
  isRunning: boolean
  /** A "run now" request is in flight. */
  isStarting: boolean
  refetch: () => Promise<void>
  /** Starts a run over every video on the campaign. Throws on failure. */
  run: () => Promise<void>
  /** Called after an upload: poll for the run the API is about to start. */
  watchForNewRun: () => void
}

/**
 * The campaign's duplicate check: current state, live progress, and a way to
 * start a fresh one.
 *
 * Polls our own API rather than the engine — the API is what holds the run's
 * state, and the engine is not reachable from a browser. Polling only happens
 * while there is something to wait for: a live run, or the short window after
 * an upload in which one is about to appear.
 *
 * `enabled` exists because the endpoints are admin-only. An editor's session
 * must not fire requests that will 403 on every campaign page load.
 */
export function useComparison(
  campaignId: string,
  enabled: boolean,
): ComparisonState {
  const [comparison, setComparison] = useState<Comparison | null>(null)
  const [isLoading, setLoading] = useState(enabled)
  const [error, setError] = useState<string | null>(null)
  const [isStarting, setStarting] = useState(false)
  /**
   * The short wait for a run that has been asked for but not yet seen.
   *
   * `priorId` is what "not yet seen" means: the run showing when the wait
   * started. The moment a different one arrives the wait is over, whatever
   * the clock says — otherwise a run that finishes in five seconds would
   * still look busy for another twenty.
   */
  const [watch, setWatch] = useState<{ until: number; priorId: string | null }>({
    until: 0,
    priorId: null,
  })
  // Bumped after every load. The polling effect keys off it, so a load that
  // failed — leaving `comparison` untouched — still schedules the next one
  // instead of silently ending the poll.
  const [tick, setTick] = useState(0)

  const base = `/campaigns/${encodeURIComponent(campaignId)}/comparisons`
  // Read out so the callbacks below depend on the id rather than the whole
  // object, which is a fresh reference after every poll.
  const comparisonId = comparison?.id ?? null

  const load = useCallback(async (): Promise<void> => {
    try {
      // A campaign that has never been checked answers with an empty body,
      // which the api client reads as undefined.
      const next = await api.get<Comparison | null>(`${base}/latest`)
      setComparison(next ?? null)
      setError(null)
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setLoading(false)
      setTick((count) => count + 1)
    }
  }, [base])

  useEffect(() => {
    if (!enabled) {
      // An editor never loads this. Clear rather than leave stale admin data
      // behind if the role ever changes mid-session.
      setComparison(null)
      setLoading(false)
      return
    }
    setLoading(true)
    void load()
  }, [enabled, load])

  const isLive = comparison !== null && isComparisonLive(comparison.status)
  const isWatching =
    Date.now() < watch.until && (comparison?.id ?? null) === watch.priorId
  const isRunning = isLive || isWatching

  useEffect(() => {
    if (!enabled || !isRunning) return
    const timer = window.setTimeout(() => void load(), POLL_MS)
    return () => window.clearTimeout(timer)
    // `tick` is the beat: every completed load re-runs this and schedules the
    // next poll, and the guard above ends the chain once nothing is moving.
  }, [enabled, isRunning, tick, load])

  const run = useCallback(async (): Promise<void> => {
    setStarting(true)
    // Recorded before the request: the run showing now is the one the new
    // one has to replace.
    setWatch({ until: Date.now() + WATCH_WINDOW_MS, priorId: comparisonId })
    try {
      await api.post<ComparisonSummary>(base)
      await load()
    } finally {
      setStarting(false)
    }
  }, [base, comparisonId, load])

  const watchForNewRun = useCallback((): void => {
    setWatch({ until: Date.now() + WATCH_WINDOW_MS, priorId: comparisonId })
  }, [comparisonId])

  const matches = useMemo(() => {
    const bySubmission = new Map<string, ComparisonPair[]>()
    for (const pair of comparison?.pairs ?? []) {
      if (pair.verdict === "NO_MATCH") continue
      for (const id of [pair.aSubmissionId, pair.bSubmissionId]) {
        const existing = bySubmission.get(id)
        if (existing) existing.push(pair)
        else bySubmission.set(id, [pair])
      }
    }
    return bySubmission
  }, [comparison])

  const videoById = useMemo(() => {
    const map = new Map<string, ComparisonVideo>()
    for (const video of comparison?.videos ?? []) map.set(video.submissionId, video)
    return map
  }, [comparison])

  const checkFor = useCallback(
    (submissionId: string): SubmissionCheck =>
      describeSubmissionCheck(
        comparison,
        isRunning,
        submissionId,
        matches.get(submissionId) ?? [],
        videoById,
      ),
    [comparison, isRunning, matches, videoById],
  )

  return {
    comparison,
    isLoading,
    error,
    matches,
    videoById,
    checkFor,
    isRunning,
    isStarting,
    refetch: load,
    run,
    watchForNewRun,
  }
}

/**
 * Where one video stands in the current run.
 *
 * A live run re-checks the *whole* campaign, so while one is in flight every
 * card reads "checking" — the results on screen are about to be replaced, and
 * showing a stale verdict beside a running check would be the wrong kind of
 * confident.
 */
export function describeSubmissionCheck(
  comparison: Comparison | null,
  isRunning: boolean,
  submissionId: string,
  flaggedPairs: ComparisonPair[],
  videoById: Map<string, ComparisonVideo>,
): SubmissionCheck {
  if (isRunning) {
    return {
      kind: "running",
      pairsDone: comparison?.pairsDone ?? 0,
      pairsTotal: comparison?.pairsTotal ?? 0,
    }
  }

  if (comparison === null) return { kind: "none" }

  const entry = videoById.get(submissionId)
  // Uploaded after this run started, and nothing is running — so it genuinely
  // has not been looked at. Not the same as "checked and clean".
  if (entry === undefined) return { kind: "none" }

  if (comparison.status === "FAILED" || comparison.status === "TIMEOUT") {
    return {
      kind: "failed",
      message:
        comparison.errorMessage ??
        "The comparison engine did not return a result.",
    }
  }

  const checkedAt = comparison.completedAt ?? comparison.createdAt

  if (!entry.ready) return { kind: "unreadable", checkedAt }

  if (flaggedPairs.length === 0) {
    return {
      kind: "clean",
      // Only the videos the engine actually got through: counting the ones it
      // could not read would overstate what this result covers.
      comparedWith: [...videoById.values()].filter(
        (video) => video.ready && video.submissionId !== submissionId,
      ).length,
      durationSeconds: entry.durationSeconds,
      checkedAt,
    }
  }

  const matches = [...flaggedPairs]
    .sort((left, right) => right.score - left.score)
    .map((pair) => {
      const otherId =
        pair.aSubmissionId === submissionId
          ? pair.bSubmissionId
          : pair.aSubmissionId
      return { pair, other: videoById.get(otherId) ?? null }
    })

  const strongest = flaggedPairs.reduce((best, pair) =>
    VERDICT_STRENGTH[pair.verdict] > VERDICT_STRENGTH[best.verdict] ? pair : best,
  )

  return {
    kind: "flagged",
    verdict: strongest.verdict,
    topScore: Math.max(...flaggedPairs.map((pair) => pair.score)),
    // Reported separately from the score because they answer different
    // questions: a lift from a longer video scores modestly but contains high.
    topContainment: Math.max(...flaggedPairs.map((pair) => pair.containment)),
    durationSeconds: entry.durationSeconds,
    checkedAt,
    matches,
  }
}
