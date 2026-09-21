import type { Uniqueness } from "@/lib/types"

/**
 * The little a row needs to be grouped. Mirrors
 * apps/api/src/common/duplicate-groups.ts — keep the two in step.
 */
export interface Groupable {
  id: string
  uniqueness: Uniqueness | null
  /** `topMatchSubmissionId` for a submission, `originalReelId` for a reel. */
  parentId: string | null
}

/** One original and everything found to be derived from it. */
export interface DuplicateGroup<T extends Groupable> {
  head: T
  children: T[]
}

/**
 * Whether a row is a copy of something, rather than an original.
 *
 * Not "does it have a parent": a UNIQUE row carries one too, kept so a later
 * threshold edit can re-label without the engine, and on a real campaign 32 of
 * 34 UNIQUE rows had one. Grouping on the pointer alone files originals as
 * copies of whatever they were merely measured against.
 */
export function isCopy(row: Groupable): boolean {
  if (row.parentId === null) return false
  return row.uniqueness === "DUPLICATE" || row.uniqueness === "PARTIAL"
}

/**
 * Folds a flat list into originals and the copies beneath them.
 *
 * A plain group-by is correct because a DUPLICATE is never itself a parent —
 * the classifier only compares against UNIQUE and PARTIAL rows — so the
 * pointers form a forest of depth two. A PARTIAL is both a copy and a head,
 * which is what keeps a copy-of-a-copy under the right original.
 *
 * Order is preserved, and a row that is neither copy nor head comes back as a
 * group of one rather than disappearing.
 */
export function groupDuplicates<T extends Groupable>(
  rows: readonly T[],
): DuplicateGroup<T>[] {
  const byId = new Map(rows.map((row) => [row.id, row]))

  const childrenByParent = new Map<string, T[]>()
  for (const row of rows) {
    if (!isCopy(row)) continue
    // A parent filtered out or withdrawn leaves the copy standing on its own
    // rather than vanishing into a group nobody can see.
    if (row.parentId === null || !byId.has(row.parentId)) continue
    const bucket = childrenByParent.get(row.parentId) ?? []
    bucket.push(row)
    childrenByParent.set(row.parentId, bucket)
  }

  const claimed = new Set<string>()
  for (const children of childrenByParent.values()) {
    for (const child of children) claimed.add(child.id)
  }

  const groups: DuplicateGroup<T>[] = []
  for (const row of rows) {
    if (claimed.has(row.id)) continue
    groups.push({ head: row, children: childrenByParent.get(row.id) ?? [] })
  }
  return groups
}
