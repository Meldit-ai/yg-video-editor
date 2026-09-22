import { Uniqueness } from "@repo/database";

/**
 * The little a row needs to be grouped: its own id, its label, and what it was
 * measured against. Deliberately structural rather than tied to submissions or
 * reels, because both are grouped the same way from different tables.
 */
export interface Groupable {
  id: string;
  uniqueness: Uniqueness | null;
  /** `topMatchSubmissionId` for a submission, `originalReelId` for a reel. */
  parentId: string | null;
}

/** One original and everything found to be derived from it. */
export interface DuplicateGroup<T extends Groupable> {
  /** The video the others were measured against. */
  head: T;
  /** Its copies, in the order they were given. */
  children: T[];
}

/**
 * Whether a row is a copy of something, rather than an original.
 *
 * The distinction is not "does it have a parent". A UNIQUE row **also** carries
 * one — kept so a later threshold edit can re-label from stored values without
 * asking the engine again — and on a real campaign 32 of 34 UNIQUE rows had a
 * parent id. Grouping on the pointer alone would file those originals as
 * copies of whatever they were merely compared against.
 */
export function isCopy(row: Groupable): boolean {
  if (row.parentId === null) return false;
  return (
    row.uniqueness === Uniqueness.DUPLICATE ||
    row.uniqueness === Uniqueness.PARTIAL
  );
}

/**
 * Folds a flat list into originals and the copies beneath them.
 *
 * A DUPLICATE is never itself a parent — the classifier only ever compares
 * against UNIQUE and PARTIAL rows — so the pointers are nearly a forest of
 * depth two. Nearly: a PARTIAL is both a copy of something earlier and the
 * head of its own copies, so a DUPLICATE can point at a PARTIAL that is itself
 * a copy, making that branch three deep. Real data has this — one row on the
 * Traitors campaign — and following the parent pointer to the top is what
 * keeps such a row from vanishing from the page entirely.
 *
 * Groups stay one level deep: a copy of a copy is listed beside the copy it
 * came from, under the original both descend from. The alternative, nesting,
 * would mean an accordion inside an accordion for a case that is this rare.
 *
 * Order is preserved: heads come back in the order they arrived in `rows`, so
 * a caller that sorted by date or score keeps that sorting. Rows that are
 * neither a copy nor a head — an unchecked video, or an original nothing was
 * derived from — come back as a group of one rather than disappearing.
 */
export function groupDuplicates<T extends Groupable>(
  rows: readonly T[],
): DuplicateGroup<T>[] {
  const byId = new Map(rows.map((row) => [row.id, row]));

  /**
   * The head a copy ultimately belongs under.
   *
   * Walks up while each parent is itself a copy, so a DUPLICATE pointing at a
   * PARTIAL that is itself a copy lands under the original both descend from.
   * `seen` guards against a cycle: the classifier should never produce one,
   * but a loop here would hang the page rather than mislabel a video.
   */
  const headFor = (row: T): string | null => {
    const seen = new Set<string>([row.id]);
    let parentId = row.parentId;
    while (parentId !== null) {
      const parent = byId.get(parentId);
      // A parent outside `rows` — withdrawn, or filtered out by the caller —
      // leaves the copy to stand on its own rather than vanish.
      if (parent === undefined) return null;
      if (!isCopy(parent)) return parent.id;
      if (seen.has(parent.id)) return null;
      seen.add(parent.id);
      parentId = parent.parentId;
    }
    return null;
  };

  const childrenByParent = new Map<string, T[]>();
  for (const row of rows) {
    if (!isCopy(row)) continue;
    const headId = headFor(row);
    if (headId === null) continue;
    const bucket = childrenByParent.get(headId) ?? [];
    bucket.push(row);
    childrenByParent.set(headId, bucket);
  }

  const claimed = new Set<string>();
  for (const children of childrenByParent.values()) {
    for (const child of children) claimed.add(child.id);
  }

  const groups: DuplicateGroup<T>[] = [];
  for (const row of rows) {
    if (claimed.has(row.id)) continue;
    groups.push({ head: row, children: childrenByParent.get(row.id) ?? [] });
  }
  return groups;
}
