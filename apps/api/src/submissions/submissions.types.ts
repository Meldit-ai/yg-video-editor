/**
 * Wire types for video submissions. Mirrored in apps/web/src/lib/types.ts —
 * keep the two in step.
 */
import type { Uniqueness } from "@repo/database";

/**
 * The bit of the multer file we use, after the S3 storage engine has run.
 *
 * `objectKey` is not a multer field: the engine returns it from _handleFile and
 * multer merges it in, which is how the controller learns where the bytes went.
 *
 * Must stay an INTERFACE, for the same reason as UploadedSpreadsheet in the
 * vendors importer: a class-typed @UploadedFile() parameter is run through the
 * global ValidationPipe and rejected by forbidNonWhitelisted.
 */
export interface UploadedVideo {
  originalname: string;
  mimetype: string;
  size: number;
  objectKey: string;
  /** SHA-256 of the bytes, hex, measured by the storage engine as they streamed. */
  sha256?: string;
}

/**
 * A submission as the client sees it. The object key never leaves the server:
 * a browser can do nothing with it, and the playback URL is the only handle it
 * needs.
 */
export interface VideoSubmissionDto {
  id: string;
  campaignId: string;
  /** The uploader's own file name, for display. */
  fileName: string;
  contentType: string;
  sizeBytes: number;
  createdAt: Date;
  /** Who submitted it. Admins see every editor's name here. */
  editorId: string;
  editorName: string;
  /**
   * Where this video stands against the campaign's baseline — null while it
   * is still to be checked, or when the engine could not read it (then
   * `duplicationCheckedAt` is set). See VideoSubmission.uniqueness.
   */
  uniqueness: Uniqueness | null;
  /**
   * Match value: the highest max(score, containment) against any baseline
   * video. Null means not checked yet; 0 means there was nothing to compare
   * against.
   */
  duplicationScore: number | null;
  averageDuplicationScore: number | null;
  topMatchSubmissionId: string | null;
  overThreshold: boolean;
  duplicationCheckedAt: Date | null;
  /** Time-limited URL for <video src>. Expires — see playbackExpiresAt. */
  playbackUrl: string;
  playbackExpiresAt: Date;
}
