import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Role, Uniqueness, type Prisma } from "@repo/database";
import type {
  ListSubmissionsQueryDto,
  SubmissionSort,
} from "./dto/list-submissions-query.dto.js";
import type { AuthenticatedUser } from "../auth/auth.types.js";
import { PrismaService } from "../prisma/prisma.service.js";
import {
  PLAYBACK_URL_TTL_SECONDS,
  StorageService,
} from "../storage/storage.service.js";
import { UniquenessService } from "../uniqueness/uniqueness.service.js";
import {
  displayFileName,
  resolveContentType,
} from "./submissions.constants.js";
import type { UploadedVideo, VideoSubmissionDto } from "./submissions.types.js";

/** The row shape every read here selects — the editor's name comes along. */
const WITH_EDITOR = {
  editor: { select: { id: true, name: true } },
} satisfies Prisma.VideoSubmissionInclude;

type SubmissionRow = Prisma.VideoSubmissionGetPayload<{
  include: typeof WITH_EDITOR;
}>;

/**
 * Videos editors hand in against a campaign brief.
 *
 * Two rules live here and nowhere else:
 *
 *   - **Who sees what.** An admin sees every submission on a campaign; an
 *     editor sees only their own. Editors are not shown each other's cuts, and
 *     the scoping is a `where` clause rather than a filter after the fact, so
 *     an id belonging to someone else is a 404 rather than a 403 — the same
 *     shape as an id that does not exist.
 *   - **The bytes are never deleted.** `remove` flips `active`, matching every
 *     other model. The object stays in the bucket; only the failed-upload path
 *     in the storage engine ever deletes one.
 *
 * The campaign itself is validated by CampaignAccessGuard before any of this
 * runs, so `campaignId` is always a campaign this caller may see.
 */
@Injectable()
export class SubmissionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly uniqueness: UniquenessService,
  ) {}

  /** Submissions on a campaign, newest first, scoped to what this user sees. */
  async findAll(
    campaignId: string,
    user: AuthenticatedUser,
    query: ListSubmissionsQueryDto = {},
  ): Promise<VideoSubmissionDto[]> {
    const rows = await this.prisma.client.videoSubmission.findMany({
      where: {
        ...this.scope(campaignId, user),
        ...(query.flagged === undefined ? {} : { overThreshold: query.flagged }),
      },
      include: WITH_EDITOR,
      orderBy: orderFor(query.sort),
    });

    // Signing is a local HMAC, not a network call, so signing a page of them
    // in parallel costs nothing.
    return Promise.all(rows.map((row) => this.toDto(row)));
  }

  /**
   * Records an upload the storage engine has already streamed into the bucket.
   *
   * By the time this runs the bytes are stored, so a failure here would leak
   * the object — hence the cleanup on the empty-upload path. Everything else
   * that could fail (wrong campaign, wrong file type, too large) has already
   * been rejected upstream, before any bytes were spent.
   */
  async create(
    campaignId: string,
    user: AuthenticatedUser,
    file: UploadedVideo | undefined,
  ): Promise<VideoSubmissionDto> {
    if (!file) {
      throw new BadRequestException("No video file was uploaded");
    }
    if (file.size === 0) {
      // An empty file is a broken upload, not a submission — and it has an
      // object behind it that nothing will ever point at.
      await this.storage.removeObject(file.objectKey);
      throw new BadRequestException("The uploaded file is empty");
    }

    let row: SubmissionRow;
    try {
      row = await this.prisma.client.videoSubmission.create({
        data: {
          campaignId,
          editorId: user.id,
          fileName: displayFileName(file.originalname),
          objectKey: file.objectKey,
          // Same resolution the storage engine used for the object itself,
          // so the row and the stored object never disagree.
          contentType: resolveContentType(file.mimetype, file.originalname),
          sizeBytes: file.size,
        },
        include: WITH_EDITOR,
      });
    } catch (error) {
      // The bytes are already in the bucket, and multer's own cleanup hook
      // cannot fire this late — without this the object would sit there with
      // nothing pointing at it. removeObject never throws, so the real error
      // is what the caller sees.
      await this.storage.removeObject(file.objectKey);
      throw error;
    }

    // Fire and forget, deliberately. The check compares this video against
    // the campaign's baseline and takes minutes; awaiting it would hold the
    // upload response open past every timeout between here and the browser.
    // It never throws, so an engine that is down cannot turn a stored video
    // into a failed submission.
    this.uniqueness.onArrival("submission", campaignId);

    // Outside the try: the row exists by now, and a failure to sign a URL must
    // not delete a video that was successfully submitted.
    return this.toDto(row);
  }

  /**
   * Soft-deletes a submission. An editor may withdraw their own; an admin may
   * remove any on the campaign.
   */
  async remove(
    campaignId: string,
    submissionId: string,
    user: AuthenticatedUser,
  ): Promise<VideoSubmissionDto> {
    const existing = await this.prisma.client.videoSubmission.findFirst({
      where: { ...this.scope(campaignId, user), id: submissionId },
      include: WITH_EDITOR,
    });
    if (!existing) {
      throw new NotFoundException(`Submission ${submissionId} not found`);
    }
    // Belt and braces: `scope` already hides other editors' rows, so this can
    // only fire if that scoping is ever loosened.
    if (user.role !== Role.ADMIN && existing.editorId !== user.id) {
      throw new ForbiddenException("You can only remove your own submissions");
    }

    const row = await this.prisma.client.videoSubmission.update({
      where: { id: submissionId },
      data: { active: false },
      include: WITH_EDITOR,
    });

    // Only a video in the baseline can have others labelled against it. A
    // DUPLICATE was never compared against, and an unchecked one has no
    // dependants yet.
    if (
      existing.uniqueness === Uniqueness.UNIQUE ||
      existing.uniqueness === Uniqueness.PARTIAL
    ) {
      this.uniqueness.withdraw("submission", campaignId, submissionId);
    }
    return this.toDto(row);
  }

  /**
   * The `where` every read starts from: this campaign, not soft-deleted, and
   * — unless the caller is an admin — only this editor's own rows.
   */
  private scope(
    campaignId: string,
    user: AuthenticatedUser,
  ): Prisma.VideoSubmissionWhereInput {
    const where: Prisma.VideoSubmissionWhereInput = {
      campaignId,
      active: true,
    };
    if (user.role !== Role.ADMIN) where.editorId = user.id;
    return where;
  }

  /** Row plus a freshly signed playback URL. */
  private async toDto(row: SubmissionRow): Promise<VideoSubmissionDto> {
    const playbackUrl = await this.storage.presignPlaybackUrl(
      row.objectKey,
      row.fileName,
      row.contentType,
    );

    return {
      id: row.id,
      campaignId: row.campaignId,
      fileName: row.fileName,
      contentType: row.contentType,
      sizeBytes: row.sizeBytes,
      createdAt: row.createdAt,
      editorId: row.editorId,
      editorName: row.editor.name,
      uniqueness: row.uniqueness,
      duplicationScore: row.duplicationScore,
      averageDuplicationScore: row.averageDuplicationScore,
      topMatchSubmissionId: row.topMatchSubmissionId,
      overThreshold: row.overThreshold,
      duplicationCheckedAt: row.duplicationCheckedAt,
      playbackUrl,
      // Signed just now, so the client can tell how long the URL it holds is
      // good for and refetch instead of showing a broken player.
      playbackExpiresAt: new Date(Date.now() + PLAYBACK_URL_TTL_SECONDS * 1000),
    };
  }
}

/**
 * Prisma ordering for one of the feed's sorts.
 *
 * The label goes first — the enum is declared UNIQUE, PARTIAL, DUPLICATE and
 * Postgres sorts an enum by declaration order — and the match value breaks
 * ties within a label. `nulls: "last"` is the load-bearing part: a video no
 * check has reached yet has a null label and score, and Postgres sorts nulls
 * first ascending. Without it the feed would open with unchecked videos
 * presented as the most original ones.
 */
function orderFor(
  sort: SubmissionSort | undefined,
): Prisma.VideoSubmissionOrderByWithRelationInput[] {
  switch (sort) {
    case "original":
      return [
        { uniqueness: { sort: "asc", nulls: "last" } },
        { duplicationScore: { sort: "asc", nulls: "last" } },
        { createdAt: "desc" },
      ];
    case "duplicate":
      return [
        { uniqueness: { sort: "desc", nulls: "last" } },
        { duplicationScore: { sort: "desc", nulls: "last" } },
        { createdAt: "desc" },
      ];
    default:
      return [{ createdAt: "desc" }];
  }
}
