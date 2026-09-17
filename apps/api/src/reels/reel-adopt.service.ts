import { Readable } from "node:stream";
import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { Role, SubmissionSource } from "@repo/database";
import { PrismaService } from "../prisma/prisma.service.js";
import { StorageService } from "../storage/storage.service.js";
import { buildObjectKey } from "../submissions/submissions.constants.js";
import { UniquenessService } from "../uniqueness/uniqueness.service.js";

/** Reels are short; anything slower than this is a stalled download. */
const DOWNLOAD_TIMEOUT_MS = 120_000;

export interface AdoptResultDto {
  campaignId: string;
  /** Reels turned into submissions by this call. */
  adopted: number;
  /** Reels already adopted by an earlier call. */
  alreadyAdopted: number;
  failed: number;
  /** Submissions now on the campaign, from every source. */
  totalSubmissions: number;
}

/**
 * Turning imported reels into ordinary video submissions.
 *
 * A reel becomes a real row in the same table an editor's upload lands in,
 * with its bytes copied into our own bucket. From that point nothing
 * downstream knows or cares where it came from: the campaign feed lists it,
 * the duplicate check scores it against every other video on the campaign, and
 * the vendor share can send it — all through the code that already exists,
 * rather than a parallel path that has to be kept in step.
 *
 * Copying the bytes rather than pointing at the tracker's URL is deliberate.
 * Playback is a presigned URL over `objectKey`, and the comparison engine
 * caches on the URL it is given; both assume the object is ours. Referencing a
 * third party's storage would leave a submission that breaks the day they move
 * the file.
 */
@Injectable()
export class ReelAdoptService {
  private readonly logger = new Logger(ReelAdoptService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly uniqueness: UniquenessService,
  ) {}

  /**
   * Copies every not-yet-adopted reel on a campaign into a submission.
   *
   * Attributed to the editor given, since a submission must belong to someone
   * and the reel's Instagram profile is not a user of this system. The
   * creator's handle is kept in the file name so the row still says where it
   * came from.
   */
  async adoptAll(campaignId: string, editorId: string): Promise<AdoptResultDto> {
    const [campaign, editor, reels] = await Promise.all([
      this.prisma.client.campaign.findFirst({
        where: { id: campaignId, active: true },
        select: { id: true },
      }),
      this.prisma.client.user.findFirst({
        where: { id: editorId, active: true },
        select: { id: true, role: true },
      }),
      this.prisma.client.campaignReel.findMany({
        where: { campaignId, active: true },
        select: {
          id: true,
          username: true,
          mediaUrl: true,
          postedAt: true,
        },
        // Oldest first, so the earliest post is the first submission on the
        // campaign — which is what makes it the original once scored.
        orderBy: [{ postedAt: "asc" }, { createdAt: "asc" }],
      }),
    ]);

    if (campaign === null) throw new BadRequestException("Campaign not found");
    if (editor === null) throw new BadRequestException("Editor not found");
    if (editor.role !== Role.EDITOR) {
      throw new BadRequestException(
        "Reels must be attributed to an editor, not an admin.",
      );
    }
    if (reels.length === 0) {
      throw new BadRequestException(
        "No reels have been imported for this campaign yet.",
      );
    }

    // File names carry the reel id, so a second run can tell what it already
    // took without a column linking the two tables.
    const existing = await this.prisma.client.videoSubmission.findMany({
      where: { campaignId, active: true },
      select: { fileName: true },
    });
    const taken = new Set(
      existing
        .map((row) => reelIdFromFileName(row.fileName))
        .filter((id): id is string => id !== null),
    );

    let adopted = 0;
    let alreadyAdopted = 0;
    let failed = 0;

    for (const reel of reels) {
      if (taken.has(reel.id)) {
        alreadyAdopted += 1;
        continue;
      }
      try {
        await this.adoptOne(campaignId, editor.id, reel);
        adopted += 1;
      } catch (caught) {
        failed += 1;
        const reason = caught instanceof Error ? caught.message : String(caught);
        this.logger.warn(`Could not adopt reel @${reel.username}: ${reason}`);
      }
    }

    const totalSubmissions = await this.prisma.client.videoSubmission.count({
      where: { campaignId, active: true },
    });

    this.logger.log(
      `Adopted ${adopted} reel(s) as submissions on campaign ${campaignId} (${failed} failed)`,
    );

    // One classification batch after every copy has landed rather than one
    // per reel: the batch picks up everything pending in arrival order, and
    // fire-and-forget like the upload path — awaiting it would hold this
    // response open past every timeout between here and the browser.
    if (adopted > 0) this.uniqueness.onArrival("submission", campaignId);

    return { campaignId, adopted, alreadyAdopted, failed, totalSubmissions };
  }

  /** Streams one reel into our bucket and records it as a submission. */
  private async adoptOne(
    campaignId: string,
    editorId: string,
    reel: { id: string; username: string; mediaUrl: string },
  ): Promise<void> {
    const response = await fetch(reel.mediaUrl, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok || response.body === null) {
      throw new Error(`source responded with HTTP ${response.status}`);
    }

    const contentType = response.headers.get("content-type") ?? "video/mp4";
    const fileName = `${reel.username} [reel ${reel.id}].mp4`;
    const objectKey = buildObjectKey(campaignId, fileName);

    // Streamed rather than buffered: a reel is small, but the same path will
    // carry longer videos and holding one in memory per reel does not scale.
    const upload = this.storage.startUpload(
      objectKey,
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      contentType,
    );
    await upload.done();

    // Measured from the object, never trusted from the source's header.
    const sizeBytes = Number(response.headers.get("content-length") ?? 0);

    try {
      await this.prisma.client.videoSubmission.create({
        data: {
          campaignId,
          editorId,
          fileName,
          objectKey,
          contentType,
          sizeBytes,
          // Never an editor's hand-in, however it is attributed: the campaign
          // feed reads one workflow at a time and this belongs to the other.
          source: SubmissionSource.TRACKER,
        },
      });
    } catch (caught) {
      // The bytes are already in the bucket; without this the object would sit
      // there with nothing pointing at it. removeObject never throws.
      await this.storage.removeObject(objectKey);
      throw caught;
    }
  }
}

/** The reel id an adopted submission's file name carries, if it has one. */
export function reelIdFromFileName(fileName: string): string | null {
  const match = /\[reel ([a-z0-9]+)\]/i.exec(fileName);
  return match?.[1] ?? null;
}
