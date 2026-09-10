import { BadRequestException, Logger } from "@nestjs/common";
import { ComparisonStatus, ComparisonVerdict } from "@repo/database";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../prisma/prisma.service.js";
import type { StorageService } from "../storage/storage.service.js";
import type { ComparisonEngineClient } from "./comparison-engine.client.js";
import type { EngineResult } from "./comparison-engine.types.js";
import {
  ComparisonsService,
  buildGroups,
  pairKeyOf,
  planBatches,
  resolveResult,
} from "./comparisons.service.js";
import type { ComparisonPairDto } from "./comparisons.types.js";

/* ------------------------------------------------------ pure helpers */

const A_URL = "https://meldit.fsn1.your-objectstorage.com/campaigns/c1/a.mp4";
const B_URL = "https://meldit.fsn1.your-objectstorage.com/campaigns/c1/b.mp4";
const C_URL = "https://meldit.fsn1.your-objectstorage.com/campaigns/c1/c.mp4";

const ENTRIES = [
  { submissionId: "sub_a", url: A_URL },
  { submissionId: "sub_b", url: B_URL },
  { submissionId: "sub_c", url: C_URL },
];

function engineVideo(key: string, url: string, ready = true) {
  return { key, url, ready, durationSeconds: 28.8 };
}

function enginePair(
  aKey: string,
  bKey: string,
  score: number,
  verdict: ComparisonVerdict,
) {
  return { aKey, bKey, score, verdict, containment: 0, evidence: null };
}

function pairDto(
  aSubmissionId: string,
  bSubmissionId: string,
  score: number,
  verdict: ComparisonVerdict,
): ComparisonPairDto {
  return {
    id: `${aSubmissionId}-${bSubmissionId}`,
    aSubmissionId,
    bSubmissionId,
    score,
    verdict,
    containment: 0,
    evidence: null,
  };
}

describe("resolveResult", () => {
  it("walks key -> url -> submission for every pair", () => {
    const result: EngineResult = {
      engineVersion: "0.6.0",
      videos: [engineVideo("http:aaa", A_URL), engineVideo("http:bbb", B_URL)],
      pairs: [
        enginePair("http:aaa", "http:bbb", 97.4, ComparisonVerdict.MATCH),
      ],
    };

    const resolved = resolveResult(ENTRIES, result);

    expect(resolved.videos).toEqual([
      {
        submissionId: "sub_a",
        engineKey: "http:aaa",
        ready: true,
        durationSeconds: 28.8,
      },
      {
        submissionId: "sub_b",
        engineKey: "http:bbb",
        ready: true,
        durationSeconds: 28.8,
      },
    ]);
    expect(resolved.pairs).toEqual([
      {
        aSubmissionId: "sub_a",
        bSubmissionId: "sub_b",
        // The unordered identity, so the same two videos reported by a
        // sibling batch in the opposite order collide instead of duplicating.
        pairKey: "sub_a|sub_b",
        score: 97.4,
        verdict: ComparisonVerdict.MATCH,
        containment: 0,
      },
    ]);
  });

  it("keeps a video the engine could not prepare, with ready false", () => {
    // It contributed to no pair, and the UI has to be able to say so rather
    // than presenting it as "checked, no duplicates".
    const resolved = resolveResult(ENTRIES, {
      engineVersion: null,
      videos: [
        engineVideo("http:aaa", A_URL),
        engineVideo("http:bbb", B_URL, false),
      ],
      pairs: [],
    });

    expect(resolved.videos.map((video) => video.ready)).toEqual([true, false]);
    expect(resolved.pairs).toHaveLength(0);
  });

  it("promotes a video that turned up in a pair, whatever its status said", () => {
    // Being compared is proof of having been fingerprinted. This is the guard
    // that stops an unfamiliar status string from reporting a video that
    // demonstrably took part as one that could not be read.
    const resolved = resolveResult(ENTRIES, {
      engineVersion: null,
      videos: [
        engineVideo("http:aaa", A_URL, false),
        engineVideo("http:bbb", B_URL, false),
        engineVideo("http:ccc", C_URL, false),
      ],
      pairs: [enginePair("http:aaa", "http:bbb", 100, ComparisonVerdict.MATCH)],
    });

    expect(
      resolved.videos.map((video) => [video.submissionId, video.ready]),
    ).toEqual([
      ["sub_a", true],
      ["sub_b", true],
      // In no pair, and the engine never fingerprinted it — still not ready.
      ["sub_c", false],
    ]);
  });

  it("drops a pair whose keys no video declared", () => {
    const resolved = resolveResult(ENTRIES, {
      engineVersion: null,
      videos: [engineVideo("http:aaa", A_URL)],
      pairs: [
        enginePair("http:aaa", "http:ghost", 91, ComparisonVerdict.MATCH),
      ],
    });

    expect(resolved.pairs).toHaveLength(0);
  });

  it("ignores a video at a URL we never submitted", () => {
    const resolved = resolveResult(ENTRIES, {
      engineVersion: null,
      videos: [engineVideo("http:zzz", "https://elsewhere.example/x.mp4")],
      pairs: [],
    });

    expect(resolved.videos).toHaveLength(0);
  });

  it("keeps only one row for a pair the engine reported both ways round", () => {
    const resolved = resolveResult(ENTRIES, {
      engineVersion: null,
      videos: [engineVideo("http:aaa", A_URL), engineVideo("http:bbb", B_URL)],
      pairs: [
        enginePair("http:aaa", "http:bbb", 97.4, ComparisonVerdict.MATCH),
        enginePair("http:bbb", "http:aaa", 97.4, ComparisonVerdict.MATCH),
      ],
    });

    expect(resolved.pairs).toHaveLength(1);
    // The first one wins, so `evidence`'s a/b sides still describe a and b.
    expect(resolved.pairs[0]?.aSubmissionId).toBe("sub_a");
  });

  it("drops a video compared with itself", () => {
    const resolved = resolveResult(ENTRIES, {
      engineVersion: null,
      videos: [engineVideo("http:aaa", A_URL)],
      pairs: [enginePair("http:aaa", "http:aaa", 100, ComparisonVerdict.MATCH)],
    });

    expect(resolved.pairs).toHaveLength(0);
  });

  it("keeps the evidence block when there is one, and omits it otherwise", () => {
    const withEvidence = {
      ...enginePair("http:aaa", "http:bbb", 97, ComparisonVerdict.MATCH),
      evidence: { tiers: { winning_tier: "sscd" } },
    };
    const resolved = resolveResult(ENTRIES, {
      engineVersion: null,
      videos: [engineVideo("http:aaa", A_URL), engineVideo("http:bbb", B_URL)],
      pairs: [withEvidence],
    });

    expect(resolved.pairs[0]?.evidence).toEqual({
      tiers: { winning_tier: "sscd" },
    });
    // A null evidence block is left off entirely — see the comment there.
    const bare = resolveResult(ENTRIES, {
      engineVersion: null,
      videos: [engineVideo("http:aaa", A_URL), engineVideo("http:bbb", B_URL)],
      pairs: [enginePair("http:aaa", "http:bbb", 97, ComparisonVerdict.MATCH)],
    });
    expect("evidence" in (bare.pairs[0] ?? {})).toBe(false);
  });
});

describe("planBatches", () => {
  it("sends everything in one call when it fits", () => {
    expect(planBatches(["a", "b", "c"], 4)).toEqual([["a", "b", "c"]]);
    expect(planBatches(["a", "b", "c", "d"], 4)).toEqual([
      ["a", "b", "c", "d"],
    ]);
  });

  it("never exceeds the cap, and covers every pair", () => {
    // The property that matters: whatever the split, no pair of videos is
    // left uncompared. Naive chunking fails this at the first boundary.
    for (const total of [5, 6, 7, 8, 9, 12, 20]) {
      for (const cap of [4, 6]) {
        const ids = Array.from({ length: total }, (_, i) => `sub_${i}`);
        const batches = planBatches(ids, cap);

        const covered = new Set<string>();
        for (const batch of batches) {
          expect(batch.length).toBeLessThanOrEqual(cap);
          for (let i = 0; i < batch.length; i += 1) {
            for (let j = i + 1; j < batch.length; j += 1) {
              covered.add(pairKeyOf(batch[i]!, batch[j]!));
            }
          }
        }

        expect(covered.size).toBe((total * (total - 1)) / 2);
      }
    }
  });
});

describe("pairKeyOf", () => {
  it("is the same key whichever order the engine reported the two in", () => {
    expect(pairKeyOf("sub_b", "sub_a")).toBe(pairKeyOf("sub_a", "sub_b"));
  });
});

describe("buildGroups", () => {
  it("finds nothing when every pair is unrelated", () => {
    expect(
      buildGroups([pairDto("sub_a", "sub_b", 1, ComparisonVerdict.NO_MATCH)]),
    ).toEqual([]);
  });

  it("clusters transitively, the way the engine does", () => {
    // a-b and b-c are strong, a-c was never compared as a match. All three
    // are one cut circulating in three edits.
    const groups = buildGroups([
      pairDto("sub_a", "sub_b", 96, ComparisonVerdict.MATCH),
      pairDto("sub_b", "sub_c", 71, ComparisonVerdict.LIKELY_MATCH),
      pairDto("sub_a", "sub_c", 4, ComparisonVerdict.NO_MATCH),
    ]);

    expect(groups).toHaveLength(1);
    expect([...groups[0]!.submissionIds].sort()).toEqual([
      "sub_a",
      "sub_b",
      "sub_c",
    ]);
    // The weakest edge holding the group together, and the strongest.
    expect(groups[0]?.minScore).toBe(71);
    expect(groups[0]?.maxScore).toBe(96);
  });

  it("keeps unrelated clusters apart", () => {
    const groups = buildGroups([
      pairDto("sub_a", "sub_b", 96, ComparisonVerdict.MATCH),
      pairDto("sub_c", "sub_d", 40, ComparisonVerdict.UNCERTAIN),
      pairDto("sub_a", "sub_c", 2, ComparisonVerdict.NO_MATCH),
    ]);

    expect(groups).toHaveLength(2);
    // Same size, so the more certain one leads.
    expect(groups[0]?.submissionIds).toContain("sub_a");
    expect(groups[1]?.submissionIds).toContain("sub_c");
  });

  it("puts the biggest cluster first", () => {
    const groups = buildGroups([
      pairDto("sub_x", "sub_y", 99, ComparisonVerdict.MATCH),
      pairDto("sub_a", "sub_b", 62, ComparisonVerdict.LIKELY_MATCH),
      pairDto("sub_b", "sub_c", 64, ComparisonVerdict.LIKELY_MATCH),
    ]);

    expect(groups[0]?.submissionIds).toHaveLength(3);
    expect(groups[1]?.submissionIds).toHaveLength(2);
  });
});

/* ------------------------------------------------------------ the service */

const submissionDelegate = { findMany: vi.fn() };
const comparisonDelegate = {
  create: vi.fn(),
  updateMany: vi.fn(),
  findMany: vi.fn(),
  findFirst: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
};
const entryDelegate = { updateMany: vi.fn() };
const pairDelegate = {
  deleteMany: vi.fn(),
  createMany: vi.fn(),
  findMany: vi.fn(),
};
const jobDelegate = {
  findMany: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
};

const client = {
  videoSubmission: submissionDelegate,
  videoComparison: comparisonDelegate,
  videoComparisonEntry: entryDelegate,
  videoComparisonPair: pairDelegate,
  videoComparisonJob: jobDelegate,
  // Runs the callback against the same delegates — enough to assert what a
  // transaction would have written, without a database.
  $transaction: <T>(work: (tx: unknown) => Promise<T>): Promise<T> =>
    work(client),
};

const prisma = { client } as unknown as PrismaService;

const storageMock = {
  publicObjectUrl: vi.fn((key: string) => `https://bucket.example/${key}`),
};
const storage = storageMock as unknown as StorageService;

const engineMock = { submit: vi.fn(), fetchJob: vi.fn() };
const engine = engineMock as unknown as ComparisonEngineClient;

function comparisonRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "cmpr_1",
    campaignId: "cmp_1",
    jobs: [],
    status: ComparisonStatus.QUEUED,
    triggerSubmissionId: null,
    stage: null,
    pairsDone: 0,
    pairsTotal: 1,
    videoCount: 2,
    flaggedPairCount: 0,
    engineVersion: null,
    errorMessage: null,
    completedAt: null,
    active: true,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    updatedAt: new Date("2026-09-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("ComparisonsService.runForCampaign", () => {
  let service: ComparisonsService;

  beforeEach(() => {
    vi.resetAllMocks();
    storageMock.publicObjectUrl.mockImplementation(
      (key: string) => `https://bucket.example/${key}`,
    );
    comparisonDelegate.create.mockResolvedValue(comparisonRow());
    jobDelegate.findMany.mockResolvedValue([]);
    comparisonDelegate.updateMany.mockResolvedValue({ count: 0 });
    service = new ComparisonsService(prisma, storage, engine);
  });

  afterEach(() => {
    // A started run leaves a poller sleeping; this is the shutdown hook that
    // stops it, and without it the suite would hold a timer open.
    service.onModuleDestroy();
  });

  it("refuses a campaign with nothing to compare against", async () => {
    submissionDelegate.findMany.mockResolvedValue([
      { id: "sub_a", objectKey: "campaigns/cmp_1/a.mp4" },
    ]);

    await expect(service.runForCampaign("cmp_1")).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(engineMock.submit).not.toHaveBeenCalled();
  });

  it("submits every active video on the campaign, as plain object URLs", async () => {
    submissionDelegate.findMany.mockResolvedValue([
      { id: "sub_a", objectKey: "campaigns/cmp_1/a.mp4" },
      { id: "sub_b", objectKey: "campaigns/cmp_1/b.mp4" },
      { id: "sub_c", objectKey: "campaigns/cmp_1/c.mp4" },
    ]);
    engineMock.submit.mockResolvedValue("job_1");

    await service.runForCampaign("cmp_1", "sub_c");

    // Every video, not just the new one — the engine fans out to all pairs.
    // Three fits inside one call, so there is exactly one request.
    expect(engineMock.submit).toHaveBeenCalledTimes(1);
    expect(engineMock.submit).toHaveBeenCalledWith([
      "https://bucket.example/campaigns/cmp_1/a.mp4",
      "https://bucket.example/campaigns/cmp_1/b.mp4",
      "https://bucket.example/campaigns/cmp_1/c.mp4",
    ]);
    expect(submissionDelegate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { campaignId: "cmp_1", active: true },
      }),
    );
  });

  it("splits a campaign past the engine's URL cap into covering batches", async () => {
    // Five videos, four URLs per call: one request would be a 422, and naive
    // chunking would stop comparing videos that landed in different chunks.
    submissionDelegate.findMany.mockResolvedValue(
      ["a", "b", "c", "d", "e"].map((key) => ({
        id: `sub_${key}`,
        objectKey: `campaigns/cmp_1/${key}.mp4`,
      })),
    );
    engineMock.submit.mockResolvedValue("job_1");

    await service.runForCampaign("cmp_1");

    const requests = engineMock.submit.mock.calls.map(
      (call) => call[0] as string[],
    );
    expect(requests).toHaveLength(3);
    for (const urls of requests) expect(urls.length).toBeLessThanOrEqual(4);

    // The point of the split: every pair still travels together somewhere.
    const covered = new Set<string>();
    for (const urls of requests) {
      for (let i = 0; i < urls.length; i += 1) {
        for (let j = i + 1; j < urls.length; j += 1) {
          covered.add(pairKeyOf(urls[i]!, urls[j]!));
        }
      }
    }
    expect(covered.size).toBe(10); // C(5,2)
  });

  it("still records one run, with the campaign's own pair count", async () => {
    submissionDelegate.findMany.mockResolvedValue(
      ["a", "b", "c", "d", "e"].map((key) => ({
        id: `sub_${key}`,
        objectKey: `campaigns/cmp_1/${key}.mp4`,
      })),
    );
    engineMock.submit.mockResolvedValue("job_1");

    await service.runForCampaign("cmp_1");

    expect(comparisonDelegate.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          videoCount: 5,
          // C(5,2), not the sum over the three overlapping batches — a pair
          // counted twice would leave the progress bar short of full.
          pairsTotal: 10,
        }),
      }),
    );
  });

  it("records the run with the pair count it expects", async () => {
    submissionDelegate.findMany.mockResolvedValue([
      { id: "sub_a", objectKey: "campaigns/cmp_1/a.mp4" },
      { id: "sub_b", objectKey: "campaigns/cmp_1/b.mp4" },
      { id: "sub_c", objectKey: "campaigns/cmp_1/c.mp4" },
      { id: "sub_d", objectKey: "campaigns/cmp_1/d.mp4" },
    ]);
    engineMock.submit.mockResolvedValue("job_1");

    await service.runForCampaign("cmp_1", "sub_d");

    expect(comparisonDelegate.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          campaignId: "cmp_1",
          triggerSubmissionId: "sub_d",
          status: ComparisonStatus.QUEUED,
          videoCount: 4,
          // 4 videos, every combination of two.
          pairsTotal: 6,
          // One engine call, recorded with the videos it covers.
          jobs: {
            create: [
              {
                jobId: "job_1",
                submissionIds: ["sub_a", "sub_b", "sub_c", "sub_d"],
              },
            ],
          },
        }),
      }),
    );
  });

  it("supersedes a run still in flight, so only the newest one is read", async () => {
    submissionDelegate.findMany.mockResolvedValue([
      { id: "sub_a", objectKey: "campaigns/cmp_1/a.mp4" },
      { id: "sub_b", objectKey: "campaigns/cmp_1/b.mp4" },
    ]);
    engineMock.submit.mockResolvedValue("job_2");

    await service.runForCampaign("cmp_1");

    expect(comparisonDelegate.updateMany).toHaveBeenCalledWith({
      where: {
        campaignId: "cmp_1",
        active: true,
        status: {
          in: [ComparisonStatus.QUEUED, ComparisonStatus.RUNNING],
        },
      },
      data: expect.objectContaining({ status: ComparisonStatus.SUPERSEDED }),
    });
  });

  it("records a failed run when the engine cannot be reached", async () => {
    const error = vi.spyOn(Logger.prototype, "error").mockImplementation(() => {});
    submissionDelegate.findMany.mockResolvedValue([
      { id: "sub_a", objectKey: "campaigns/cmp_1/a.mp4" },
      { id: "sub_b", objectKey: "campaigns/cmp_1/b.mp4" },
    ]);
    engineMock.submit.mockRejectedValue(
      new Error("could not reach the comparison engine at http://127.0.0.1:8080"),
    );
    comparisonDelegate.create.mockResolvedValue(
      comparisonRow({
        status: ComparisonStatus.FAILED,
        errorMessage: "could not reach the comparison engine",
      }),
    );

    const run = await service.runForCampaign("cmp_1");

    // Written, not just logged: "the check could not start" is the answer the
    // campaign page has to show. Silence would read as "no duplicates".
    expect(run.status).toBe(ComparisonStatus.FAILED);
    expect(comparisonDelegate.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: ComparisonStatus.FAILED,
          errorMessage: expect.stringContaining("could not reach"),
        }),
      }),
    );
    // A failed submit must not take a healthy running job down with it.
    expect(comparisonDelegate.updateMany).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("never lets a comparison failure surface on the upload path", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
    submissionDelegate.findMany.mockRejectedValue(new Error("database is down"));

    // Synchronous by design — the upload response does not wait for this.
    expect(() => service.triggerAfterUpload("cmp_1", "sub_a")).not.toThrow();
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    warn.mockRestore();
  });
});
