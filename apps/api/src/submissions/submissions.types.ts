/**
 * Wire types for video submissions. Mirrored in apps/web/src/lib/types.ts —
 * keep the two in step.
 */

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
   * Duplication roll-up, written when a comparison run over this campaign
   * finishes. Null means not compared yet; 0 means compared and matched
   * nothing. See rollUpScores in comparisons.service.ts.
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
