import { randomUUID } from "node:crypto";
import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { MatchOrigin, SubmissionSource } from "@repo/database";
import { PrismaService } from "../prisma/prisma.service.js";
import { StorageService } from "../storage/storage.service.js";
import { hashUrl } from "./content-hash.js";
import type {
  CrossPlatformMatchDto,
  MatchRunResultDto,
} from "./matches.types.js";

/**
 * Videos hashed at once.
 *
 * Each is a download, so this is bounded by bandwidth rather than CPU. Eight
 * keeps the link busy without making a campaign's worth of hashing look like
 * an attack on the object store.
 */
const HASH_CONCURRENCY = 8;

/** Rows written per transaction, so no single lock is long. */
const WRITE_BATCH = 100;

/** The reel an adopted submission was copied from, if it was adopted. */
function sourceReelId(fileName: string): string | null {
  return /\[reel ([a-z0-9]+)\]/i.exec(fileName)?.[1] ?? null;
}

/**
 * Matching a campaign's editor uploads against its Instagram reels.
 *
 * Identity, not similarity: both sides are reduced to a SHA-256 and a match is
 * the very same file. That is the whole rule, and it is why no comparison
 * engine is involved — a straight repost is exact, and hashing a campaign
 * costs one read per video instead of a fingerprint and a pairwise score.
 *
 * What it deliberately cannot see is a re-encode. Instagram re-compressing an
 * upload changes every byte, and the hash then reports nothing at all rather
 * than reporting it weakly. That case belongs to the comparison engine, which
 * still runs for editor-against-editor checking; the two are complementary.
 *
 * Whichever side was published first is the original. Where the reel has no
 * post date the question is left open rather than answered wrongly.
 */
@Injectable()
export class MatchesService {
  private readonly logger = new Logger(MatchesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  /**
   * Hashes whatever is still unhashed on the campaign, then records the pairs.
   *
   * Incremental by construction: a hashed row keeps its hash, so a second run
   * costs only the videos added since the first.
   */
  async run(campaignId: string, reelLimit?: number): Promise<MatchRunResultDto> {
    const campaign = await this.prisma.client.campaign.findFirst({
      where: { id: campaignId, active: true },
      select: { id: true, title: true, trackerCampaignId: true },
    });
    if (campaign === null) throw new BadRequestException("Campaign not found");

    const hashedSubmissions = await this.hashSubmissions(campaignId);
    const hashedReels = await this.hashReels(campaignId, reelLimit);
    const matches = await this.rebuildMatches(campaignId);

    const unhashedReels = await this.prisma.client.campaignReel.count({
      where: { campaignId, active: true, contentHash: null },
    });

    this.logger.log(
      `Match run on "${campaign.title}": hashed ${hashedSubmissions} upload(s) and ${hashedReels} reel(s), ${matches.length} match(es), ${unhashedReels} reel(s) still unhashed`,
    );

    return {
      campaignId,
      hashedSubmissions,
      hashedReels,
      unhashedReels,
      matchCount: matches.length,
      matches,
    };
  }

  /** The stored matches, newest upload first. Computes nothing. */
  async findAll(campaignId: string): Promise<CrossPlatformMatchDto[]> {
    const rows = await this.prisma.client.crossPlatformMatch.findMany({
      where: { campaignId, active: true },
      include: {
        submission: {
          select: { fileName: true, editor: { select: { name: true } } },
        },
        reel: { select: { username: true, permalink: true } },
      },
      orderBy: { uploadedAt: "desc" },
    });

    return rows.map((row) => ({
      id: row.id,
      submissionId: row.submissionId,
      fileName: row.submission.fileName,
      editorName: row.submission.editor.name,
      uploadedAt: row.uploadedAt,
      reelId: row.reelId,
      username: row.reel.username,
      permalink: row.reel.permalink,
      postedAt: row.postedAt,
      origin: row.origin,
      contentHash: row.contentHash,
      checkedAt: row.updatedAt,
    }));
  }

  private async hashSubmissions(campaignId: string): Promise<number> {
    const rows = await this.prisma.client.videoSubmission.findMany({
      where: {
        campaignId,
        active: true,
        source: SubmissionSource.EDITOR,
        contentHash: null,
      },
      select: { id: true, objectKey: true },
    });

    return this.hashAll(
      rows,
      (row) => this.storage.publicObjectUrl(row.objectKey),
      (id, contentHash) =>
        this.prisma.client.videoSubmission.update({
          where: { id },
          data: { contentHash },
        }),
    );
  }

  /**
   * Hashes the campaign's reels, oldest post first.
   *
   * Oldest first so a bounded run covers the beginning of the campaign, where
   * the originals are, rather than an arbitrary slice of the middle.
   */
  private async hashReels(campaignId: string, limit?: number): Promise<number> {
    const rows = await this.prisma.client.campaignReel.findMany({
      where: { campaignId, active: true, contentHash: null },
      select: { id: true, mediaUrl: true },
      orderBy: [{ postedAt: "asc" }, { createdAt: "asc" }],
      ...(limit === undefined ? {} : { take: limit }),
    });

    return this.hashAll(
      rows,
      (row) => row.mediaUrl,
      (id, contentHash) =>
        this.prisma.client.campaignReel.update({
          where: { id },
          data: { contentHash },
        }),
    );
  }

  /** Hashes a batch of rows, a few at a time, and stores what came back. */
  private async hashAll<T extends { id: string }>(
    rows: readonly T[],
    urlOf: (row: T) => string,
    store: (id: string, hash: string) => Promise<unknown>,
  ): Promise<number> {
    let hashed = 0;

    for (let start = 0; start < rows.length; start += HASH_CONCURRENCY) {
      const slice = rows.slice(start, start + HASH_CONCURRENCY);
      const results = await Promise.all(
        slice.map(async (row) => ({ row, hash: await hashUrl(urlOf(row)) })),
      );
      for (const { row, hash } of results) {
        // A row whose object could not be read is left null and retried by the
        // next run, rather than being written as "hashed to nothing".
        if (hash === null) continue;
        await store(row.id, hash);
        hashed += 1;
      }
    }

    return hashed;
  }

  /**
   * Recomputes the campaign's matches from the stored hashes.
   *
   * Rewritten rather than appended to: a video can be withdrawn, and a match
   * that no longer holds must stop being reported.
   */
  private async rebuildMatches(
    campaignId: string,
  ): Promise<CrossPlatformMatchDto[]> {
    const submissions = await this.prisma.client.videoSubmission.findMany({
      where: {
        campaignId,
        active: true,
        source: SubmissionSource.EDITOR,
        contentHash: { not: null },
      },
      select: {
        id: true,
        fileName: true,
        contentHash: true,
        createdAt: true,
        editor: { select: { name: true } },
      },
      orderBy: { createdAt: "asc" },
    });

    const hashes = [
      ...new Set(
        submissions
          .map((row) => row.contentHash)
          .filter((hash): hash is string => hash !== null),
      ),
    ];

    const reels =
      hashes.length === 0
        ? []
        : await this.prisma.client.campaignReel.findMany({
            where: { campaignId, active: true, contentHash: { in: hashes } },
            select: {
              id: true,
              username: true,
              permalink: true,
              postedAt: true,
              contentHash: true,
            },
            orderBy: [{ postedAt: "asc" }, { createdAt: "asc" }],
          });

    const byHash = new Map<string, typeof reels>();
    for (const reel of reels) {
      if (reel.contentHash === null) continue;
      const bucket = byHash.get(reel.contentHash) ?? [];
      bucket.push(reel);
      byHash.set(reel.contentHash, bucket);
    }

    const pairs: {
      submissionId: string;
      reelId: string;
      contentHash: string;
      origin: MatchOrigin;
      uploadedAt: Date;
      postedAt: Date | null;
      fileName: string;
      editorName: string;
      username: string;
      permalink: string | null;
    }[] = [];

    for (const submission of submissions) {
      if (submission.contentHash === null) continue;
      // A submission adopted from a reel is a copy of that reel that we made
      // ourselves. Pairing it with its own source would report our own import
      // as a finding, so only other reels count.
      const ownReel = sourceReelId(submission.fileName);

      for (const reel of byHash.get(submission.contentHash) ?? []) {
        if (reel.id === ownReel) continue;
        pairs.push({
          submissionId: submission.id,
          reelId: reel.id,
          contentHash: submission.contentHash,
          origin: originOf(submission.createdAt, reel.postedAt),
          uploadedAt: submission.createdAt,
          postedAt: reel.postedAt,
          fileName: submission.fileName,
          editorName: submission.editor.name,
          username: reel.username,
          permalink: reel.permalink,
        });
      }
    }

    const now = new Date();
    await this.prisma.client.$transaction(async (tx) => {
      // Retired rather than deleted, so a match that was reported once stays
      // traceable after the video behind it is withdrawn.
      await tx.crossPlatformMatch.updateMany({
        where: { campaignId, active: true },
        data: { active: false },
      });

      for (let start = 0; start < pairs.length; start += WRITE_BATCH) {
        const slice = pairs.slice(start, start + WRITE_BATCH);
        await Promise.all(
          slice.map((pair) =>
            tx.crossPlatformMatch.upsert({
              where: {
                submissionId_reelId: {
                  submissionId: pair.submissionId,
                  reelId: pair.reelId,
                },
              },
              create: {
                id: randomUUID(),
                campaignId,
                submissionId: pair.submissionId,
                reelId: pair.reelId,
                contentHash: pair.contentHash,
                origin: pair.origin,
                uploadedAt: pair.uploadedAt,
                postedAt: pair.postedAt,
                updatedAt: now,
              },
              update: {
                active: true,
                origin: pair.origin,
                uploadedAt: pair.uploadedAt,
                postedAt: pair.postedAt,
                updatedAt: now,
              },
            }),
          ),
        );
      }
    });

    return pairs.map((pair) => ({
      id: `${pair.submissionId}:${pair.reelId}`,
      submissionId: pair.submissionId,
      fileName: pair.fileName,
      editorName: pair.editorName,
      uploadedAt: pair.uploadedAt,
      reelId: pair.reelId,
      username: pair.username,
      permalink: pair.permalink,
      postedAt: pair.postedAt,
      origin: pair.origin,
      contentHash: pair.contentHash,
      checkedAt: now,
    }));
  }
}

/**
 * Which side went public first.
 *
 * A reel with no post date cannot be shown to precede anything, so the pair is
 * left UNKNOWN rather than handing the original to the upload by default.
 */
export function originOf(
  uploadedAt: Date,
  postedAt: Date | null,
): MatchOrigin {
  if (postedAt === null) return MatchOrigin.UNKNOWN;
  return postedAt.getTime() < uploadedAt.getTime()
    ? MatchOrigin.REEL
    : MatchOrigin.EDITOR;
}
