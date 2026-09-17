import { afterEach, describe, expect, it, vi } from "vitest";
import { headMedia, headMediaAll } from "./media-head.js";

function headResponse(headers: Record<string, string>, status = 200): Response {
  return new Response(null, { status, headers });
}

describe("headMedia", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reads the size and ETag from a HEAD, without downloading anything", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      headResponse({ "content-length": "8399332", etag: '"4204a071916a451e5798ef7620d14705"' }),
    );

    await expect(headMedia("https://fsn1.your-objectstorage.com/meldit/x.mp4")).resolves.toEqual({
      sizeBytes: 8399332,
      etag: '"4204a071916a451e5798ef7620d14705"',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://fsn1.your-objectstorage.com/meldit/x.mp4",
      expect.objectContaining({ method: "HEAD" }),
    );
  });

  it("answers nulls, never throws, when the object cannot be reached", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNRESET"));
    await expect(headMedia("https://x/y.mp4")).resolves.toEqual({ sizeBytes: null, etag: null });
  });

  it("answers nulls on a non-2xx, and on a missing header", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(headResponse({}, 403))
      .mockResolvedValueOnce(headResponse({ etag: '"abc"' }));
    await expect(headMedia("https://x/y.mp4")).resolves.toEqual({ sizeBytes: null, etag: null });
    await expect(headMedia("https://x/y.mp4")).resolves.toEqual({ sizeBytes: null, etag: '"abc"' });
  });
});

describe("headMediaAll", () => {
  afterEach(() => vi.restoreAllMocks());

  it("heads every URL with bounded concurrency and keeps the input order", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      const n = String(input).slice(-1);
      return headResponse({ "content-length": n, etag: `"e${n}"` });
    });

    const urls = Array.from({ length: 10 }, (_, i) => `https://x/${i}`);
    const results = await headMediaAll(urls, 4);

    expect(results.map((r) => r.etag)).toEqual(urls.map((u) => `"e${u.slice(-1)}"`));
    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(maxInFlight).toBeGreaterThan(1);
  });
});
