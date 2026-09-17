import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  ComparisonVerdict,
  Role,
  type Prisma,
  type VideoComparison,
} from "@repo/database";
import type { AuthenticatedUser } from "../auth/auth.types.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { UniquenessService } from "../uniqueness/uniqueness.service.js";
import type {
  ComparisonDto,
  ComparisonGroupDto,
  ComparisonPairDto,
  ComparisonSummaryDto,
  ComparisonVideoDto,
} from "./comparisons.types.js";

/** Nothing to compare a single video against. */
const MIN_VIDEOS = 2;

/** The row shape every read selects: the roster and pairs come along. */
const WITH_DETAIL = {
  entries: {
    include: {
      submission: {
        select: {
          id: true,
          fileName: true,
          editorId: true,
          createdAt: true,
          editor: { select: { name: true } },
        },
      },
    },
  },
  pairs: { orderBy: { score: "desc" } },
} satisfies Prisma.VideoComparisonInclude;

type ComparisonRow = Prisma.VideoComparisonGetPayload<{
  include: typeof WITH_DETAIL;
}>;

/**
 * The record of duplicate checks over a campaign's video submissions.
 *
 * The checking itself lives in `UniquenessService`: every upload is labelled
 * UNIQUE, PARTIAL or DUPLICATE against the campaign's baseline, and each
 * batch of that work is written here as a `VideoComparison` run with the
 * engine calls it made and the candidate-vs-baseline pairs it got back. This
 * service reads those runs back, scoped to what the caller may see, and
 * fronts the admin's "check everything again" button — which is a rebuild:
 * the campaign replayed from scratch in upload order.
 *
 * Two things about the stored pairs shape the reads:
 *
 *   - **A run is not the whole matrix.** An upload's run holds the new
 *     video against the baseline and nothing else, so "not in the latest
 *     run" does not mean "unchecked" — the per-video label on the
 *     submission row is the truth, and the run is the evidence behind it.
 *   - **Pairs reference submissions, not engine keys.** The hop from the
 *     engine's keys to our ids happened when the run was written (see
 *     `engine-result.ts`); nothing here needs the engine.
 */
@Injectable()
export class ComparisonsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly uniqueness: UniquenessService,
  ) {}

  /**
   * Replays the whole campaign through the classifier and returns the run
   * that records it, as soon as that run exists. A single video has nothing
   * to be compared against, so that is refused rather than recorded as an
   * empty run.
   */
  async rebuild(campaignId: string): Promise<ComparisonSummaryDto> {
    const videos = await this.prisma.client.videoSubmission.count({
      where: { campaignId, active: true },
    });
    if (videos < MIN_VIDEOS) {
      throw new BadRequestException(
        `At least ${MIN_VIDEOS} submitted videos are needed to run a comparison.`,
      );
    }

    const runId = await this.uniqueness.rebuild("submission", campaignId);
    const row = await this.prisma.client.videoComparison.findFirst({
      where: { id: runId },
    });
    if (row === null) throw new NotFoundException(`Comparison ${runId} not found`);
    return this.toSummary(row);
  }

  /** Runs on a campaign, newest first. Summaries only — no pairs. */
  async findAll(campaignId: string): Promise<ComparisonSummaryDto[]> {
    const rows = await this.prisma.client.videoComparison.findMany({
      where: { campaignId, active: true },
      orderBy: { createdAt: "desc" },
    });
    return rows.map((row) => this.toSummary(row));
  }

  /**
   * The current run for a campaign, in full, or null when none has been made.
   *
   * "Current" is the newest row of any status: a run that failed or is still
   * queued is what the campaign's duplicate check currently *is*, and hiding
   * it in favour of an older success would misreport the state.
   */
  async findLatest(
    campaignId: string,
    user: AuthenticatedUser,
  ): Promise<ComparisonDto | null> {
    const row = await this.prisma.client.videoComparison.findFirst({
      where: { campaignId, active: true },
      orderBy: { createdAt: "desc" },
      include: WITH_DETAIL,
    });
    return row === null ? null : this.toDto(row, user);
  }

  /** One run in full. 404s for an id that is not on this campaign. */
  async findOne(
    campaignId: string,
    id: string,
    user: AuthenticatedUser,
  ): Promise<ComparisonDto> {
    const row = await this.prisma.client.videoComparison.findFirst({
      where: { id, campaignId, active: true },
      include: WITH_DETAIL,
    });
    if (row === null) {
      throw new NotFoundException(`Comparison ${id} not found`);
    }
    return this.toDto(row, user);
  }

  /* -------------------------------------------------------------------- dtos */

  private toSummary(row: VideoComparison): ComparisonSummaryDto {
    return {
      id: row.id,
      campaignId: row.campaignId,
      status: row.status,
      stage: row.stage,
      pairsDone: row.pairsDone,
      pairsTotal: row.pairsTotal,
      videoCount: row.videoCount,
      flaggedPairCount: row.flaggedPairCount,
      engineVersion: row.engineVersion,
      errorMessage: row.errorMessage,
      triggerSubmissionId: row.triggerSubmissionId,
      createdAt: row.createdAt,
      completedAt: row.completedAt,
    };
  }

  /**
   * A run as this caller may see it.
   *
   * An admin gets everything. An editor gets the verdict on their own videos
   * and nothing that identifies the counterpart: the other video keeps its
   * id — the UI needs *something* to key a row on — but its name, its editor
   * and its timings are stripped, and pairs between two videos that are both
   * someone else's are dropped entirely. So an editor learns "this cut of
   * mine duplicates another submission on this campaign" and cannot learn
   * whose, which is the same line SubmissionsService already draws.
   *
   * Groups are admin-only for the same reason: a cluster is a statement about
   * several editors' work at once.
   */
  private toDto(row: ComparisonRow, user: AuthenticatedUser): ComparisonDto {
    const isAdmin = user.role === Role.ADMIN;
    const isOwn = (submissionId: string): boolean =>
      row.entries.some(
        (entry) =>
          entry.submissionId === submissionId &&
          entry.submission.editorId === user.id,
      );

    // Every video stays on the roster even for an editor: a pair needs both
    // of its sides present to render at all, and a redacted entry says
    // "someone else's" without saying whose.
    const videos: ComparisonVideoDto[] = row.entries.map((entry) => {
      const own = isAdmin || entry.submission.editorId === user.id;
      return {
        submissionId: entry.submissionId,
        fileName: own ? entry.submission.fileName : "Another submission",
        editorId: own ? entry.submission.editorId : "",
        editorName: own ? entry.submission.editor.name : "Another editor",
        submittedAt: own ? entry.submission.createdAt : new Date(0),
        ready: entry.ready,
        // A duration is a fingerprint of someone else's cut, and it is only
        // rendered beside a name anyway.
        durationSeconds: own ? entry.durationSeconds : null,
      };
    });

    const pairs: ComparisonPairDto[] = row.pairs
      .filter(
        (pair) =>
          isAdmin || isOwn(pair.aSubmissionId) || isOwn(pair.bSubmissionId),
      )
      .map((pair) => ({
        id: pair.id,
        aSubmissionId: pair.aSubmissionId,
        bSubmissionId: pair.bSubmissionId,
        score: pair.score,
        verdict: pair.verdict,
        containment: pair.containment,
        // The evidence names timings and coverage of *both* sides, so an
        // editor gets it only when both sides are their own — which is the
        // common case, since most duplicates are someone re-uploading their
        // own cut. Against another editor's video it would describe a cut
        // they may not see.
        evidence:
          isAdmin || (isOwn(pair.aSubmissionId) && isOwn(pair.bSubmissionId))
            ? pair.evidence
            : null,
      }));

    return {
      ...this.toSummary(row),
      videos,
      pairs,
      groups: isAdmin ? buildGroups(pairs) : [],
    };
  }
}

/**
 * Clusters videos that are related to each other.
 *
 * Connected components over every pair that is not NO_MATCH — the engine's own
 * rule (a score of 25 is exactly the NO_MATCH boundary), applied to the pairs
 * that were stored rather than read from its `summary.groups`. Same answer,
 * and it cannot drift out of step with the pairs the UI actually renders.
 *
 * Transitivity is intended: A-B and B-C put all three together even when A-C
 * was never strong, because that is usually one cut circulating in three
 * edits. `minScore` is the weakest edge holding the group together, and is
 * where to look when a group seems too generous.
 */
export function buildGroups(pairs: ComparisonPairDto[]): ComparisonGroupDto[] {
  const flagged = pairs.filter(
    (pair) => pair.verdict !== ComparisonVerdict.NO_MATCH,
  );
  if (flagged.length === 0) return [];

  const parent = new Map<string, string>();

  function find(id: string): string {
    const seen = parent.get(id);
    if (seen === undefined) {
      parent.set(id, id);
      return id;
    }
    if (seen === id) return id;
    const root = find(seen);
    parent.set(id, root); // Path compression.
    return root;
  }

  for (const pair of flagged) {
    const a = find(pair.aSubmissionId);
    const b = find(pair.bSubmissionId);
    if (a !== b) parent.set(a, b);
  }

  const members = new Map<string, string[]>();
  for (const id of parent.keys()) {
    const root = find(id);
    const group = members.get(root);
    if (group === undefined) members.set(root, [id]);
    else group.push(id);
  }

  const groups: ComparisonGroupDto[] = [];
  for (const [root, submissionIds] of members) {
    const scores = flagged
      .filter((pair) => find(pair.aSubmissionId) === root)
      .map((pair) => pair.score);

    groups.push({
      submissionIds,
      minScore: Math.min(...scores),
      maxScore: Math.max(...scores),
    });
  }

  // Biggest cluster first, then the most certain — the order an admin wants
  // to work through them in.
  return groups.sort(
    (left, right) =>
      right.submissionIds.length - left.submissionIds.length ||
      right.maxScore - left.maxScore,
  );
}
