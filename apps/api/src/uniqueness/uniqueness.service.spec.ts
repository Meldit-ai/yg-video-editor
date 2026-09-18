import { Logger } from "@nestjs/common";
import { ComparisonStatus, Uniqueness, type Prisma } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComparisonEngineClient } from "../comparisons/comparison-engine.client.js";
import {
  verdictFromScore,
  type EngineJob,
} from "../comparisons/comparison-engine.types.js";
import { pairKeyOf } from "../comparisons/engine-result.js";
import { labelFor, type Candidate, type Outcome } from "./uniqueness.rules.js";
import { RESUME_INTERVAL_MS, UniquenessService } from "./uniqueness.service.js";
import type {
  CallRecord,
  RunClosing,
  RunOpening,
  RunProgress,
  UniquenessTarget,
} from "./uniqueness.types.js";

/* ------------------------------------------------------------ fake engine */

const urlOf = (id: string): string => `https://bucket/${id}`;
const idOf = (url: string): string => url.slice("https://bucket/".length);

/**
 * An engine scripted by pair values. Every pair among the URLs of a call is
 * scored — exactly what the real one does — so a test can see that pairs
 * among baseline videos are being ignored rather than never produced.
 */
class FakeEngine {
  readonly scores = new Map<string, { score: number; containment: number }>();
  readonly unreadable = new Set<string>();
  mode: "ok" | "unreachable" | "timeout" = "ok";
  /** Real calls, in submission order. Warm-ups are recorded separately. */
  readonly calls: string[][] = [];
  readonly warmups: string[][] = [];
  private inFlight = 0;
  maxInFlight = 0;
  /**
   * When set, calls do not finish until `release()` is called — so a test
   * can see what is in flight together, rather than trusting microtask order.
   */
  deferred = false;
  private readonly waiting: (() => void)[] = [];

  score(a: string, b: string, score: number, containment = 0): void {
    this.scores.set(pairKeyOf(a, b), { score, containment });
  }

  /** Finishes every deferred call that is in flight now. */
  release(): void {
    const waiting = this.waiting.splice(0);
    for (const resolve of waiting) resolve();
  }

  /** Every submission, real or warm-up, in the order the engine saw it. */
  readonly sequence: string[] = [];

  async warm(urls: string[]): Promise<void> {
    this.warmups.push([...urls]);
    this.sequence.push(`warm:${idOf(urls[0]!)}`);
    if (this.mode === "unreachable") return;
    await Promise.resolve();
  }

  async compare(
    urls: string[],
    options: { onSubmitted?: (jobId: string) => void } = {},
  ): Promise<{ jobId: string; job: EngineJob }> {
    this.calls.push([...urls]);
    this.sequence.push(`call:${idOf(urls[0]!)}`);
    if (this.mode === "unreachable") {
      throw new Error("could not reach the comparison engine at http://x");
    }
    options.onSubmitted?.(`job-${this.calls.length}`);
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    if (this.deferred) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      await Promise.resolve();
    }
    this.inFlight -= 1;

    if (this.mode === "timeout") {
      return {
        jobId: `job-${this.calls.length}`,
        job: {
          status: ComparisonStatus.TIMEOUT,
          stage: null,
          pairsDone: 0,
          pairsTotal: 0,
          errorMessage: "job exceeded its budget (job_timeout)",
          result: null,
        },
      };
    }

    const ids = urls.map(idOf);
    const videos = ids.map((id) => ({
      key: `k:${id}`,
      url: urlOf(id),
      ready: !this.unreadable.has(id),
      durationSeconds: 60,
    }));
    const pairs: NonNullable<EngineJob["result"]>["pairs"] = [];
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const a = ids[i]!;
        const b = ids[j]!;
        if (this.unreadable.has(a) || this.unreadable.has(b)) continue;
        const scored = this.scores.get(pairKeyOf(a, b)) ?? {
          score: 1,
          containment: 0,
        };
        pairs.push({
          aKey: `k:${a}`,
          bKey: `k:${b}`,
          score: scored.score,
          verdict: verdictFromScore(scored.score),
          containment: scored.containment,
          evidence: null,
        });
      }
    }
    const failed = ids.filter((id) => this.unreadable.has(id)).length;
    return {
      jobId: `job-${this.calls.length}`,
      job: {
        status:
          failed === 0
            ? ComparisonStatus.SUCCEEDED
            : ids.length - failed >= 2
              ? ComparisonStatus.PARTIAL
              : ComparisonStatus.FAILED,
        stage: "done",
        pairsDone: pairs.length,
        pairsTotal: pairs.length,
        errorMessage: null,
        result: { engineVersion: "0.6.0", videos, pairs },
      },
    };
  }
}

/* ------------------------------------------------------------ fake target */

interface Row extends Candidate {
  campaignId: string;
  active: boolean;
  uniqueness: Uniqueness | null;
  matchValue: number | null;
  averageValue: number | null;
  parentId: string | null;
  checkedAt: Date | null;
}

interface Run {
  id: string;
  campaignId: string;
  opening: RunOpening;
  calls: CallRecord[];
  progress: RunProgress | null;
  closing: RunClosing | null;
  /** Set by failLiveRuns. */
  failedOnBoot?: string;
}

class FakeTarget implements UniquenessTarget {
  readonly rows = new Map<string, Row>();
  readonly runs: Run[] = [];
  readonly thresholds = new Map<string, number>();
  relabelCalls: { campaignId: string; threshold: number }[] = [];

  constructor(readonly kind: "submission" | "reel") {}

  /** Adds a pending row. Arrival order follows insertion unless given. */
  add(campaignId: string, id: string, arrivedAt?: Date): Row {
    const row: Row = {
      id,
      campaignId,
      url: urlOf(id),
      arrivedAt: arrivedAt ?? new Date(2026, 8, 1 + this.rows.size),
      active: true,
      uniqueness: null,
      matchValue: null,
      averageValue: null,
      parentId: null,
      checkedAt: null,
    };
    this.rows.set(id, row);
    return row;
  }

  row(id: string): Row {
    const row = this.rows.get(id);
    if (row === undefined) throw new Error(`no row ${id}`);
    return row;
  }

  private active(campaignId: string): Row[] {
    return [...this.rows.values()]
      .filter((row) => row.campaignId === campaignId && row.active)
      .sort((a, b) => a.arrivedAt.getTime() - b.arrivedAt.getTime());
  }

  async loadThreshold(campaignId: string): Promise<number | null> {
    return this.thresholds.get(campaignId) ?? 90;
  }
  async loadPending(campaignId: string): Promise<Candidate[]> {
    return this.active(campaignId).filter(
      (row) => row.uniqueness === null && row.checkedAt === null,
    );
  }
  async loadBaseline(campaignId: string): Promise<Candidate[]> {
    return this.active(campaignId).filter(
      (row) =>
        row.uniqueness === Uniqueness.UNIQUE ||
        row.uniqueness === Uniqueness.PARTIAL,
    );
  }
  async loadDependants(campaignId: string, parentId: string): Promise<string[]> {
    return this.active(campaignId)
      .filter(
        (row) =>
          row.parentId === parentId &&
          (row.uniqueness === Uniqueness.PARTIAL ||
            row.uniqueness === Uniqueness.DUPLICATE),
      )
      .map((row) => row.id);
  }
  async countActive(campaignId: string): Promise<number> {
    return this.active(campaignId).length;
  }
  async writeOutcome(id: string, outcome: Outcome, checkedAt: Date) {
    Object.assign(this.row(id), {
      uniqueness: outcome.uniqueness,
      matchValue: outcome.matchValue,
      averageValue: outcome.averageValue,
      parentId: outcome.parentId,
      checkedAt,
    });
  }
  async markUnreadable(id: string, checkedAt: Date) {
    Object.assign(this.row(id), { uniqueness: null, checkedAt });
  }
  async resetLabels(campaignId: string, ids?: readonly string[]) {
    const targets = this.active(campaignId).filter(
      (row) => ids === undefined || ids.includes(row.id),
    );
    for (const row of targets) {
      Object.assign(row, { uniqueness: null, checkedAt: null });
    }
    return targets.length;
  }
  async relabelForThreshold(
    _tx: Prisma.TransactionClient,
    campaignId: string,
    threshold: number,
  ) {
    this.relabelCalls.push({ campaignId, threshold });
    for (const row of this.active(campaignId)) {
      if (row.uniqueness === null || row.matchValue === null) continue;
      row.uniqueness = labelFor(row.matchValue, threshold, row.parentId !== null);
    }
  }
  async openRun(campaignId: string, opening: RunOpening) {
    const run: Run = {
      id: `run-${this.runs.length + 1}`,
      campaignId,
      opening,
      calls: [],
      progress: null,
      closing: null,
    };
    this.runs.push(run);
    return run.id;
  }
  private run(runId: string): Run {
    const run = this.runs.find((candidate) => candidate.id === runId);
    if (run === undefined) throw new Error(`no run ${runId}`);
    return run;
  }
  async recordCall(runId: string, call: CallRecord) {
    this.run(runId).calls.push(call);
  }
  async updateRun(runId: string, progress: RunProgress) {
    this.run(runId).progress = progress;
  }
  async closeRun(runId: string, closing: RunClosing) {
    this.run(runId).closing = closing;
  }
  async failLiveRuns(reason: string) {
    const live = this.runs.filter((run) => run.closing === null);
    for (const run of live) run.failedOnBoot = reason;
    return live.length;
  }
  async campaignsWithPending() {
    const ids = new Set<string>();
    for (const row of this.rows.values()) {
      if (row.active && row.uniqueness === null && row.checkedAt === null) {
        ids.add(row.campaignId);
      }
    }
    return [...ids];
  }
}

/* -------------------------------------------------------------- scenarios */

const CAMPAIGN = "cmp_1";

describe("UniquenessService", () => {
  let engine: FakeEngine;
  let submissions: FakeTarget;
  let reels: FakeTarget;
  let service: UniquenessService;

  beforeEach(() => {
    engine = new FakeEngine();
    submissions = new FakeTarget("submission");
    reels = new FakeTarget("reel");
    service = new UniquenessService(
      engine as unknown as ComparisonEngineClient,
      submissions,
      reels,
    );
  });

  /** Lets every pending microtask and continuation run. */
  async function settle(): Promise<void> {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  }

  /** Releases deferred engine calls until the campaign's queue is idle. */
  async function drain(kind: "submission" | "reel" = "submission"): Promise<void> {
    let idle = false;
    void service.whenIdle(kind, CAMPAIGN).then(() => {
      idle = true;
    });
    while (!idle) {
      engine.release();
      await settle();
    }
  }

  /** Uploads one video and waits for the classifier to settle. */
  async function arrive(id: string): Promise<Row> {
    submissions.add(CAMPAIGN, id);
    service.onArrival("submission", CAMPAIGN);
    await service.whenIdle("submission", CAMPAIGN);
    return submissions.row(id);
  }

  /** The example from the design spec, §4, up to and including V7. */
  function scriptSpecExample(): void {
    engine.score("V1", "V2", 96);
    engine.score("V1", "V3", 3);
    engine.score("V1", "V4", 41);
    engine.score("V3", "V4", 2);
    engine.score("V1", "V5", 12);
    engine.score("V3", "V5", 4);
    engine.score("V4", "V5", 93);
    engine.score("V1", "V6", 8, 5);
    engine.score("V3", "V6", 31, 97);
    engine.score("V4", "V6", 2, 1);
    engine.score("V1", "V7", 9);
    engine.score("V3", "V7", 5);
    engine.score("V4", "V7", 3);
    // A copy of a copy looks like the original.
    engine.score("V2", "V4", 41);
    engine.score("V2", "V3", 3);
    engine.score("V2", "V7", 9);
  }

  describe("arrival", () => {
    it("labels the first video UNIQUE without asking the engine", async () => {
      const v1 = await arrive("V1");
      expect(v1).toMatchObject({
        uniqueness: Uniqueness.UNIQUE,
        matchValue: 0,
        parentId: null,
      });
      expect(engine.calls).toEqual([]);
    });

    it("still records a run for the first video, so the page sees activity", async () => {
      await arrive("V1");
      expect(submissions.runs).toHaveLength(1);
      expect(submissions.runs[0]).toMatchObject({
        opening: { triggerId: "V1" },
        closing: { status: ComparisonStatus.SUCCEEDED },
      });
    });

    it("compares a second video against the first and labels a copy DUPLICATE", async () => {
      scriptSpecExample();
      await arrive("V1");
      const v2 = await arrive("V2");
      expect(v2).toMatchObject({
        uniqueness: Uniqueness.DUPLICATE,
        matchValue: 96,
        parentId: "V1",
      });
      expect(engine.calls).toEqual([[urlOf("V2"), urlOf("V1")]]);
    });

    it("logs one line per labelled video, with the work it took", async () => {
      scriptSpecExample();
      const logSpy = vi.spyOn(Logger.prototype, "log");
      await arrive("V1");
      await arrive("V2");
      const lines = logSpy.mock.calls.map((call) => String(call[0]));
      expect(lines).toContainEqual(
        expect.stringMatching(/^Labelled submission V2 DUPLICATE \(96\) against 1 baseline in 1 call\(s\), \d+ ms$/),
      );
      logSpy.mockRestore();
    });

    it("never compares against a DUPLICATE", async () => {
      scriptSpecExample();
      await arrive("V1");
      await arrive("V2");
      const v3 = await arrive("V3");
      expect(v3.uniqueness).toBe(Uniqueness.UNIQUE);
      const lastCall = engine.calls.at(-1)!;
      expect(lastCall).toEqual([urlOf("V3"), urlOf("V1")]);
      expect(lastCall).not.toContain(urlOf("V2"));
    });

    it("keeps a PARTIAL in the baseline, and so catches a copy of its new footage", async () => {
      scriptSpecExample();
      for (const id of ["V1", "V2", "V3"]) await arrive(id);
      const v4 = await arrive("V4");
      expect(v4).toMatchObject({
        uniqueness: Uniqueness.PARTIAL,
        matchValue: 41,
        parentId: "V1",
      });
      const v5 = await arrive("V5");
      expect(v5).toMatchObject({
        uniqueness: Uniqueness.DUPLICATE,
        matchValue: 93,
        parentId: "V4",
      });
      expect(engine.calls.at(-1)).toEqual([
        urlOf("V5"),
        urlOf("V1"),
        urlOf("V3"),
        urlOf("V4"),
      ]);
    });

    it("reproduces the design spec's table for V1 to V7", async () => {
      scriptSpecExample();
      for (const id of ["V1", "V2", "V3", "V4", "V5", "V6", "V7"]) {
        await arrive(id);
      }
      const table = ["V1", "V2", "V3", "V4", "V5", "V6", "V7"].map((id) => {
        const row = submissions.row(id);
        return [id, row.uniqueness, row.parentId, row.matchValue];
      });
      expect(table).toEqual([
        ["V1", Uniqueness.UNIQUE, null, 0],
        ["V2", Uniqueness.DUPLICATE, "V1", 96],
        ["V3", Uniqueness.UNIQUE, "V1", 3],
        ["V4", Uniqueness.PARTIAL, "V1", 41],
        ["V5", Uniqueness.DUPLICATE, "V4", 93],
        ["V6", Uniqueness.DUPLICATE, "V3", 97],
        ["V7", Uniqueness.UNIQUE, "V1", 9],
      ]);
      // 1+1+2+3+3+4 pairs, one call each at a cap of 4 — V7 needs [V1,V3,V4].
      expect(engine.calls).toHaveLength(6);
    });

    it("makes a cold candidate's first call alone, then the rest two at a time", async () => {
      // The first call fingerprints the candidate; fired together, every call
      // would download it. Once it is cached the rest can overlap.
      for (const id of ["A", "B", "C", "D", "E", "F", "G"]) await arrive(id);
      const before = engine.calls.length;
      engine.deferred = true;
      submissions.add(CAMPAIGN, "H");
      service.onArrival("submission", CAMPAIGN);

      await settle();
      expect(engine.calls.length - before).toBe(1); // first call alone
      expect(engine.calls.at(-1)![0]).toBe(urlOf("H"));
      engine.release();
      await settle();
      expect(engine.calls.length - before).toBe(3); // the remaining two together
      expect(engine.maxInFlight).toBe(2);
      await drain();

      expect(submissions.row("H").uniqueness).toBe(Uniqueness.UNIQUE);
    });

    it("warms the next candidates' fingerprints while labelling the current one", async () => {
      process.env.COMPARISON_ENGINE_PREFETCH = "2";
      try {
        for (const id of ["A", "B", "C", "D", "E"]) submissions.add(CAMPAIGN, id);
        engine.deferred = true;
        service.onArrival("submission", CAMPAIGN);

        // While A is labelled (UNIQUE, no call) B and C are sent ahead; while
        // B's real call is in flight, D joins them — always two ahead, each
        // paired with the oldest video so the engine has something to
        // compare against.
        await settle();
        expect(engine.calls).toEqual([[urlOf("B"), urlOf("A")]]);
        expect(engine.warmups).toEqual([
          [urlOf("B"), urlOf("A")],
          [urlOf("C"), urlOf("A")],
          [urlOf("D"), urlOf("A")],
        ]);
        await drain();

        // Warm-ups are not part of the audit trail.
        const recorded = submissions.runs.flatMap((run) => run.calls.map((c) => c.candidate.id));
        expect([...new Set(recorded)]).toEqual(["B", "C", "D", "E"]);
        // Each candidate was warmed at most once.
        expect(engine.warmups.map((w) => w[0])).toEqual([
          urlOf("B"),
          urlOf("C"),
          urlOf("D"),
          urlOf("E"),
        ]);
      } finally {
        delete process.env.COMPARISON_ENGINE_PREFETCH;
      }
    });

    it("submits a candidate's real call before warming the next ones, so warm-ups never queue ahead of it", async () => {
      process.env.COMPARISON_ENGINE_PREFETCH = "2";
      try {
        await arrive("A");
        for (const id of ["B", "C", "D"]) submissions.add(CAMPAIGN, id);
        engine.deferred = true;
        service.onArrival("submission", CAMPAIGN);
        await settle();

        // The engine fills its active slots in submission order: B's own
        // call must be first in line, the warm-ups behind it.
        expect(engine.sequence.slice(0, 3)).toEqual(["call:B", "warm:C", "warm:D"]);
        await drain();
      } finally {
        delete process.env.COMPARISON_ENGINE_PREFETCH;
      }
    });

    it("runs a warmed candidate's calls together from the start", async () => {
      process.env.COMPARISON_ENGINE_PREFETCH = "1";
      try {
        for (const id of ["A", "B", "C", "D", "E", "F", "G"]) await arrive(id);
        engine.deferred = true;
        submissions.add(CAMPAIGN, "H");
        submissions.add(CAMPAIGN, "I");
        service.onArrival("submission", CAMPAIGN);

        await settle(); // H's first call alone; I warmed alongside
        engine.release();
        await settle(); // H's remaining two
        engine.release();
        await settle(); // I: warmed, so its calls overlap from the start
        const callsForI = engine.calls.filter((call) => call[0] === urlOf("I"));
        expect(callsForI.length).toBeGreaterThanOrEqual(2);
        await drain();
        expect(submissions.row("I").uniqueness).toBe(Uniqueness.UNIQUE);
      } finally {
        delete process.env.COMPARISON_ENGINE_PREFETCH;
      }
    });

    it("processes several pending videos as one batch, in arrival order", async () => {
      engine.score("B", "B2", 95);
      submissions.add(CAMPAIGN, "A");
      submissions.add(CAMPAIGN, "B");
      submissions.add(CAMPAIGN, "B2");
      service.onArrival("submission", CAMPAIGN);
      await service.whenIdle("submission", CAMPAIGN);

      expect(submissions.row("B2")).toMatchObject({
        uniqueness: Uniqueness.DUPLICATE,
        parentId: "B",
      });
      expect(submissions.runs).toHaveLength(1);
      expect(submissions.runs[0]!.opening.triggerId).toBeNull();
    });

    it("treats a baseline video with the same URL as a perfect match, without calling the engine for it", async () => {
      reels.add(CAMPAIGN, "R1");
      const twin = reels.add(CAMPAIGN, "R2");
      twin.url = urlOf("R1");
      service.onArrival("reel", CAMPAIGN);
      await service.whenIdle("reel", CAMPAIGN);

      expect(reels.row("R2")).toMatchObject({
        uniqueness: Uniqueness.DUPLICATE,
        matchValue: 100,
        parentId: "R1",
      });
      expect(engine.calls).toEqual([]);
    });
  });

  describe("audit trail", () => {
    it("records an upload as a run triggered by that video, with its calls and candidate pairs only", async () => {
      scriptSpecExample();
      for (const id of ["V1", "V2", "V3", "V4"]) await arrive(id);
      const run = submissions.runs.at(-1)!;
      expect(run.opening).toMatchObject({ triggerId: "V4", threshold: 90 });
      expect(run.calls).toHaveLength(1);
      const call = run.calls[0]!;
      expect(call.candidate.id).toBe("V4");
      expect(call.slice.map((video) => video.id)).toEqual(["V1", "V3"]);
      expect(call.status).toBe(ComparisonStatus.SUCCEEDED);
      // The engine also scored V1-V3; that pair is not the run's business.
      expect(
        call.resolved!.pairs.map((pair) => pairKeyOf(pair.aSubmissionId, pair.bSubmissionId)),
      ).toEqual([pairKeyOf("V4", "V1"), pairKeyOf("V4", "V3")]);
      expect(run.closing).toMatchObject({
        status: ComparisonStatus.SUCCEEDED,
        engineVersion: "0.6.0",
        flaggedPairCount: 1,
      });
      expect(run.progress).toMatchObject({ pairsDone: 2, pairsTotal: 2, videoCount: 3 });
    });
  });

  describe("threshold edit", () => {
    it("re-labels every video from its stored value and never calls the engine", async () => {
      scriptSpecExample();
      for (const id of ["V1", "V2", "V3", "V4", "V5"]) await arrive(id);
      const callsBefore = engine.calls.length;

      await service.reclassifyForThreshold(
        {} as Prisma.TransactionClient,
        CAMPAIGN,
        40,
      );

      expect(submissions.row("V4").uniqueness).toBe(Uniqueness.DUPLICATE);
      expect(submissions.row("V5")).toMatchObject({
        uniqueness: Uniqueness.DUPLICATE,
        parentId: "V4",
      });
      expect(engine.calls).toHaveLength(callsBefore);
      expect(submissions.relabelCalls).toEqual([{ campaignId: CAMPAIGN, threshold: 40 }]);
      expect(reels.relabelCalls).toEqual([{ campaignId: CAMPAIGN, threshold: 40 }]);
    });
  });

  describe("withdrawal", () => {
    it("promotes the oldest dependant and re-checks the rest against it, in order", async () => {
      scriptSpecExample();
      for (const id of ["V1", "V2", "V3", "V4", "V5", "V6", "V7"]) await arrive(id);
      submissions.thresholds.set(CAMPAIGN, 40);
      await service.reclassifyForThreshold({} as Prisma.TransactionClient, CAMPAIGN, 40);

      submissions.row("V1").active = false;
      service.withdraw("submission", CAMPAIGN, "V1");
      await service.whenIdle("submission", CAMPAIGN);

      expect(submissions.row("V2")).toMatchObject({
        uniqueness: Uniqueness.UNIQUE,
        parentId: expect.not.stringMatching(/^V1$/),
      });
      expect(submissions.row("V4")).toMatchObject({
        uniqueness: Uniqueness.DUPLICATE,
        matchValue: 41,
        parentId: "V2",
      });
      // V2 was classified before V4 was, so V4 could see it.
      const order = submissions.runs.at(-1)!.calls.map((call) => call.candidate.id);
      expect(order).toEqual(["V2", "V4"]);
      // Untouched: their parent was not V1.
      expect(submissions.row("V5").parentId).toBe("V4");
      expect(submissions.row("V6").parentId).toBe("V3");
    });

    it("does nothing for a video nothing depended on", async () => {
      scriptSpecExample();
      for (const id of ["V1", "V2"]) await arrive(id);
      const runsBefore = submissions.runs.length;

      submissions.row("V2").active = false;
      service.withdraw("submission", CAMPAIGN, "V2");
      await service.whenIdle("submission", CAMPAIGN);

      expect(submissions.runs).toHaveLength(runsBefore);
      expect(submissions.row("V1").uniqueness).toBe(Uniqueness.UNIQUE);
    });
  });

  describe("rebuild", () => {
    it("replays every video in arrival order and reproduces the same table", async () => {
      scriptSpecExample();
      for (const id of ["V1", "V2", "V3", "V4", "V5", "V6", "V7"]) await arrive(id);
      const before = ["V1", "V2", "V3", "V4", "V5", "V6", "V7"].map((id) => ({
        ...submissions.row(id),
      }));

      const runId = await service.rebuild("submission", CAMPAIGN);
      await service.whenIdle("submission", CAMPAIGN);

      for (const old of before) {
        expect(submissions.row(old.id)).toMatchObject({
          uniqueness: old.uniqueness,
          parentId: old.parentId,
          matchValue: old.matchValue,
        });
      }
      const run = submissions.runs.find((candidate) => candidate.id === runId)!;
      expect(run.opening).toMatchObject({ triggerId: null, candidateCount: 7 });
      expect(run.calls.map((call) => call.candidate.id)).toEqual([
        "V2",
        "V3",
        "V4",
        "V5",
        "V6",
        "V7",
      ]);
      expect(run.closing?.status).toBe(ComparisonStatus.SUCCEEDED);
    });

    it("opens its run row before returning, so the page can poll it at once", async () => {
      await arrive("V1");
      const runId = await service.rebuild("submission", CAMPAIGN);
      expect(submissions.runs.some((run) => run.id === runId)).toBe(true);
      await service.whenIdle("submission", CAMPAIGN);
    });

    it("runs an arrival that lands during a rebuild after it", async () => {
      scriptSpecExample();
      for (const id of ["V1", "V2", "V3"]) await arrive(id);

      void service.rebuild("submission", CAMPAIGN);
      submissions.add(CAMPAIGN, "V4");
      service.onArrival("submission", CAMPAIGN);
      await service.whenIdle("submission", CAMPAIGN);

      expect(submissions.row("V4")).toMatchObject({
        uniqueness: Uniqueness.PARTIAL,
        parentId: "V1",
      });
      const candidates = submissions.runs.flatMap((run) =>
        run.calls.map((call) => call.candidate.id),
      );
      // The rebuild's V2 and V3 come before V4, whichever batch picked V4 up.
      expect(candidates.indexOf("V4")).toBeGreaterThan(candidates.lastIndexOf("V3"));
    });
  });

  describe("failures", () => {
    it("fails the run and leaves every candidate pending when the engine is unreachable", async () => {
      await arrive("V1");
      engine.mode = "unreachable";
      submissions.add(CAMPAIGN, "V2");
      submissions.add(CAMPAIGN, "V3");
      service.onArrival("submission", CAMPAIGN);
      await service.whenIdle("submission", CAMPAIGN);

      expect(submissions.row("V2")).toMatchObject({ uniqueness: null, checkedAt: null });
      expect(submissions.row("V3")).toMatchObject({ uniqueness: null, checkedAt: null });
      expect(submissions.runs.at(-1)!.closing).toMatchObject({
        status: ComparisonStatus.FAILED,
        errorMessage: expect.stringContaining("could not reach"),
      });
      // V3 was never attempted: classifying it without V2 would be wrong.
      expect(engine.calls).toHaveLength(1);
    });

    it("marks a video the engine could not read as unreadable, and carries on", async () => {
      engine.score("V1", "V3", 3);
      await arrive("V1");
      engine.unreadable.add("V2");
      submissions.add(CAMPAIGN, "V2");
      submissions.add(CAMPAIGN, "V3");
      service.onArrival("submission", CAMPAIGN);
      await service.whenIdle("submission", CAMPAIGN);

      expect(submissions.row("V2")).toMatchObject({ uniqueness: null });
      expect(submissions.row("V2").checkedAt).not.toBeNull();
      expect(submissions.row("V3").uniqueness).toBe(Uniqueness.UNIQUE);
      expect(submissions.runs.at(-1)!.closing?.status).toBe(ComparisonStatus.PARTIAL);
    });

    it("retries a call the engine timed out, then leaves the candidate pending", async () => {
      await arrive("V1");
      engine.mode = "timeout";
      submissions.add(CAMPAIGN, "V2");
      service.onArrival("submission", CAMPAIGN);
      await service.whenIdle("submission", CAMPAIGN);

      expect(engine.calls).toHaveLength(2);
      expect(submissions.row("V2")).toMatchObject({ uniqueness: null, checkedAt: null });
      const run = submissions.runs.at(-1)!;
      expect(run.calls.at(-1)?.status).toBe(ComparisonStatus.TIMEOUT);
      expect(run.closing?.status).toBe(ComparisonStatus.PARTIAL);
    });

    it("survives a candidate that is not in a campaign any more", async () => {
      // The campaign was soft-deleted between the upload and the check.
      submissions.thresholds.set("gone", Number.NaN);
      vi.spyOn(submissions, "loadThreshold").mockResolvedValue(null);
      submissions.add("gone", "V1");
      service.onArrival("submission", "gone");
      await expect(service.whenIdle("submission", "gone")).resolves.toBeUndefined();
      expect(submissions.runs).toHaveLength(0);
    });
  });

  describe("boot", () => {
    it("fails runs left live by the previous process and resumes pending campaigns", async () => {
      scriptSpecExample();
      await arrive("V1");
      await submissions.openRun(CAMPAIGN, { triggerId: null, threshold: 90, candidateCount: 1 });
      submissions.add(CAMPAIGN, "V2");
      reels.add("cmp_2", "R1");

      await service.onApplicationBootstrap();
      await service.whenIdle("submission", CAMPAIGN);
      await service.whenIdle("reel", "cmp_2");

      expect(submissions.runs[1]!.failedOnBoot).toMatch(/restarted/);
      expect(submissions.row("V2").uniqueness).toBe(Uniqueness.DUPLICATE);
      expect(reels.row("R1").uniqueness).toBe(Uniqueness.UNIQUE);
    });

    it("resumes a campaign whose batch stopped, once the engine is back — without a restart", async () => {
      vi.useFakeTimers();
      try {
        scriptSpecExample();
        await arrive("V1");
        await service.onApplicationBootstrap();

        engine.mode = "unreachable";
        submissions.add(CAMPAIGN, "V2");
        service.onArrival("submission", CAMPAIGN);
        await service.whenIdle("submission", CAMPAIGN);
        expect(submissions.row("V2").uniqueness).toBeNull(); // the outage stopped the batch

        engine.mode = "ok";
        await vi.advanceTimersByTimeAsync(RESUME_INTERVAL_MS);
        await service.whenIdle("submission", CAMPAIGN);

        expect(submissions.row("V2").uniqueness).toBe(Uniqueness.DUPLICATE);
      } finally {
        service.onModuleDestroy();
        vi.useRealTimers();
      }
    });

    it("does not pile a second pass onto a campaign that is already being classified", async () => {
      vi.useFakeTimers();
      try {
        await service.onApplicationBootstrap();
        engine.deferred = true;
        submissions.add(CAMPAIGN, "V1");
        service.onArrival("submission", CAMPAIGN);
        await settle();

        await vi.advanceTimersByTimeAsync(RESUME_INTERVAL_MS * 3);
        engine.deferred = false;
        engine.release();
        await service.whenIdle("submission", CAMPAIGN);

        // One batch, one run row — the resume left the busy campaign alone.
        expect(submissions.runs).toHaveLength(1);
      } finally {
        service.onModuleDestroy();
        vi.useRealTimers();
      }
    });

    it("can be told not to sweep, for one-off scripts", async () => {
      process.env.UNIQUENESS_SWEEP_ON_BOOT = "false";
      try {
        submissions.add(CAMPAIGN, "V1");
        await service.onApplicationBootstrap();
        await service.whenIdle("submission", CAMPAIGN);
        expect(submissions.row("V1").uniqueness).toBeNull();
      } finally {
        delete process.env.UNIQUENESS_SWEEP_ON_BOOT;
      }
    });
  });
});
