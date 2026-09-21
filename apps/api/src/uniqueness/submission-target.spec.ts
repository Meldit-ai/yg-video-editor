import { ComparisonStatus, Uniqueness } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../prisma/prisma.service.js";
import type { StorageService } from "../storage/storage.service.js";
import { SubmissionTarget } from "./submission-target.js";

const submission = {
  findMany: vi.fn(),
  count: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
};
const campaign = { findFirst: vi.fn() };
const comparison = { create: vi.fn(), update: vi.fn(), updateMany: vi.fn() };
const job = { create: vi.fn() };
const entry = { createMany: vi.fn(), updateMany: vi.fn() };
const pair = { createMany: vi.fn() };

const client = {
  videoSubmission: submission,
  campaign,
  videoComparison: comparison,
  videoComparisonJob: job,
  videoComparisonEntry: entry,
  videoComparisonPair: pair,
};
const prisma = { client } as unknown as PrismaService;
const storage = {
  publicObjectUrl: vi.fn((key: string) => `https://bucket/${key}`),
} as unknown as StorageService;

const T0 = new Date("2026-09-01T00:00:00Z");

describe("SubmissionTarget", () => {
  let target: SubmissionTarget;

  beforeEach(() => {
    vi.clearAllMocks();
    target = new SubmissionTarget(prisma, storage);
  });

  it("reads the campaign threshold, and null for a campaign that is gone", async () => {
    campaign.findFirst.mockResolvedValueOnce({ duplicationThreshold: 75 });
    await expect(target.loadThreshold("cmp_1")).resolves.toBe(75);
    expect(campaign.findFirst).toHaveBeenCalledWith({
      where: { id: "cmp_1", active: true },
      select: { duplicationThreshold: true },
    });

    campaign.findFirst.mockResolvedValueOnce(null);
    await expect(target.loadThreshold("cmp_1")).resolves.toBeNull();
  });

  it("loads pending rows — unlabelled and unchecked — oldest first, with their engine URLs and content identity", async () => {
    submission.findMany.mockResolvedValueOnce([
      { id: "s1", objectKey: "k1", createdAt: T0, contentSha256: "ab12" },
      { id: "s2", objectKey: "k2", createdAt: T0, contentSha256: null },
    ]);

    await expect(target.loadPending("cmp_1")).resolves.toEqual([
      { id: "s1", url: "https://bucket/k1", arrivedAt: T0, identity: "sha256:ab12" },
      { id: "s2", url: "https://bucket/k2", arrivedAt: T0, identity: undefined },
    ]);
    expect(submission.findMany).toHaveBeenCalledWith({
      where: {
        campaignId: "cmp_1",
        active: true,
        uniqueness: null,
        duplicationCheckedAt: null,
      },
      select: { id: true, objectKey: true, createdAt: true, contentSha256: true },
      orderBy: { createdAt: "asc" },
    });
  });

  it("loads the baseline: UNIQUE and PARTIAL rows only", async () => {
    submission.findMany.mockResolvedValueOnce([]);
    await target.loadBaseline("cmp_1");
    expect(submission.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          campaignId: "cmp_1",
          active: true,
          uniqueness: { in: [Uniqueness.UNIQUE, Uniqueness.PARTIAL] },
        },
        orderBy: { createdAt: "asc" },
      }),
    );
  });

  it("loads dependants: PARTIAL and DUPLICATE rows whose parent is the given video", async () => {
    submission.findMany.mockResolvedValueOnce([{ id: "s2" }, { id: "s4" }]);
    await expect(target.loadDependants("cmp_1", "s1")).resolves.toEqual([
      "s2",
      "s4",
    ]);
    expect(submission.findMany).toHaveBeenCalledWith({
      where: {
        campaignId: "cmp_1",
        active: true,
        topMatchSubmissionId: "s1",
        uniqueness: { in: [Uniqueness.PARTIAL, Uniqueness.DUPLICATE] },
      },
      select: { id: true },
      orderBy: { createdAt: "asc" },
    });
  });

  it("writes an outcome in one update, deriving overThreshold from the label", async () => {
    const checkedAt = new Date();
    await target.writeOutcome(
      "s2",
      {
        uniqueness: Uniqueness.DUPLICATE,
        matchValue: 96,
        averageValue: 96,
        parentId: "s1",
      },
      checkedAt,
    );
    expect(submission.update).toHaveBeenCalledWith({
      where: { id: "s2" },
      data: {
        uniqueness: Uniqueness.DUPLICATE,
        duplicationScore: 96,
        averageDuplicationScore: 96,
        topMatchSubmissionId: "s1",
        overThreshold: true,
        duplicationCheckedAt: checkedAt,
      },
    });
  });

  it("marks a video unreadable: checked, but with no label", async () => {
    const checkedAt = new Date();
    await target.markUnreadable("s2", checkedAt);
    expect(submission.update).toHaveBeenCalledWith({
      where: { id: "s2" },
      data: { uniqueness: null, duplicationCheckedAt: checkedAt },
    });
  });

  it("resets the given rows, or the whole campaign, back to pending", async () => {
    submission.updateMany.mockResolvedValue({ count: 2 });

    await expect(target.resetLabels("cmp_1", ["s2", "s4"])).resolves.toBe(2);
    expect(submission.updateMany).toHaveBeenLastCalledWith({
      where: { campaignId: "cmp_1", active: true, id: { in: ["s2", "s4"] } },
      data: {
        uniqueness: null,
        duplicationCheckedAt: null,
        overThreshold: false,
      },
    });

    await target.resetLabels("cmp_1");
    expect(submission.updateMany).toHaveBeenLastCalledWith({
      where: { campaignId: "cmp_1", active: true },
      data: {
        uniqueness: null,
        duplicationCheckedAt: null,
        overThreshold: false,
      },
    });
  });

  it("re-labels from stored values on the caller's transaction, in three bands", async () => {
    const tx = { videoSubmission: { updateMany: vi.fn() } };
    await target.relabelForThreshold(tx as never, "cmp_1", 40);

    const labelled = {
      campaignId: "cmp_1",
      active: true,
      uniqueness: { not: null },
    };
    expect(tx.videoSubmission.updateMany.mock.calls).toEqual([
      [
        {
          where: {
            ...labelled,
            topMatchSubmissionId: { not: null },
            duplicationScore: { gte: 40 },
          },
          data: { uniqueness: Uniqueness.DUPLICATE, overThreshold: true },
        },
      ],
      [
        {
          where: {
            ...labelled,
            topMatchSubmissionId: { not: null },
            duplicationScore: { gte: 25, lt: 40 },
          },
          data: { uniqueness: Uniqueness.PARTIAL, overThreshold: false },
        },
      ],
      [
        {
          where: {
            ...labelled,
            OR: [
              { topMatchSubmissionId: null },
              { duplicationScore: { lt: 25 } },
            ],
          },
          data: { uniqueness: Uniqueness.UNIQUE, overThreshold: false },
        },
      ],
    ]);
  });

  it("lets a threshold below the floor win: the PARTIAL band is empty and UNIQUE stops at the threshold", async () => {
    const tx = { videoSubmission: { updateMany: vi.fn() } };
    await target.relabelForThreshold(tx as never, "cmp_1", 20);

    const [, partial, unique] = tx.videoSubmission.updateMany.mock.calls;
    expect(partial![0].where.duplicationScore).toEqual({ gte: 20, lt: 20 });
    expect(unique![0].where.OR).toEqual([
      { topMatchSubmissionId: null },
      { duplicationScore: { lt: 20 } },
    ]);
  });

  it("opens a run as QUEUED, naming the trigger video", async () => {
    comparison.create.mockResolvedValueOnce({ id: "run_1" });
    await expect(
      target.openRun("cmp_1", {
        triggerId: "s3",
        threshold: 90,
        candidateCount: 1,
      }),
    ).resolves.toBe("run_1");
    expect(comparison.create).toHaveBeenCalledWith({
      data: {
        campaignId: "cmp_1",
        triggerSubmissionId: "s3",
        status: ComparisonStatus.QUEUED,
        videoCount: 1,
      },
      select: { id: true },
    });
  });

  it("records a call as a job, its entries, and the candidate's pairs only", async () => {
    const candidate = { id: "s4", url: "https://bucket/k4", arrivedAt: T0 };
    const slice = [
      { id: "s1", url: "https://bucket/k1", arrivedAt: T0 },
      { id: "s3", url: "https://bucket/k3", arrivedAt: T0 },
    ];
    await target.recordCall("run_1", {
      candidate,
      slice,
      jobId: "job-9",
      status: ComparisonStatus.SUCCEEDED,
      errorMessage: null,
      resolved: {
        videos: [
          { submissionId: "s4", engineKey: "k:4", ready: true, durationSeconds: 12 },
          { submissionId: "s1", engineKey: "k:1", ready: true, durationSeconds: 90 },
        ],
        pairs: [
          {
            aSubmissionId: "s1",
            bSubmissionId: "s4",
            pairKey: "s1|s4",
            score: 41,
            verdict: "UNCERTAIN",
            containment: 30,
          },
        ],
      },
    });

    expect(job.create).toHaveBeenCalledWith({
      data: {
        comparisonId: "run_1",
        jobId: "job-9",
        status: ComparisonStatus.SUCCEEDED,
        submissionIds: ["s4", "s1", "s3"],
        stage: "done",
        errorMessage: null,
        completedAt: expect.any(Date),
      },
    });
    expect(entry.createMany).toHaveBeenCalledWith({
      data: [
        { comparisonId: "run_1", submissionId: "s4", url: "https://bucket/k4" },
        { comparisonId: "run_1", submissionId: "s1", url: "https://bucket/k1" },
        { comparisonId: "run_1", submissionId: "s3", url: "https://bucket/k3" },
      ],
      skipDuplicates: true,
    });
    expect(entry.updateMany).toHaveBeenCalledTimes(2);
    expect(entry.updateMany).toHaveBeenCalledWith({
      where: { comparisonId: "run_1", submissionId: "s4" },
      data: { engineKey: "k:4", ready: true, durationSeconds: 12 },
    });
    expect(pair.createMany).toHaveBeenCalledWith({
      data: [
        {
          comparisonId: "run_1",
          aSubmissionId: "s1",
          bSubmissionId: "s4",
          pairKey: "s1|s4",
          score: 41,
          verdict: "UNCERTAIN",
          containment: 30,
        },
      ],
      skipDuplicates: true,
    });
  });

  it("records a call that produced nothing as a job row alone", async () => {
    await target.recordCall("run_1", {
      candidate: { id: "s4", url: "https://bucket/k4", arrivedAt: T0 },
      slice: [{ id: "s1", url: "https://bucket/k1", arrivedAt: T0 }],
      jobId: null,
      status: ComparisonStatus.FAILED,
      errorMessage: "could not reach the comparison engine",
      resolved: null,
    });
    expect(job.create).toHaveBeenCalledTimes(1);
    expect(entry.createMany).not.toHaveBeenCalled();
    expect(pair.createMany).not.toHaveBeenCalled();
  });

  it("mirrors progress onto the run and marks it RUNNING", async () => {
    await target.updateRun("run_1", {
      stage: "comparing",
      pairsDone: 2,
      pairsTotal: 5,
      videoCount: 4,
      matchCount: 1,
    });
    expect(comparison.update).toHaveBeenCalledWith({
      where: { id: "run_1" },
      data: {
        status: ComparisonStatus.RUNNING,
        stage: "comparing",
        pairsDone: 2,
        pairsTotal: 5,
        videoCount: 4,
      },
    });
  });

  it("closes a run with its outcome", async () => {
    await target.closeRun("run_1", {
      status: ComparisonStatus.PARTIAL,
      errorMessage: "1 video(s) could not be read by the engine.",
      engineVersion: "0.6.0",
      flaggedPairCount: 3,
    });
    expect(comparison.update).toHaveBeenCalledWith({
      where: { id: "run_1" },
      data: {
        status: ComparisonStatus.PARTIAL,
        stage: "done",
        errorMessage: "1 video(s) could not be read by the engine.",
        engineVersion: "0.6.0",
        flaggedPairCount: 3,
        completedAt: expect.any(Date),
      },
    });
  });

  it("fails every run a previous process left live", async () => {
    comparison.updateMany.mockResolvedValueOnce({ count: 2 });
    await expect(target.failLiveRuns("restarted")).resolves.toBe(2);
    expect(comparison.updateMany).toHaveBeenCalledWith({
      where: {
        active: true,
        status: { in: [ComparisonStatus.QUEUED, ComparisonStatus.RUNNING] },
      },
      data: {
        status: ComparisonStatus.FAILED,
        errorMessage: "restarted",
        completedAt: expect.any(Date),
      },
    });
  });

  it("lists the campaigns with pending rows, once each", async () => {
    submission.findMany.mockResolvedValueOnce([
      { campaignId: "cmp_1" },
      { campaignId: "cmp_2" },
    ]);
    await expect(target.campaignsWithPending()).resolves.toEqual([
      "cmp_1",
      "cmp_2",
    ]);
    expect(submission.findMany).toHaveBeenCalledWith({
      where: {
        active: true,
        uniqueness: null,
        duplicationCheckedAt: null,
        campaign: { active: true },
      },
      select: { campaignId: true },
      distinct: ["campaignId"],
    });
  });
});
