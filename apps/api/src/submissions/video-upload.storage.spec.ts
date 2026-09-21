import { PassThrough, type Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StorageService } from "../storage/storage.service.js";
import {
  createVideoUploadStorage,
  videoUploadMulterOptions,
} from "./video-upload.storage.js";

/**
 * A stand-in for lib-storage's Upload: it drains whatever body it is given,
 * exactly as the real one does, so the engine's stream wiring is what is under
 * test rather than the SDK's.
 */
function fakeUpload(body: Readable) {
  let aborted = false;
  const done = new Promise<void>((resolve, reject) => {
    body.on("data", () => {
      /* drain */
    });
    body.on("end", () => resolve());
    // A destroyed body is how a cancelled request reaches the SDK. Resolving
    // here is the harsher case for the engine: it must still fail the upload
    // off its own record of what went wrong, not off the SDK's verdict.
    body.on("close", () => resolve());
    body.on("error", reject);
  });

  return {
    handle: {
      done: () => done,
      abort: async () => {
        aborted = true;
      },
    },
    wasAborted: () => aborted,
  };
}

/** Resolves once the engine has called back, whichever way it went. */
function handleFile(
  engine: ReturnType<typeof createVideoUploadStorage>,
  request: { params?: Record<string, string> },
  file: { originalname: string; mimetype: string; stream: Readable },
) {
  return new Promise<{
    error: Error | null;
    info?: { objectKey: string; size: number };
  }>((resolve) => {
    engine._handleFile(request, file as never, (error, info) =>
      resolve({ error, info }),
    );
  });
}

describe("video upload storage engine", () => {
  let storage: {
    startUpload: ReturnType<typeof vi.fn>;
    removeObject: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.resetAllMocks();
    storage = { startUpload: vi.fn(), removeObject: vi.fn() };
  });

  const engineFor = () =>
    createVideoUploadStorage(storage as unknown as StorageService);

  it("streams the file to a campaign-scoped key and reports the byte count", async () => {
    let upload!: ReturnType<typeof fakeUpload>;
    storage.startUpload.mockImplementation((_key: string, body: Readable) => {
      upload = fakeUpload(body);
      return upload.handle;
    });

    const stream = new PassThrough();
    const engine = engineFor();
    const settled = handleFile(
      engine,
      { params: { campaignId: "cmp_1" } },
      { originalname: "final.mp4", mimetype: "video/mp4", stream },
    );

    stream.write(Buffer.alloc(1000));
    stream.write(Buffer.alloc(24));
    stream.end();

    const { error, info } = await settled;
    expect(error).toBeNull();
    // The size and digest in the row are measured off the wire, not taken
    // from the client. 1024 zero bytes have a well-known SHA-256.
    expect(info).toEqual({
      objectKey: expect.stringMatching(
        /^campaigns\/cmp_1\/[0-9a-f-]{36}\.mp4$/,
      ),
      sha256: "5f70bf18a086007016e948b04aed3b82103a36bea41755b6cddfaf10ace3c6ef",
      size: 1024,
    });
    expect(storage.startUpload).toHaveBeenCalledWith(
      info!.objectKey,
      expect.anything(),
      "video/mp4",
    );
    expect(upload.wasAborted()).toBe(false);
    expect(storage.removeObject).not.toHaveBeenCalled();
  });

  it("aborts the upload and cleans up when multer trips the size limit", async () => {
    let upload!: ReturnType<typeof fakeUpload>;
    storage.startUpload.mockImplementation((_key: string, body: Readable) => {
      upload = fakeUpload(body);
      return upload.handle;
    });
    storage.removeObject.mockResolvedValue(undefined);

    const stream = new PassThrough();
    const settled = handleFile(
      engineFor(),
      { params: { campaignId: "cmp_1" } },
      { originalname: "huge.mp4", mimetype: "video/mp4", stream },
    );

    stream.write(Buffer.alloc(64));
    // What multer does at limits.fileSize: signal, then truncate.
    stream.emit("limit");
    stream.end();

    const { error, info } = await settled;
    expect(info).toBeUndefined();
    expect(error?.message).toMatch(/larger than the 2 GB limit/i);
    // Both halves matter: the multipart upload must not be left dangling, and
    // a half file must not survive as a playable submission.
    expect(upload.wasAborted()).toBe(true);
    expect(storage.removeObject).toHaveBeenCalledTimes(1);
  });

  it("fails the upload when the request dies mid-stream", async () => {
    let upload!: ReturnType<typeof fakeUpload>;
    storage.startUpload.mockImplementation((_key: string, body: Readable) => {
      upload = fakeUpload(body);
      return upload.handle;
    });
    storage.removeObject.mockResolvedValue(undefined);

    const stream = new PassThrough();
    const settled = handleFile(
      engineFor(),
      { params: { campaignId: "cmp_1" } },
      { originalname: "final.mp4", mimetype: "video/mp4", stream },
    );

    stream.write(Buffer.alloc(64));
    stream.destroy(new Error("aborted by the browser"));

    const { error, info } = await settled;
    expect(info).toBeUndefined();
    expect(error?.message).toBe("aborted by the browser");
    expect(upload.wasAborted()).toBe(true);
  });

  it("answers instead of hanging when storage is not configured", async () => {
    // multer parks on this callback with no timeout of its own, so an error
    // that escaped the engine would hang the request rather than fail it.
    storage.startUpload.mockImplementation(() => {
      throw new Error("Video storage is not configured. Missing: BUCKET_NAME");
    });

    const stream = new PassThrough();
    const { error, info } = await handleFile(
      engineFor(),
      { params: { campaignId: "cmp_1" } },
      { originalname: "final.mp4", mimetype: "video/mp4", stream },
    );

    expect(info).toBeUndefined();
    expect(error?.message).toMatch(/not configured/i);
  });

  it("refuses to store anything when the route has no campaign id", async () => {
    const stream = new PassThrough();
    const { error } = await handleFile(
      engineFor(),
      {},
      { originalname: "final.mp4", mimetype: "video/mp4", stream },
    );

    expect(error?.message).toMatch(/campaign id/i);
    expect(storage.startUpload).not.toHaveBeenCalled();
  });

  it("bounds the non-file half of the multipart body", () => {
    // multer sets no limits of its own and busboy defaults them to Infinity,
    // so without `fields: 0` any caller can stream text parts that multer
    // accumulates in req.body until the process runs out of heap. The browser
    // sends exactly one part, so nothing legitimate needs the allowance.
    const { limits } = videoUploadMulterOptions(
      storage as unknown as StorageService,
    );

    expect(limits).toMatchObject({ files: 1, fields: 0, parts: 2 });
  });

  it("deletes the object when multer cleans up a stored file", async () => {
    storage.removeObject.mockResolvedValue(undefined);
    const engine = engineFor();

    await new Promise<void>((resolve) => {
      engine._removeFile(
        {},
        { objectKey: "campaigns/cmp_1/abc.mp4" } as never,
        () => resolve(),
      );
    });

    expect(storage.removeObject).toHaveBeenCalledWith(
      "campaigns/cmp_1/abc.mp4",
    );
  });
});
