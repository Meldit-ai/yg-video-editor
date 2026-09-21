import { Uniqueness } from "@repo/database";
import { describe, expect, it } from "vitest";
import {
  PARTIAL_FLOOR,
  classifyMatches,
  labelFor,
  matchesOf,
  pairValue,
  planPinnedCalls,
  type Candidate,
} from "./uniqueness.rules.js";

function candidate(id: string, url = `https://bucket/${id}`): Candidate {
  return { id, url, arrivedAt: new Date(`2026-09-0${id.length}T00:00:00Z`) };
}

describe("pairValue", () => {
  it("is the higher of score and containment", () => {
    expect(pairValue(31, 97)).toBe(97);
    expect(pairValue(96, 40)).toBe(96);
  });

  it("keeps the engine's one-decimal precision", () => {
    expect(pairValue(41.26, 12)).toBe(41.3);
  });
});

describe("labelFor", () => {
  const threshold = 90;

  it("is UNIQUE when there was nothing to compare against, whatever the value", () => {
    expect(labelFor(100, threshold, false)).toBe(Uniqueness.UNIQUE);
  });

  it("is DUPLICATE at exactly the threshold", () => {
    expect(labelFor(90, threshold, true)).toBe(Uniqueness.DUPLICATE);
  });

  it("is PARTIAL between the floor and the threshold", () => {
    expect(labelFor(41, threshold, true)).toBe(Uniqueness.PARTIAL);
    expect(labelFor(PARTIAL_FLOOR, threshold, true)).toBe(Uniqueness.PARTIAL);
    expect(labelFor(89.9, threshold, true)).toBe(Uniqueness.PARTIAL);
  });

  it("is UNIQUE below the floor even though the raw value is not zero", () => {
    expect(labelFor(12, threshold, true)).toBe(Uniqueness.UNIQUE);
    expect(labelFor(24.9, threshold, true)).toBe(Uniqueness.UNIQUE);
  });

  it("follows a lowered threshold: 41 becomes DUPLICATE at 40", () => {
    expect(labelFor(41, 40, true)).toBe(Uniqueness.DUPLICATE);
  });

  it("lets a threshold below the floor turn a low match into a DUPLICATE", () => {
    // The floor is the engine's no-match edge, not a second admin knob: an
    // admin who sets 20 means it, so a stored 22 is DUPLICATE, not UNIQUE.
    expect(labelFor(22, 20, true)).toBe(Uniqueness.DUPLICATE);
  });
});

describe("classifyMatches", () => {
  it("is UNIQUE with no parent when the baseline was empty", () => {
    expect(classifyMatches([], 90)).toEqual({
      uniqueness: Uniqueness.UNIQUE,
      matchValue: 0,
      averageValue: 0,
      parentId: null,
    });
  });

  it("takes the highest pair as the match value and its video as the parent", () => {
    // Spec §4, V5: the copy of the PARTIAL's new footage.
    const outcome = classifyMatches(
      [
        { otherId: "V1", score: 12, containment: 5 },
        { otherId: "V3", score: 4, containment: 2 },
        { otherId: "V4", score: 93, containment: 60 },
      ],
      90,
    );
    expect(outcome).toMatchObject({
      uniqueness: Uniqueness.DUPLICATE,
      matchValue: 93,
      parentId: "V4",
    });
  });

  it("lets containment alone lift a short clip over the threshold", () => {
    // Spec §4, V6: 12 seconds cut out of V3's 90.
    const outcome = classifyMatches(
      [
        { otherId: "V1", score: 8, containment: 5 },
        { otherId: "V3", score: 31, containment: 97 },
        { otherId: "V4", score: 2, containment: 1 },
      ],
      90,
    );
    expect(outcome).toMatchObject({
      uniqueness: Uniqueness.DUPLICATE,
      matchValue: 97,
      parentId: "V3",
    });
  });

  it("records the best match as the parent even when the label is UNIQUE", () => {
    // So a later threshold edit below the floor still has something to point
    // at, without asking the engine again.
    const outcome = classifyMatches(
      [
        { otherId: "V1", score: 3, containment: 1 },
        { otherId: "V7", score: 9, containment: 4 },
      ],
      90,
    );
    expect(outcome).toEqual({
      uniqueness: Uniqueness.UNIQUE,
      matchValue: 9,
      averageValue: 6,
      parentId: "V7",
    });
  });

  it("prefers the earlier match on a tie", () => {
    const outcome = classifyMatches(
      [
        { otherId: "V1", score: 95, containment: 10 },
        { otherId: "V2", score: 95, containment: 10 },
      ],
      90,
    );
    expect(outcome.parentId).toBe("V1");
  });

  it("averages the pair values, for display", () => {
    const outcome = classifyMatches(
      [
        { otherId: "V1", score: 40, containment: 10 },
        { otherId: "V2", score: 10, containment: 60 },
      ],
      90,
    );
    expect(outcome.averageValue).toBe(50);
  });
});

describe("matchesOf", () => {
  const rows = [
    { aSubmissionId: "V1", bSubmissionId: "V5", score: 12, containment: 5 },
    { aSubmissionId: "V5", bSubmissionId: "V4", score: 93, containment: 60 },
    // Baseline against baseline: the engine computed it, we do not want it.
    { aSubmissionId: "V1", bSubmissionId: "V4", score: 41, containment: 30 },
  ];

  it("keeps only pairs with the candidate on one side, oriented from it", () => {
    expect(matchesOf("V5", rows)).toEqual([
      { otherId: "V1", score: 12, containment: 5 },
      { otherId: "V4", score: 93, containment: 60 },
    ]);
  });

  it("is empty when the candidate appears in no pair", () => {
    expect(matchesOf("V9", rows)).toEqual([]);
  });
});

describe("planPinnedCalls", () => {
  const cand = candidate("V5");

  it("plans no calls against an empty baseline", () => {
    expect(planPinnedCalls(cand, [], 4)).toEqual({ calls: [], twins: [] });
  });

  it("pins the candidate first and fills the rest of the call with baseline", () => {
    const baseline = [candidate("V1"), candidate("V3"), candidate("V4")];
    expect(planPinnedCalls(cand, baseline, 4).calls).toEqual([
      [cand, ...baseline],
    ]);
  });

  it("slices a baseline larger than the cap into ceil(b / (cap - 1)) calls", () => {
    const baseline = Array.from({ length: 7 }, (_, i) => candidate(`B${i}`));
    const { calls } = planPinnedCalls(cand, baseline, 4);
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.length).toBeLessThanOrEqual(4);
      expect(call[0]).toBe(cand);
    }
    expect(calls.flatMap((call) => call.slice(1))).toEqual(baseline);
  });

  it("leaves out a baseline video with the candidate's own URL, and says so", () => {
    // The engine refuses a job with the same URL twice. A reel re-imported
    // under a second post is the realistic way this happens.
    const twin = candidate("R2", cand.url);
    const other = candidate("R1");
    expect(planPinnedCalls(cand, [twin, other], 4)).toEqual({
      calls: [[cand, other]],
      twins: [twin],
    });
  });

  it("plans no calls when the only baseline video is the URL twin", () => {
    const twin = candidate("R2", cand.url);
    expect(planPinnedCalls(cand, [twin], 4)).toEqual({
      calls: [],
      twins: [twin],
    });
  });

  it("treats a baseline video with the same content identity as a twin, too", () => {
    // Same bytes at a different URL: a re-upload of the same file. Hetzner's
    // ETag (or a submission's sha256) says so without the engine.
    const me = { ...cand, identity: "etag:abc" };
    const same = { ...candidate("R1"), identity: "etag:abc" };
    const other = { ...candidate("R3"), identity: "etag:zzz" };
    expect(planPinnedCalls(me, [same, other], 4)).toEqual({
      calls: [[me, other]],
      twins: [same],
    });
  });

  it("never calls two videos twins when either side has no identity", () => {
    const me = { ...cand, identity: "etag:abc" };
    const unknown = candidate("R1");
    expect(planPinnedCalls(me, [unknown], 4).twins).toEqual([]);
    expect(planPinnedCalls(cand, [{ ...unknown, identity: "etag:abc" }], 4).twins).toEqual([]);
  });
});
