import {
  Injectable,
  PayloadTooLargeException,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import {
  MAX_VIDEO_BYTES,
  MAX_VIDEO_SIZE_LABEL,
} from "../submissions.constants.js";

/**
 * Multipart framing around the file itself: the boundaries, the headers and
 * the file name. A few hundred bytes in practice; a megabyte of slack means
 * this guard never rejects a file that multer would have accepted.
 */
const ENVELOPE_SLACK_BYTES = 1024 * 1024;

/**
 * Rejects an over-sized upload from its Content-Length, before a byte of the
 * body is read.
 *
 * multer's own `limits.fileSize` is the real limit, but it is a slow one: it
 * cuts the file short and then *drains the rest of the request* before
 * answering 413, so a browser sending a 5 GB file uploads all 5 GB before
 * being told no. Reading the declared length up front turns that into an
 * instant answer.
 *
 * A guard, so it runs before the upload interceptor. It is a fast path, not a
 * check to be trusted on its own — Content-Length is client-supplied, and a
 * request that lies about it still meets the limit inside multer.
 */
@Injectable()
export class UploadSizeGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{
      headers?: Record<string, string | string[] | undefined>;
    }>();

    const header = request.headers?.["content-length"];
    const declared = Number(Array.isArray(header) ? header[0] : header);
    if (!Number.isFinite(declared)) return true;

    if (declared > MAX_VIDEO_BYTES + ENVELOPE_SLACK_BYTES) {
      throw new PayloadTooLargeException(
        `Video is larger than the ${MAX_VIDEO_SIZE_LABEL} limit`,
      );
    }
    return true;
  }
}
