import { describe, expect, it } from "vitest";
import { ownObjectKey } from "./object-key.js";

const ENDPOINT = "https://fsn1.your-objectstorage.com";
const BUCKET = "meldit";

describe("ownObjectKey", () => {
  it("recognises a reel already sitting in our bucket", () => {
    // The real shape: the tracker writes a campaign's reels into the same
    // bucket this app uploads to, so there is nothing to copy.
    expect(
      ownObjectKey(
        `${ENDPOINT}/${BUCKET}/instagram/1785215787636_03h92aekytqq.mp4`,
        ENDPOINT,
        BUCKET,
      ),
    ).toBe("instagram/1785215787636_03h92aekytqq.mp4");
  });

  it("tolerates a trailing slash on the configured endpoint", () => {
    expect(
      ownObjectKey(`${ENDPOINT}/${BUCKET}/a.mp4`, `${ENDPOINT}/`, BUCKET),
    ).toBe("a.mp4");
  });

  it("recognises the virtual-hosted style this app mints", () => {
    // publicObjectUrl builds `bucket.host/key`; the tracker writes
    // `host/bucket/key`. Both name the same object.
    expect(
      ownObjectKey(`https://${BUCKET}.fsn1.your-objectstorage.com/a.mp4`, ENDPOINT, BUCKET),
    ).toBe("a.mp4");
  });

  it("refuses a URL in someone else's bucket", () => {
    expect(
      ownObjectKey(`${ENDPOINT}/other-bucket/a.mp4`, ENDPOINT, BUCKET),
    ).toBeNull();
  });

  it("refuses a URL on another host", () => {
    expect(
      ownObjectKey(`https://cdn.instagram.com/${BUCKET}/a.mp4`, ENDPOINT, BUCKET),
    ).toBeNull();
  });

  it("refuses a presigned URL, whose access expires", () => {
    // Referencing one would store a key that stops resolving; the bytes have
    // to be ours outright, not ours for the next six hours.
    expect(
      ownObjectKey(`${ENDPOINT}/${BUCKET}/a.mp4?X-Amz-Signature=abc`, ENDPOINT, BUCKET),
    ).toBeNull();
  });

  it("refuses the bucket root, which names no object", () => {
    expect(ownObjectKey(`${ENDPOINT}/${BUCKET}/`, ENDPOINT, BUCKET)).toBeNull();
  });
});
