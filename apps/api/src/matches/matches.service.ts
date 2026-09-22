import { randomUUID } from "node:crypto";
import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { MatchOrigin, SubmissionSource } from "@repo/database";
import { PrismaService } from "../prisma/prisma.service.js";
import { StorageService } from "../storage/storage.service.js";
import { hashUrl } from "./content-hash.js";
import { frameSignatures } from "./frame-signature.js";
import {
  frameShare,
  isSameFootage,
  MIN_FRAMES,
  type FrameOverlap,
} from "./matches.rules.js";
import type {
 
  CrossPlatformMatchDto,
  MatchGroupDto,
  MatchRunResultDto,
  ReelEngagement,
  MatchGroupSort,
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

/**
 * Videos fingerprinted at once.
 *
 * Lower than the hash concurrency because each one is an ffmpeg decode, which
 * costs CPU rather than only bandwidth, and this box has little memory to
 * spare for parallel decoders.
 */
const SIGNATURE_CONCURRENCY = 3;

/** One upload-and-reel pair the run decided on. */
interface MatchPair {
  submissionId: string;
  reelId: string;
  contentHash: string | null;
  /** How much of the upload's footage the reel carries, 0-100. */
  frameShare: number;
  origin: MatchOrigin;
  uploadedAt: Date;
  postedAt: Date | null;
  fileName: string;
  editorName: string;
  username: string;
  permalink: string | null;
  /** Signed at the end of the run, once, rather than per candidate pair. */
  playbackUrl: string;
  reelUrl: string;
}

/** An upload's frame overlap with one reel, as counted by the database. */
interface ReelOverlap extends FrameOverlap {
  reelId: string;
}

/** The reel an adopted submission was copied from, if it was adopted. */
function sourceReelId(fileName: string): string | null {
  return /\[reel ([a-z0-9]+)\]/i.exec(fileName)?.[1] ?? null;
}

/**
 * Matching a campaign's editor uploads against its Instagram reels.
 *
 * Every comparison here is an exact equality — no scores, no engine. What is
 * compared is the picture rather than the file, in two passes:
 *
 *   - **The bytes.** A straight repost is the same file, so a SHA-256 settles
 *     it for one read per video. Measured on this campaign, five accounts
 *     posted one video byte for byte.
 *   - **The frames.** A video re-uploaded rather than reposted is re-encoded,
 *     which changes every byte and leaves the hash blind. Each video is
 *     therefore also reduced to one 64-bit signature per sampled frame, and
 *     two videos sharing enough signatures are the same footage. Measured, a
 *     re-encode shared 92% of its frames and an unrelated video shared none.
 *
 * Both are exact: the second pass matches 64-bit values, it does not score
 * resemblance. The comparison engine is still what runs for editor-against-
 * editor checking, where the question is how alike two different cuts are.
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

    // Fingerprinting is the expensive half — an ffmpeg decode per video — so
    // it runs over the same bounded slice the hashing just covered.
    await this.fingerprintSubmissions(campaignId);
    await this.fingerprintReels(campaignId, reelLimit);

    await this.rebuildMatches(campaignId);
    const matches = await this.findGroups(campaignId);

    const unhashedReels = await this.prisma.client.campaignReel.count({
      where: { campaignId, active: true, contentHash: null },
    });
    const totalReels = await this.prisma.client.campaignReel.count({
      where: { campaignId, active: true },
    });

    this.logger.log(
      `Match run on "${campaign.title}": read ${hashedSubmissions} upload(s) and ${hashedReels} reel(s), ${matches.length} match(es), ${unhashedReels} reel(s) still to read`,
    );

    return {
      campaignId,
      hashedSubmissions,
      hashedReels,
      unhashedReels,
      totalReels,
      trackerLinked: campaign.trackerCampaignId !== null,
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
          select: {
            fileName: true,
            objectKey: true,
            contentType: true,
            editor: { select: { name: true } },
          },
        },
        reel: { select: { username: true, permalink: true, mediaUrl: true } },
      },
      orderBy: { uploadedAt: "desc" },
    });

    // Signing is a local HMAC rather than a network call, so a page of them
    // costs nothing to mint together.
    return Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        submissionId: row.submissionId,
        fileName: row.submission.fileName,
        editorName: row.submission.editor.name,
        uploadedAt: row.uploadedAt,
        playbackUrl: await this.storage.presignPlaybackUrl(
          row.submission.objectKey,
          row.submission.fileName,
          row.submission.contentType,
        ),
        reelId: row.reelId,
        username: row.reel.username,
        permalink: row.reel.permalink,
        postedAt: row.postedAt,
        reelUrl: row.reel.mediaUrl,
        origin: row.origin,
        contentHash: row.contentHash,
        frameShare: row.frameShare,
        checkedAt: row.updatedAt,
      })),
    );
  }

  /**
   * The stored matches, grouped by the edit they belong to.
   *
   * The same cut is often posted by several accounts, and a flat list of pairs
   * repeats the edit once per reel while hiding that they are all the same
   * video. A group shows the edit once and every reel carrying it together.
   */
  async findGroups(
    campaignId: string,
    sort: MatchGroupSort = "recent",
  ): Promise<MatchGroupDto[]> {
    const rows = await this.prisma.client.crossPlatformMatch.findMany({
      where: { campaignId, active: true },
      include: {
        submission: {
          select: {
            fileName: true,
            objectKey: true,
            contentType: true,
            createdAt: true,
            editor: { select: { name: true } },
          },
        },
        reel: {
          select: {
            username: true,
            permalink: true,
            mediaUrl: true,
            postCounts: true,
          },
        },
      },
      orderBy: [{ uploadedAt: "desc" }, { postedAt: "asc" }],
    });

    const bySubmission = new Map<string, typeof rows>();
    for (const row of rows) {
      const bucket = bySubmission.get(row.submissionId) ?? [];
      bucket.push(row);
      bySubmission.set(row.submissionId, bucket);
    }

    const groups = await Promise.all(
      [...bySubmission.values()].map(async (group) => {
        const first = group[0]!;
        return {
          submissionId: first.submissionId,
          fileName: first.submission.fileName,
          editorName: first.submission.editor.name,
          uploadedAt: first.uploadedAt,
          playbackUrl: await this.storage.presignPlaybackUrl(
            first.submission.objectKey,
            first.submission.fileName,
            first.submission.contentType,
          ),
          reels: group.map((row) => ({
            reelId: row.reelId,
            username: row.reel.username,
            permalink: row.reel.permalink,
            postedAt: row.postedAt,
            reelUrl: row.reel.mediaUrl,
            origin: row.origin,
            contentHash: row.contentHash,
            engagement: readEngagement(row.reel.postCounts),
          })),
          totalEngagement: sumEngagement(
            group.map((row) => readEngagement(row.reel.postCounts)),
          ),
          // One reel predating the edit is enough to say the footage was out
          // there first, whatever the others did.
          origin: groupOrigin(group.map((row) => row.origin)),
          checkedAt: first.updatedAt,
        };
      }),
    );

    return sortGroups(groups, sort);
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

  /** Fingerprints uploads that have no signatures yet. */
  private async fingerprintSubmissions(campaignId: string): Promise<number> {
    const rows = await this.prisma.client.videoSubmission.findMany({
      where: {
        campaignId,
        active: true,
        source: SubmissionSource.EDITOR,
        frameSignatures: { none: {} },
      },
      select: { id: true, objectKey: true },
    });

    return this.fingerprintAll(
      campaignId,
      rows,
      (row) => this.storage.publicObjectUrl(row.objectKey),
      (id) => ({ submissionId: id }),
    );
  }

  /** Fingerprints reels that have no signatures yet, oldest post first. */
  private async fingerprintReels(
    campaignId: string,
    limit?: number,
  ): Promise<number> {
    const rows = await this.prisma.client.campaignReel.findMany({
      where: { campaignId, active: true, frameSignatures: { none: {} } },
      select: { id: true, mediaUrl: true },
      orderBy: [{ postedAt: "asc" }, { createdAt: "asc" }],
      ...(limit === undefined ? {} : { take: limit }),
    });

    return this.fingerprintAll(
      campaignId,
      rows,
      (row) => row.mediaUrl,
      (id) => ({ reelId: id }),
    );
  }

  /**
   * Decodes a batch of videos into signatures and stores them.
   *
   * A video that yields too few frames to be evidence is skipped rather than
   * stored: a one-sample clip would "share all of its frames" with anything
   * containing that single still.
   */
  private async fingerprintAll<T extends { id: string }>(
    campaignId: string,
    rows: readonly T[],
    urlOf: (row: T) => string,
    ownerOf: (id: string) => { submissionId?: string; reelId?: string },
  ): Promise<number> {
    let done = 0;

    for (let start = 0; start < rows.length; start += SIGNATURE_CONCURRENCY) {
      const slice = rows.slice(start, start + SIGNATURE_CONCURRENCY);
      const results = await Promise.all(
        slice.map(async (row) => ({
          row,
          signatures: await frameSignatures(urlOf(row)),
        })),
      );

      for (const { row, signatures } of results) {
        if (signatures.length < MIN_FRAMES) continue;
        await this.prisma.client.videoFrameSignature.createMany({
          data: signatures.map((signature, position) => ({
            campaignId,
            ...ownerOf(row.id),
            position,
            signature,
          })),
          skipDuplicates: true,
        });
        done += 1;
      }
    }

    return done;
  }

  /**
   * Every upload's frame overlap with every reel that shares any frame.
   *
   * One query for the whole campaign. The join is on the signature, so the
   * database walks an index rather than the product of two tables: only reels
   * that actually share a frame are ever considered, which is a handful even
   * when the campaign holds thousands.
   *
   * `DISTINCT` on both sides because a video can repeat a frame — a static
   * intro, a held shot — and counting it twice would inflate the share.
   */
  private async frameOverlaps(
    campaignId: string,
  ): Promise<Map<string, ReelOverlap[]>> {
    const rows = await this.prisma.client.$queryRaw<
      { submissionId: string; reelId: string; shared: bigint; total: bigint }[]
    >`
      WITH upload AS (
        SELECT "submissionId" AS id, "signature"
        FROM "VideoFrameSignature"
        WHERE "campaignId" = ${campaignId} AND "submissionId" IS NOT NULL
      ),
      totals AS (
        SELECT id, COUNT(DISTINCT "signature") AS total FROM upload GROUP BY id
      ),
      reel AS (
        SELECT "reelId" AS id, "signature"
        FROM "VideoFrameSignature"
        WHERE "campaignId" = ${campaignId} AND "reelId" IS NOT NULL
      )
      SELECT upload.id      AS "submissionId",
             reel.id        AS "reelId",
             COUNT(DISTINCT upload."signature") AS shared,
             totals.total   AS total
        FROM upload
        JOIN reel   ON reel."signature" = upload."signature"
        JOIN totals ON totals.id = upload.id
       GROUP BY upload.id, reel.id, totals.total
    `;

    const overlaps = new Map<string, ReelOverlap[]>();
    for (const row of rows) {
      const bucket = overlaps.get(row.submissionId) ?? [];
      bucket.push({
        reelId: row.reelId,
        shared: Number(row.shared),
        total: Number(row.total),
      });
      overlaps.set(row.submissionId, bucket);
    }
    return overlaps;
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
   * Recomputes the campaign's matches from what has been read so far.
   *
   * Two ways in, both exact. Identical bytes settle a straight repost outright.
   * Everything else is decided by how many frame signatures the two share,
   * counted by the database on the `(campaignId, signature)` index — a lookup
   * rather than a comparison of every upload against every reel, which at a
   * few thousand reels is the difference between a query and an afternoon.
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
      },
      select: {
        id: true,
        fileName: true,
        objectKey: true,
        contentType: true,
        contentHash: true,
        createdAt: true,
        editor: { select: { name: true } },
      },
      orderBy: { createdAt: "asc" },
    });
    if (submissions.length === 0) return [];

    const reels = await this.prisma.client.campaignReel.findMany({
      where: { campaignId, active: true },
      select: {
        id: true,
        username: true,
        permalink: true,
        postedAt: true,
        mediaUrl: true,
        contentHash: true,
      },
    });
    const reelById = new Map(reels.map((reel) => [reel.id, reel]));

    const overlaps = await this.frameOverlaps(campaignId);
    const byHash = new Map<string, typeof reels>();
    for (const reel of reels) {
      if (reel.contentHash === null) continue;
      const bucket = byHash.get(reel.contentHash) ?? [];
      bucket.push(reel);
      byHash.set(reel.contentHash, bucket);
    }

    const pairs: MatchPair[] = [];
    const seen = new Set<string>();

    for (const submission of submissions) {
      // A submission adopted from a reel is a copy of that reel that we made
      // ourselves. Pairing it with its own source would report our own import
      // as a finding, so only other reels count.
      const ownReel = sourceReelId(submission.fileName);

      const add = (reel: (typeof reels)[number], share: number) => {
        if (reel.id === ownReel) return;
        const key = `${submission.id}:${reel.id}`;
        if (seen.has(key)) return;
        seen.add(key);
        pairs.push({
          submissionId: submission.id,
          reelId: reel.id,
          // Only when both sides really are the same file. A frame match is
          // the same footage re-encoded, and recording the upload's own hash
          // there made the pair read as byte-identical when it is not.
          contentHash:
            submission.contentHash !== null &&
            submission.contentHash === reel.contentHash
              ? submission.contentHash
              : null,
          frameShare: share,
          origin: originOf(submission.createdAt, reel.postedAt),
          uploadedAt: submission.createdAt,
          postedAt: reel.postedAt,
          fileName: submission.fileName,
          editorName: submission.editor.name,
          username: reel.username,
          permalink: reel.permalink,
          // Placeholder: signing every candidate would sign pairs that are
          // then discarded, so the real URL is minted once below.
          playbackUrl: "",
          reelUrl: reel.mediaUrl,
        });
      };

      // Identical bytes first: certain, and it costs nothing to check.
      if (submission.contentHash !== null) {
        for (const reel of byHash.get(submission.contentHash) ?? []) {
          add(reel, 100);
        }
      }

      // Then the re-encodes, which the bytes cannot see.
      for (const overlap of overlaps.get(submission.id) ?? []) {
        const reel = reelById.get(overlap.reelId);
        if (reel === undefined) continue;
        if (!isSameFootage(overlap)) continue;
        add(reel, frameShare(overlap));
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
                frameShare: pair.frameShare,
                origin: pair.origin,
                uploadedAt: pair.uploadedAt,
                postedAt: pair.postedAt,
                updatedAt: now,
              },
              update: {
                active: true,
                contentHash: pair.contentHash,
                frameShare: pair.frameShare,
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

    const keyById = new Map(
      submissions.map((row) => [
        row.id,
        { objectKey: row.objectKey, contentType: row.contentType },
      ]),
    );

    return Promise.all(
      pairs.map(async (pair) => {
        const source = keyById.get(pair.submissionId);
        return {
          id: `${pair.submissionId}:${pair.reelId}`,
          submissionId: pair.submissionId,
          fileName: pair.fileName,
          editorName: pair.editorName,
          uploadedAt: pair.uploadedAt,
          playbackUrl:
            source === undefined
              ? ""
              : await this.storage.presignPlaybackUrl(
                  source.objectKey,
                  pair.fileName,
                  source.contentType,
                ),
          reelId: pair.reelId,
          username: pair.username,
          permalink: pair.permalink,
          postedAt: pair.postedAt,
          reelUrl: pair.reelUrl,
          origin: pair.origin,
          contentHash: pair.contentHash,
          frameShare: pair.frameShare,
          checkedAt: now,
        };
      }),
    );
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

/**
 * A group's origin, from the origins of the reels in it.
 *
 * REEL wins outright: if any one of them was posted before the edit was handed
 * in, the footage was already public, and the later reels change nothing about
 * that. UNKNOWN only when not a single reel carries a date.
 */
export function groupOrigin(origins: readonly MatchOrigin[]): MatchOrigin {
  if (origins.includes(MatchOrigin.REEL)) return MatchOrigin.REEL;
  if (origins.includes(MatchOrigin.EDITOR)) return MatchOrigin.EDITOR;
  return MatchOrigin.UNKNOWN;
}

/**
 * Reads the tracker's `postCounts` blob into fixed fields.
 *
 * The blob is the tracker's shape, not ours, and older posts carry fewer keys
 * — so every field is nullable and a missing one stays null rather than
 * becoming a zero somebody would later add up.
 */
export function readEngagement(raw: unknown): ReelEngagement | null {
  if (raw === null || typeof raw !== "object") return null;
  const counts = raw as Record<string, unknown>;
  const num = (key: string): number | null => {
    const value = counts[key];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  };

  const views = num("views");
  const reach = num("reach");
  // Reach is not the same measure as views, but for "how far did this go" a
  // stand-in beats a blank — flagged so the UI can say which it is showing.
  const viewsFromReach = views === null && reach !== null;

  const engagement: ReelEngagement = {
    views: views ?? reach,
    likes: num("likes"),
    comments: num("comments"),
    // The tracker sends reshares under either name depending on platform.
    shares: num("reshare_count") ?? num("repost_count") ?? num("shares"),
    viewsFromReach,
  };
  // Nothing usable in the blob at all.
  const hasAny =
    engagement.views !== null ||
    engagement.likes !== null ||
    engagement.comments !== null ||
    engagement.shares !== null;
  return hasAny ? engagement : null;
}

/**
 * Adds up a group's reels.
 *
 * A null field stays null only when *every* reel was null: summing three
 * posts of which one reported no likes should still give the likes of the
 * other two, not nothing.
 */
export function sumEngagement(
  parts: readonly (ReelEngagement | null)[],
): MatchGroupDto["totalEngagement"] {
  const counted = parts.filter((part): part is ReelEngagement => part !== null);
  const add = (pick: (part: ReelEngagement) => number | null): number | null => {
    const values = counted
      .map(pick)
      .filter((value): value is number => value !== null);
    return values.length === 0
      ? null
      : values.reduce((total, value) => total + value, 0);
  };
  return {
    views: add((part) => part.views),
    likes: add((part) => part.likes),
    comments: add((part) => part.comments),
    shares: add((part) => part.shares),
    // True only if every counted reel was standing in reach for views, so the
    // caveat is not shown when most of the number is real view counts.
    viewsFromReach:
      counted.length > 0 && counted.every((part) => part.viewsFromReach),
    countedReels: counted.length,
    totalReels: parts.length,
  };
}

/**
 * Orders the groups.
 *
 * "Which edit performed best" is the question the whole match pipeline exists
 * to answer, so reach is a first-class ordering rather than something the
 * reader sorts by hand. A group with no counts sorts last in every engagement
 * order — unknown is not zero, but it cannot lead a ranking either.
 */
function sortGroups(
  groups: readonly MatchGroupDto[],
  sort: MatchGroupSort,
): MatchGroupDto[] {
  if (sort === "recent") return [...groups];
  const value = (group: MatchGroupDto): number | null => {
    const total = group.totalEngagement;
    if (sort === "views") return total.views;
    if (sort === "likes") return total.likes;
    if (sort === "reels") return group.reels.length;
    return null;
  };
  return [...groups].sort((left, right) => {
    const a = value(left);
    const b = value(right);
    // Nulls last, whichever way the comparison would otherwise fall.
    if (a === null && b === null) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    return b - a;
  });
}
