import { Logger, ServiceUnavailableException } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TrackerService } from "./tracker.service.js";

/**
 * The service is constructed by hand and global fetch is stubbed, so these
 * tests need neither a Nest DI container nor the network.
 *
 * Time is driven through a Date.now() spy rather than fake timers: the cache
 * only ever reads the clock, and this keeps promise scheduling real.
 */

const CACHE_TTL_MS = 5 * 60 * 1000;

/** Minimal stand-in for the parts of Response the service touches. */
function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(payload),
  } as unknown as Response;
}

/** The upstream envelope, with whatever entries a test wants inside it. */
function feed(entries: unknown[]): unknown {
  return {
    statusCode: 200,
    message: "Active campaigns",
    success: true,
    data: entries,
  };
}

/** A promise a test resolves by hand, for exercising the in-flight sharing. */
function deferred(): {
  promise: Promise<Response>;
  resolve: (value: Response) => void;
} {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Silences an expected log line and hands back the spy to assert on. */
function silence(method: "warn" | "error") {
  return vi.spyOn(Logger.prototype, method).mockImplementation(() => {});
}

let service: TrackerService;
let fetchMock: ReturnType<typeof vi.fn>;
let now: number;
let warn: ReturnType<typeof silence>;

beforeEach(() => {
  now = 1_760_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  // Spied so the expected failure paths do not print during the run.
  warn = silence("warn");
  silence("error");

  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);

  service = new TrackerService();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("TrackerService.listCampaigns", () => {
  it("maps campaign_id/campaign_name and trims stray whitespace", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        feed([
          { campaign_id: "id-1", campaign_name: " Ikkis" },
          { campaign_id: "id-2", campaign_name: "AJIO ORM (internal) " },
        ]),
      ),
    );

    await expect(service.listCampaigns()).resolves.toEqual([
      { id: "id-1", name: "Ikkis" },
      { id: "id-2", name: "AJIO ORM (internal)" },
    ]);
  });

  it("keeps both entries when two campaigns share a name", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        feed([
          { campaign_id: "id-1", campaign_name: "Airbnb" },
          { campaign_id: "id-2", campaign_name: "Airbnb" },
        ]),
      ),
    );

    // The name is not a key; collapsing on it would silently lose a campaign.
    await expect(service.listCampaigns()).resolves.toHaveLength(2);
  });

  it("serves the cache instead of re-fetching inside the TTL", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(feed([{ campaign_id: "id-1", campaign_name: "Ikkis" }])),
    );

    const first = await service.listCampaigns();
    now += CACHE_TTL_MS - 1;
    const second = await service.listCampaigns();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it("re-fetches once the TTL has passed", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(feed([{ campaign_id: "id-1", campaign_name: "Ikkis" }])),
    );

    await service.listCampaigns();
    now += CACHE_TTL_MS + 1;
    await service.listCampaigns();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("collapses concurrent callers onto a single upstream request", async () => {
    const pending = deferred();
    fetchMock.mockReturnValue(pending.promise);

    const first = service.listCampaigns();
    const second = service.listCampaigns();
    const third = service.listCampaigns();

    pending.resolve(
      jsonResponse(feed([{ campaign_id: "id-1", campaign_name: "Ikkis" }])),
    );
    const results = await Promise.all([first, second, third]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results[0]).toEqual([{ id: "id-1", name: "Ikkis" }]);
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
  });

  it("drops malformed entries instead of failing the whole list", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        feed([
          null,
          "not-an-object",
          { campaign_name: "No id at all" },
          { campaign_id: 42, campaign_name: "Numeric id" },
          { campaign_id: "   ", campaign_name: "Blank id" },
          { campaign_id: "id-ok", campaign_name: "Good one" },
          // A nameless entry is still selectable — it falls back to its id.
          { campaign_id: "id-nameless" },
        ]),
      ),
    );

    await expect(service.listCampaigns()).resolves.toEqual([
      { id: "id-ok", name: "Good one" },
      { id: "id-nameless", name: "id-nameless" },
    ]);
  });

  it("throws ServiceUnavailable when the upstream fails with nothing cached", async () => {
    fetchMock.mockRejectedValue(new Error("socket hang up"));

    await expect(service.listCampaigns()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it("throws ServiceUnavailable on a non-2xx response", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 502));

    await expect(service.listCampaigns()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it("throws ServiceUnavailable when the payload has no data array", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true }));

    await expect(service.listCampaigns()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it("serves the stale cache when a later refresh fails", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(feed([{ campaign_id: "id-1", campaign_name: "Ikkis" }])),
    );
    const fresh = await service.listCampaigns();

    now += CACHE_TTL_MS + 1;
    fetchMock.mockRejectedValueOnce(new Error("tracker down"));

    // Old names beat an error for a briefing tool, so this must not throw.
    await expect(service.listCampaigns()).resolves.toEqual(fresh);
    expect(warn).toHaveBeenCalled();
  });

  it("recovers from a failed refresh once the upstream is back", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(feed([{ campaign_id: "id-1", campaign_name: "Ikkis" }])),
    );
    await service.listCampaigns();

    now += CACHE_TTL_MS + 1;
    fetchMock.mockRejectedValueOnce(new Error("tracker down"));
    await service.listCampaigns();

    // The failure must not have latched: the next call still tries upstream.
    now += CACHE_TTL_MS + 1;
    fetchMock.mockResolvedValueOnce(
      jsonResponse(feed([{ campaign_id: "id-2", campaign_name: "Airbnb" }])),
    );

    await expect(service.listCampaigns()).resolves.toEqual([
      { id: "id-2", name: "Airbnb" },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("TrackerService.resolveName", () => {
  beforeEach(() => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        feed([
          { campaign_id: "id-1", campaign_name: " Ikkis" },
          { campaign_id: "id-2", campaign_name: "Airbnb" },
        ]),
      ),
    );
  });

  it("returns the trimmed name for a known id", async () => {
    await expect(service.resolveName("id-1")).resolves.toBe("Ikkis");
  });

  it("returns null for an id the tracker does not know", async () => {
    await expect(service.resolveName("id-gone")).resolves.toBeNull();
  });

  it("reuses the cached list rather than fetching per lookup", async () => {
    await service.resolveName("id-1");
    await service.resolveName("id-2");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
