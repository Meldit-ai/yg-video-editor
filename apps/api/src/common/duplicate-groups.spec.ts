import { Uniqueness } from "@repo/database";
import { describe, expect, it } from "vitest";
import { groupDuplicates, isCopy, type Groupable } from "./duplicate-groups.js";

function row(
  id: string,
  uniqueness: Uniqueness | null,
  parentId: string | null = null,
): Groupable {
  return { id, uniqueness, parentId };
}

describe("isCopy", () => {
  it("does not treat a UNIQUE row as a copy, parent or not", () => {
    // The trap: a UNIQUE row also carries a parent id, kept so a threshold
    // edit can re-label without the engine. On a real campaign 32 of 34
    // UNIQUE rows had one, so grouping on the pointer alone would file
    // originals as copies of whatever they were merely measured against.
    expect(isCopy(row("a", Uniqueness.UNIQUE, "b"))).toBe(false);
    expect(isCopy(row("a", Uniqueness.UNIQUE, null))).toBe(false);
  });

  it("treats DUPLICATE and PARTIAL rows as copies", () => {
    expect(isCopy(row("a", Uniqueness.DUPLICATE, "b"))).toBe(true);
    expect(isCopy(row("a", Uniqueness.PARTIAL, "b"))).toBe(true);
  });

  it("does not treat an unchecked row as a copy", () => {
    expect(isCopy(row("a", null, "b"))).toBe(false);
  });
});

describe("groupDuplicates", () => {
  it("puts an original at the head with its copies beneath", () => {
    const groups = groupDuplicates([
      row("original", Uniqueness.UNIQUE),
      row("copy-1", Uniqueness.DUPLICATE, "original"),
      row("copy-2", Uniqueness.DUPLICATE, "original"),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.head.id).toBe("original");
    expect(groups[0]?.children.map((child) => child.id)).toEqual([
      "copy-1",
      "copy-2",
    ]);
  });

  it("keeps a UNIQUE row as a head even when it names a parent", () => {
    const groups = groupDuplicates([
      row("first", Uniqueness.UNIQUE),
      row("second", Uniqueness.UNIQUE, "first"),
    ]);

    // Two heads, not one group of two: the second was compared against the
    // first and found unlike it.
    expect(groups.map((group) => group.head.id)).toEqual(["first", "second"]);
    expect(groups.every((group) => group.children.length === 0)).toBe(true);
  });

  it("lets a PARTIAL be both a copy and a head", () => {
    // A PARTIAL is partly new, so the classifier keeps it in the baseline and
    // later videos can be copies of it.
    const groups = groupDuplicates([
      row("original", Uniqueness.UNIQUE),
      row("partial", Uniqueness.PARTIAL, "original"),
      row("copy-of-partial", Uniqueness.DUPLICATE, "partial"),
    ]);

    const head = groups.find((group) => group.head.id === "original");
    expect(head?.children.map((child) => child.id)).toEqual(["partial"]);
    // And it is not also listed as a head, because it is claimed as a child.
    expect(groups.map((group) => group.head.id)).not.toContain("partial");
  });

  it("keeps an unchecked video visible as its own group", () => {
    const groups = groupDuplicates([row("pending", null)]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.head.id).toBe("pending");
  });

  it("keeps a copy whose parent is not in the list", () => {
    // The parent may have been withdrawn or filtered out. Dropping the child
    // would hide a video the caller asked for.
    const groups = groupDuplicates([
      row("orphan", Uniqueness.DUPLICATE, "gone"),
    ]);
    expect(groups.map((group) => group.head.id)).toEqual(["orphan"]);
  });

  it("preserves the order the caller sorted by", () => {
    const groups = groupDuplicates([
      row("b", Uniqueness.UNIQUE),
      row("a", Uniqueness.UNIQUE),
      row("b-copy", Uniqueness.DUPLICATE, "b"),
    ]);
    expect(groups.map((group) => group.head.id)).toEqual(["b", "a"]);
  });

  it("handles the shape a real campaign produced", () => {
    // One original with sixteen copies, alongside smaller clusters.
    const rows: Groupable[] = [row("big", Uniqueness.UNIQUE)];
    for (let index = 0; index < 16; index += 1) {
      rows.push(row(`big-copy-${index}`, Uniqueness.DUPLICATE, "big"));
    }
    rows.push(row("small", Uniqueness.UNIQUE));
    rows.push(row("small-copy", Uniqueness.DUPLICATE, "small"));

    const groups = groupDuplicates(rows);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.children).toHaveLength(16);
    expect(groups[1]?.children).toHaveLength(1);
  });
});
