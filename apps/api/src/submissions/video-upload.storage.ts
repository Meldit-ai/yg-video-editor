import { BadRequestException, Logger } from "@nestjs/common";
import { Transform, pipeline, type Readable } from "node:stream";
import type { StorageService } from "../storage/storage.service.js";
import {
  MAX_VIDEO_BYTES,
  MAX_VIDEO_SIZE_LABEL,
  buildObjectKey,
  isAcceptedVideo,
  resolveContentType,
} from "./submissions.constants.js";

const logger = new Logger("VideoUploadStorage");

/** The multer file as it reaches a storage engine: metadata plus the stream. */
interface IncomingFile {
  fieldname: string;
  originalname: string;
  mimetype: string;
  /** multer sets `truncated` on the stream once it has cut the file short. */
  stream: Readable & { truncated?: boolean };
  /** Written by the engine, and echoed back to multer from _handleFile. */
  objectKey?: string;
}

type HandleCallback = (
  error: Error | null,
  info?: { objectKey: string; size: number },
) => void;

/**
 * A multer storage engine that streams the incoming file straight into object
 * storage instead of to memory or disk.
 *
 * Why not the memory storage the vendor importer uses: that one holds a 2 MB
 * spreadsheet. A video is up to 2 GB, and buffering it would trade a fixed
 * 5 MB-per-part footprint for a per-request gigabyte. Nothing ever touches the
 * API's disk either — the bytes go from the socket to Hetzner.
 *
 * A plain object rather than a class, and built by a factory so it can close
 * over the injected StorageService: multer only asks for _handleFile and
 * _removeFile, and Nest's MulterOptions types `storage` loosely enough that no
 * multer import is needed (@types/multer is not installed — see
 * UploadedSpreadsheet in the vendors importer for the same constraint).
 */
export function createVideoUploadStorage(storage: StorageService) {
  return {
    _handleFile(
      request: { params?: Record<string, string> },
      file: IncomingFile,
      callback: HandleCallback,
    ): void {
      // Express has already matched the route, so :campaignId is populated;
      // the guard on the controller has also already proved the campaign
      // exists and that this user may see it, which is what keeps a 2 GB body
      // from being streamed to storage for a campaign that will 404 anyway.
      const campaignId = request.params?.campaignId;
      if (typeof campaignId !== "string" || campaignId.length === 0) {
        callback(new BadRequestException("Missing campaign id"));
        return;
      }

      const objectKey = buildObjectKey(campaignId, file.originalname);
      // Written onto the file as well as returned below: when multer aborts
      // mid-file it builds _removeFile's argument from the file object alone,
      // and without this it would have no key to clean up.
      file.objectKey = objectKey;

      // Counted here rather than trusted from the client, and rather than read
      // off the SDK's progress events: this is the number that goes in the row.
      let size = 0;
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          size += chunk.length;
          done(null, chunk);
        },
      });

      // startUpload throws when the bucket is not configured. multer parks on
      // this callback and has no timeout, so a throw that escaped here would
      // hang the request forever rather than answering 503.
      let upload: ReturnType<StorageService["startUpload"]>;
      try {
        upload = storage.startUpload(
          objectKey,
          counter,
          // Not file.mimetype: an untyped upload has to be stored as the video
          // it is, or the playback URL will serve it as a download.
          resolveContentType(file.mimetype, file.originalname),
        );
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
        return;
      }

      // Whether the browser hung up or multer tripped the size limit, the
      // multipart upload has to be told: an abandoned one keeps its uploaded
      // parts (and bills for them) until it is aborted.
      //
      // abort() only raises a flag — the SDK cannot send AbortMultipartUpload
      // while it is still blocked reading the body, so the body has to be
      // destroyed too or the upload dangles and the parts are never reclaimed.
      let failure: Error | null = null;
      const fail = (error: Error): void => {
        failure ??= error;
        void upload.abort().catch(() => {
          /* aborting a failed upload is best-effort */
        });
        counter.destroy();
      };

      // multer truncates the stream at limits.fileSize and signals it here. It
      // raises LIMIT_FILE_SIZE on its own (which Nest turns into a 413), so
      // this only has to stop the upload from completing with a half file.
      file.stream.once("limit", () => {
        fail(
          new BadRequestException(
            `Video is larger than the ${MAX_VIDEO_SIZE_LABEL} limit`,
          ),
        );
      });

      // pipeline, not pipe: it propagates a destroyed source (a cancelled
      // request) to the destination, so the SDK sees an errored body and
      // rejects instead of quietly finishing a truncated object.
      pipeline(file.stream, counter, (error) => {
        if (error) fail(error);
      });

      // Two-argument then, not .then().catch(): a chained catch would also fire
      // if the success handler threw, and calling multer back twice is as
      // broken as never calling it.
      upload.done().then(
        () => {
          // Truncation does not look like an error from here: multer signals
          // 'limit' and then ends the stream cleanly, so an engine that only
          // watched for errors would report a half video as a success.
          if (file.stream.truncated === true) {
            fail(
              new BadRequestException(
                `Video is larger than the ${MAX_VIDEO_SIZE_LABEL} limit`,
              ),
            );
          }
          if (failure) {
            // The abort raced a completing upload — drop whatever landed.
            void storage.removeObject(objectKey);
            callback(failure);
            return;
          }
          callback(null, { objectKey, size });
        },
        (error: unknown) => {
          const reason =
            error instanceof Error ? error : new Error(String(error));
          logger.warn(`Upload of ${objectKey} failed: ${reason.message}`);
          // A rejected upload completed nothing, so there is normally no
          // object to remove — but a part-way failure after the final part is
          // indistinguishable from here, and deleting a key that does not
          // exist is a no-op.
          void storage.removeObject(objectKey);
          callback(failure ?? reason);
        },
      );
    },

    /**
     * multer's cleanup hook, called when a later part of the request fails
     * after this file was already stored. The row that would point at this
     * object was never written, so the bytes are garbage.
     */
    _removeFile(
      _request: unknown,
      file: IncomingFile,
      callback: (error: Error | null) => void,
    ): void {
      const { objectKey } = file;
      if (!objectKey) {
        callback(null);
        return;
      }
      void storage.removeObject(objectKey).finally(() => callback(null));
    },
  };
}

/**
 * The multer options for the submission route: stream to storage, one file,
 * capped, and only videos.
 *
 * Registered module-wide (MulterModule.registerAsync) rather than inline on
 * the interceptor because the engine needs StorageService injected. Nest only
 * resolves those options for interceptors inside modules that import
 * MulterModule, so the vendors importer keeps its own memory-storage settings.
 */
export function videoUploadMulterOptions(storage: StorageService) {
  return {
    storage: createVideoUploadStorage(storage),
    // `fields: 0` is not tidiness — it is the bound on everything that is not
    // the file. multer sets no limits of its own and busboy defaults them to
    // Infinity, so without it any signed-in caller can stream text parts that
    // multer accumulates in `req.body` until the process runs out of heap.
    // Nothing streams them anywhere: only the file part reaches storage. The
    // browser sends exactly one part, named "file".
    limits: { fileSize: MAX_VIDEO_BYTES, files: 1, fields: 0, parts: 2 },
    // Keeps a non-ASCII file name readable when it is stored and echoed back.
    defParamCharset: "utf8",
    // The callback signature is multer's, as Nest types it: an error wins, and
    // the boolean is only read when there is none.
    fileFilter(
      _request: unknown,
      file: { originalname: string; mimetype: string },
      callback: (error: Error | null, acceptFile: boolean) => void,
    ): void {
      // Runs before a byte is streamed, so a rejected file costs nothing.
      if (!isAcceptedVideo(file.mimetype, file.originalname)) {
        callback(
          new BadRequestException(
            `"${file.originalname}" is not a video file. Upload an MP4, MOV, WebM or similar.`,
          ),
          false,
        );
        return;
      }
      callback(null, true);
    },
  };
}
