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
 * A DUPLICATE is never itself a parent — the classifier only compares against
 * UNIQUE and PARTIAL rows — so the pointers are nearly a forest of depth two.
 * Nearly: a PARTIAL is both a copy and a head, so a DUPLICATE can point at a
 * PARTIAL that is itself a copy, making that branch three deep. Real data has
 * this, and following the parent pointer to the top is what keeps such a row
 * from vanishing from the page.
 *
 * Groups stay one level deep: a copy of a copy is listed beside the copy it
 * came from, under the original both descend from.
 *
 * Order is preserved, and a row that is neither copy nor head comes back as a
 * group of one rather than disappearing.
 */
export function groupDuplicates<T extends Groupable>(
  rows: readonly T[],
): DuplicateGroup<T>[] {
  const byId = new Map(rows.map((row) => [row.id, row]))

  /**
   * The head a copy ultimately belongs under. Walks up while each parent is
   * itself a copy; `seen` guards against a cycle, which would hang the page.
   */
  const headFor = (row: T): string | null => {
    const seen = new Set<string>([row.id])
    let parentId = row.parentId
    while (parentId !== null) {
      const parent = byId.get(parentId)
      // A parent filtered out or withdrawn leaves the copy standing on its own
      // rather than vanishing into a group nobody can see.
      if (parent === undefined) return null
      if (!isCopy(parent)) return parent.id
      if (seen.has(parent.id)) return null
      seen.add(parent.id)
      parentId = parent.parentId
    }
    return null
  }

  const childrenByParent = new Map<string, T[]>()
  for (const row of rows) {
    if (!isCopy(row)) continue
    const headId = headFor(row)
    if (headId === null) continue
    const bucket = childrenByParent.get(headId) ?? []
    bucket.push(row)
    childrenByParent.set(headId, bucket)
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
