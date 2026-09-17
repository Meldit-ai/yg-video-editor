import type { Prisma } from "@repo/database";
import type { EngineResult } from "./comparison-engine.types.js";

/**
 * Turning an engine result into rows of our own — shared by the run history
 * here and by the uniqueness classifier, which is why it is not inside
 * ComparisonsService.
 */

/** Canonical, order-independent identity of a pair. See the schema comment. */
export function pairKeyOf(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** A video and pair, with the engine's keys already turned into our own ids. */
export interface ResolvedResult {
  videos: {
    submissionId: string;
    engineKey: string;
    ready: boolean;
    durationSeconds: number | null;
  }[];
  pairs: Omit<Prisma.VideoComparisonPairCreateManyInput, "comparisonId">[];
}

/**
 * Turns an engine result into rows, across the two hops it takes to get from
 * a pair back to a submission.
 *
 * **Hop one:** `result.videos[]` carries the URL we submitted beside the
 * engine's own key for it, and `entries` maps that URL back to a submission.
 * **Hop two:** `pairs[].a/b` are those keys, never URLs — the single most
 * common way to get this integration wrong is to treat them as URLs.
 *
 * Anything that cannot complete both hops is dropped rather than guessed at:
 * a URL we never submitted has no row to attach to, and a pair naming a key
 * no video declared cannot be placed against real videos.
 */
export function resolveResult(
  entries: readonly { submissionId: string; url: string }[],
  result: EngineResult,
): ResolvedResult {
  const submissionByUrl = new Map(
    entries.map((entry) => [entry.url, entry.submissionId]),
  );
  const submissionByKey = new Map<string, string>();
  const videos: ResolvedResult["videos"] = [];

  for (const video of result.videos) {
    const submissionId = submissionByUrl.get(video.url);
    if (submissionId === undefined) continue;
    submissionByKey.set(video.key, submissionId);
    videos.push({
      submissionId,
      engineKey: video.key,
      ready: video.ready,
      durationSeconds: video.durationSeconds,
    });
  }

  const seen = new Set<string>();
  const pairs: ResolvedResult["pairs"] = [];

  for (const pair of result.pairs) {
    const a = submissionByKey.get(pair.aKey);
    const b = submissionByKey.get(pair.bKey);
    // A pair of a video with itself says nothing, and would break the unique
    // constraint's assumption that a pair has two sides.
    if (a === undefined || b === undefined || a === b) continue;

    // Deduped on the unordered pair: score, verdict and containment are all
    // symmetric, so {a,b} and {b,a} are the same comparison. The stored order
    // stays the engine's, because `evidence` has an `a` side and a `b` side
    // that must keep pointing at the videos they describe — which is exactly
    // why the unordered identity needs a column of its own.
    const canonical = pairKeyOf(a, b);
    if (seen.has(canonical)) continue;
    seen.add(canonical);

    pairs.push({
      aSubmissionId: a,
      bSubmissionId: b,
      pairKey: canonical,
      score: pair.score,
      verdict: pair.verdict,
      containment: pair.containment,
      // Omitted rather than set to null: Prisma reads a literal `null` on a
      // Json column as "the JSON value null" and wants Prisma.DbNull for an
      // empty one. Leaving the field out says the same thing without the
      // ceremony.
      ...(pair.evidence === null || pair.evidence === undefined
        ? {}
        : { evidence: pair.evidence as Prisma.InputJsonValue }),
    });
  }

  // Appearing in a pair is proof of having been fingerprinted, whatever the
  // status string said. This is what keeps the "could not be read" warning
  // honest when the engine adds a status we do not recognise — a vocabulary
  // change can no longer turn a compared video into a reported failure.
  const compared = new Set(
    pairs.flatMap((pair) => [pair.aSubmissionId, pair.bSubmissionId]),
  );
  for (const video of videos) {
    if (compared.has(video.submissionId)) video.ready = true;
  }

  return { videos, pairs };
}
