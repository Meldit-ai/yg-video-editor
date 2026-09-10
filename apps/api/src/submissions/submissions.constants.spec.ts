import { describe, expect, it } from "vitest";
import {
  buildObjectKey,
  displayFileName,
  extensionOf,
  isAcceptedVideo,
  resolveContentType,
} from "./submissions.constants.js";

describe("isAcceptedVideo", () => {
  it("accepts anything the browser typed as video/*", () => {
    expect(isAcceptedVideo("video/mp4", "cut.mp4")).toBe(true);
    expect(isAcceptedVideo("VIDEO/QUICKTIME", "cut.mov")).toBe(true);
    // A container we do not list is still a video if the browser says so.
    expect(isAcceptedVideo("video/ogg", "cut.ogv")).toBe(true);
  });

  it("accepts a known container the browser could not type", () => {
    // Safari and Windows both hand .mkv over untyped; rejecting it would be a
    // dead end for the editor, who cannot change what their browser sends.
    expect(isAcceptedVideo("application/octet-stream", "cut.mkv")).toBe(true);
    expect(isAcceptedVideo("", "cut.MOV")).toBe(true);
  });

  it("rejects an untyped upload with an unknown extension", () => {
    expect(isAcceptedVideo("application/octet-stream", "notes.pdf")).toBe(
      false,
    );
    expect(isAcceptedVideo("", "archive")).toBe(false);
  });

  it("rejects a non-video MIME whatever the name says", () => {
    // The extension is the weaker signal, so it never overrules a MIME type
    // the browser was sure about.
    expect(isAcceptedVideo("application/zip", "cut.mp4")).toBe(false);
    expect(isAcceptedVideo("image/png", "cut.mov")).toBe(false);
  });
});

describe("resolveContentType", () => {
  it("keeps what the browser said when it said something", () => {
    expect(resolveContentType("video/quicktime", "cut.mov")).toBe(
      "video/quicktime",
    );
    expect(resolveContentType("VIDEO/MP4", "cut.mp4")).toBe("video/mp4");
  });

  it("names the container when the browser could not", () => {
    // Stored as octet-stream, a submitted video comes back as a download
    // prompt instead of playing — so an untyped upload is typed here.
    expect(resolveContentType("application/octet-stream", "cut.mkv")).toBe(
      "video/x-matroska",
    );
    expect(resolveContentType("", "cut.MOV")).toBe("video/quicktime");
  });
});

describe("extensionOf", () => {
  it("lower-cases and drops the dot", () => {
    expect(extensionOf("Final Cut.MP4")).toBe("mp4");
  });

  it("is empty when there is no extension to speak of", () => {
    expect(extensionOf("finalcut")).toBe("");
    expect(extensionOf("archive.superlongextension")).toBe("");
    expect(extensionOf("trailing.")).toBe("");
  });
});

describe("buildObjectKey", () => {
  it("namespaces by campaign and keeps the extension", () => {
    expect(buildObjectKey("cmp_1", "final cut.mp4")).toMatch(
      /^campaigns\/cmp_1\/[0-9a-f-]{36}\.mp4$/,
    );
  });

  it("never puts the uploader's file name in the key", () => {
    const key = buildObjectKey("cmp_1", "../../etc/passwd.mp4");
    expect(key).toMatch(/^campaigns\/cmp_1\/[0-9a-f-]{36}\.mp4$/);
    expect(key).not.toContain("passwd");
    expect(key).not.toContain("..");
  });

  it("is unique per call, so two identical names cannot collide", () => {
    expect(buildObjectKey("cmp_1", "final.mp4")).not.toBe(
      buildObjectKey("cmp_1", "final.mp4"),
    );
  });
});

describe("displayFileName", () => {
  it("keeps the last path segment only", () => {
    expect(displayFileName("C:\\Users\\asha\\final cut.mp4")).toBe(
      "final cut.mp4",
    );
    expect(displayFileName("/tmp/final.mp4")).toBe("final.mp4");
  });

  it("strips control characters and caps the length", () => {
    expect(displayFileName("fi\u0000le\u001f.mp4")).toBe("file.mp4");
    expect(displayFileName(`${"a".repeat(300)}.mp4`)).toHaveLength(180);
  });

  it("falls back rather than storing an empty name", () => {
    expect(displayFileName("   ")).toBe("video");
  });
});
