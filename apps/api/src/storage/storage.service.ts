import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { ownObjectKey } from "./object-key.js";
import type { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * How long a playback URL stays valid. Long enough to watch a long cut without
 * the link dying mid-scrub, short enough that a copied URL is not a permanent
 * public link to the file.
 */
export const PLAYBACK_URL_TTL_SECONDS = 6 * 60 * 60;

/** Env var per config key, so a missing one can be named in the error. */
const ENV_KEYS = {
  accessKeyId: "HETZNER_BUCKET_ACCESS_KEY",
  secretAccessKey: "HETZNER_BUCKET_SECRET_KEY",
  bucket: "HETZNER_BUCKET_NAME",
  region: "HETZNER_BUCKET_REGION",
  endpoint: "HETZNER_BUCKET_ENDPOINT",
} as const;

type ConfigKey = keyof typeof ENV_KEYS;

interface StorageConfig {
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  region: string;
  endpoint: string;
}

/**
 * A Content-Disposition header value cannot carry arbitrary bytes, and the
 * name only exists to give a saved file a sensible title. Anything outside
 * printable ASCII (and the quotes that would end the parameter early) becomes
 * an underscore rather than risking a mangled header.
 */
function asciiFileName(fileName: string): string {
  const cleaned = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return cleaned.trim().slice(0, 120) || "video";
}

/**
 * Hetzner Object Storage, spoken to over the S3 API.
 *
 * Everything here is deliberately lazy, mirroring PrismaService: the client is
 * built on first use and a missing credential is a per-request 503, not a boot
 * crash. The API must still start (and /api/health must still answer) on a
 * machine that has no bucket credentials.
 *
 * Addressing is left at the SDK default — virtual-hosted style against
 * `bucket.fsn1.your-objectstorage.com`, which is what Hetzner's own docs
 * recommend and what their wildcard certificate covers. (A bucket name
 * containing a dot would not be covered and would need forcePathStyle.)
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private cached: { config: StorageConfig; client: S3Client } | null = null;

  /**
   * Streams `body` into the bucket under `key`.
   *
   * Returns the in-flight upload rather than a promise on purpose: the caller
   * (the multer storage engine) is streaming a request body it does not
   * control, and needs `abort()` for the cases where the browser hangs up or
   * the size limit trips mid-flight. `Upload` does multipart in 5 MB parts,
   * so a 2 GB video never lands in memory.
   */
  startUpload(key: string, body: Readable, contentType: string): Upload {
    const { client, config } = this.connection();
    return new Upload({
      client,
      params: {
        Bucket: config.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      },
    });
  }

  /**
   * A time-limited URL a browser can play from directly.
   *
   * Presigned rather than public: the bucket stays private, and the URL is
   * only as long-lived as PLAYBACK_URL_TTL_SECONDS. Hetzner answers these with
   * `Accept-Ranges: bytes` and honours a Range request, which is what lets a
   * <video> element seek instead of downloading the whole file first.
   */
  presignPlaybackUrl(
    key: string,
    fileName: string,
    contentType: string,
  ): Promise<string> {
    const { client, config } = this.connection();
    return getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: config.bucket,
        Key: key,
        // Replayed on the response so the browser plays the file inline
        // instead of offering it as a download named after the object key.
        ResponseContentType: contentType,
        ResponseContentDisposition: `inline; filename="${asciiFileName(fileName)}"`,
      }),
      { expiresIn: PLAYBACK_URL_TTL_SECONDS },
    );
  }

  /**
   * The object's plain, unsigned address — `https://<bucket>.<host>/<key>`.
   *
   * This is what the comparison engine is handed, and it is deliberately NOT
   * a presigned URL. The engine derives a video's cache identity by hashing
   * the URL it was given, so a signature (which carries a timestamp and
   * expires) would make the same file look like a new video on every run and
   * defeat its cache. The signed form is for browsers; this one is for a
   * server-side consumer that reaches the bucket with its own credentials.
   *
   * Virtual-hosted style, matching the SDK's own addressing — see the class
   * comment for why path style is not used.
   */
  /**
   * The key a URL names inside our own bucket, or null when it is elsewhere.
   *
   * The tracker writes a campaign's reels into this same bucket, so a reel is
   * already one of our objects and there is nothing to copy — see
   * `ownObjectKey`.
   */
  objectKeyOf(url: string): string | null {
    const { config } = this.connection();
    return ownObjectKey(url, config.endpoint, config.bucket);
  }

  /**
   * An object's type and size, or null when it cannot be read.
   *
   * Used when adopting a reel that already lives in our bucket: the row still
   * needs a content type and a size, and asking the bucket is both cheaper and
   * more trustworthy than a header from whoever served the URL.
   */
  async statObject(
    key: string,
  ): Promise<{ contentType: string; sizeBytes: number } | null> {
    const { client, config } = this.connection();
    try {
      const head = await client.send(
        new HeadObjectCommand({ Bucket: config.bucket, Key: key }),
      );
      return {
        contentType: head.ContentType ?? "video/mp4",
        sizeBytes: Number(head.ContentLength ?? 0),
      };
    } catch {
      // A missing or unreadable object is not fatal here — the caller stores
      // sensible defaults rather than abandoning the adoption.
      return null;
    }
  }

  publicObjectUrl(key: string): string {
    const { config } = this.connection();
    const host = new URL(config.endpoint).host;
    // Encoded per segment: the slashes are path structure, not data. Keys are
    // generated server-side from a uuid so nothing here needs escaping today,
    // but a key format that changes must not silently produce a broken URL.
    const path = key.split("/").map(encodeURIComponent).join("/");
    return `https://${config.bucket}.${host}/${path}`;
  }

  /**
   * Deletes an object. Only ever used to clean up after a failed upload —
   * submissions are soft-deleted and keep their bytes.
   *
   * Never throws: it runs on paths that are already handling an error, and a
   * failed cleanup must not replace the real one. A leaked object is logged
   * and left behind.
   */
  async removeObject(key: string): Promise<void> {
    try {
      const { client, config } = this.connection();
      await client.send(
        new DeleteObjectCommand({ Bucket: config.bucket, Key: key }),
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Could not delete orphaned object ${key}: ${reason}`);
    }
  }

  /**
   * The memoised client plus the config it was built from. The S3 client holds
   * a connection pool, so it is built once and reused for every upload.
   */
  private connection(): { client: S3Client; config: StorageConfig } {
    if (this.cached) return this.cached;

    const config = this.readConfig();
    const client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      // The SDK adds CRC32 checksum headers to uploads by default, and hangs
      // an `x-amz-checksum-mode` parameter off every presigned URL. Hetzner
      // tolerates both — verified against this bucket — but it is an
      // S3-compatible service, not S3, and several such services reject them
      // outright. Turning them off costs nothing: SigV4 already signs a
      // payload hash per part. Both keys are needed; setting only the response
      // one makes presigned URLs sprout a bogus checksum parameter instead.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });

    this.logger.log(
      `Object storage ready: bucket "${config.bucket}" at ${config.endpoint}`,
    );
    this.cached = { config, client };
    return this.cached;
  }

  /** Reads and validates the env block, naming every variable that is missing. */
  private readConfig(): StorageConfig {
    const entries = Object.entries(ENV_KEYS) as [ConfigKey, string][];
    const missing = entries
      .filter(([, name]) => (process.env[name] ?? "").trim().length === 0)
      .map(([, name]) => name);

    if (missing.length > 0) {
      // 503, not 500: the request is fine, the server is not set up to serve
      // it. The message names the variables so a misconfigured deploy is
      // obvious from the response alone.
      throw new ServiceUnavailableException(
        `Video storage is not configured. Missing: ${missing.join(", ")}`,
      );
    }

    return Object.fromEntries(
      entries.map(([key, name]) => [key, (process.env[name] ?? "").trim()]),
    ) as unknown as StorageConfig;
  }
}
