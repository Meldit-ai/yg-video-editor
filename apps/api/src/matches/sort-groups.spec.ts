import { describe, expect, it } from "vitest";
import { MATCH_GROUP_SORTS } from "./matches.types.js";

describe("MATCH_GROUP_SORTS", () => {
  it("offers the orderings the matches page uses", () => {
    expect(MATCH_GROUP_SORTS).toContain("views");
    expect(MATCH_GROUP_SORTS).toContain("likes");
    expect(MATCH_GROUP_SORTS).toContain("reels");
    expect(MATCH_GROUP_SORTS).toContain("recent");
  });
});
