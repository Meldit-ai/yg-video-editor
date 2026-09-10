import { PayloadTooLargeException } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { MAX_VIDEO_BYTES } from "../submissions.constants.js";
import { UploadSizeGuard } from "./upload-size.guard.js";

const contextWith = (contentLength?: string): ExecutionContext =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({
        headers:
          contentLength === undefined
            ? {}
            : { "content-length": contentLength },
      }),
    }),
  }) as unknown as ExecutionContext;

describe("UploadSizeGuard", () => {
  const guard = new UploadSizeGuard();

  it("lets an upload within the limit through", () => {
    expect(guard.canActivate(contextWith("1048576"))).toBe(true);
    expect(guard.canActivate(contextWith(String(MAX_VIDEO_BYTES)))).toBe(true);
  });

  it("refuses one that says it is over the limit", () => {
    expect(() =>
      guard.canActivate(contextWith(String(MAX_VIDEO_BYTES * 2))),
    ).toThrow(PayloadTooLargeException);
  });

  it("allows for multipart framing rather than rejecting at exactly the cap", () => {
    // The body is the file plus boundaries and part headers, so a file at the
    // limit declares slightly more than the limit.
    expect(guard.canActivate(contextWith(String(MAX_VIDEO_BYTES + 4096)))).toBe(
      true,
    );
  });

  it("defers to multer when the length is missing or unparseable", () => {
    // Chunked uploads send no Content-Length. The real limit still applies —
    // this guard is only the fast path.
    expect(guard.canActivate(contextWith())).toBe(true);
    expect(guard.canActivate(contextWith("not-a-number"))).toBe(true);
  });
});
