import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { describe, expect, it } from "vitest";
import { measureStream } from "./measure-stream.js";

async function drain(stream: Readable): Promise<void> {
  for await (const _chunk of stream) {
    // consume
  }
}

describe("measureStream", () => {
  it("passes every byte through unchanged while counting and hashing them", async () => {
    const chunks = [Buffer.from("hello "), Buffer.from("video "), Buffer.from("bytes")];
    const { stream, result } = measureStream();
    const seen: Buffer[] = [];
    const sink = new (await import("node:stream")).Writable({
      write(chunk: Buffer, _enc, done) {
        seen.push(Buffer.from(chunk));
        done();
      },
    });

    await pipeline(Readable.from(chunks), stream, sink);

    expect(Buffer.concat(seen).toString()).toBe("hello video bytes");
    expect(result()).toEqual({
      sizeBytes: 17,
      sha256: createHash("sha256").update("hello video bytes").digest("hex"),
    });
  });

  it("reports zero bytes and the empty digest for an empty stream", async () => {
    const { stream, result } = measureStream();
    await drain(Readable.from([]).pipe(stream));
    expect(result()).toEqual({
      sizeBytes: 0,
      sha256: createHash("sha256").digest("hex"),
    });
  });
});
