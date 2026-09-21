import { describe, expect, it } from "vitest";
import { composeMessage, templateLinks } from "./shares.service.js";

const LINKS = [
  "https://bucket.example/a.mp4",
  "https://bucket.example/b.mp4",
  "https://bucket.example/c.mp4",
];

describe("templateLinks", () => {
  /**
   * The bug this exists for: a share of several videos reached a vendor
   * outside the 24-hour window carrying one link, because the template was
   * handed `links[0]` while the free-form path composed the whole list. Which
   * path runs is invisible to the admin, so it read as intermittent.
   */
  it("carries every link, not just the first", () => {
    const text = templateLinks(LINKS);
    for (const link of LINKS) expect(text).toContain(link);
  });

  it("separates them with spaces, because a newline is refused", () => {
    // Checked against the live API: spaces are accepted, and the same text
    // with a newline comes back as "(#132018) There is an issue with the
    // parameters in your template".
    expect(templateLinks(LINKS)).not.toContain("\n");
    expect(templateLinks(LINKS)).toBe(LINKS.join(" "));
  });

  it("handles a single video without a trailing separator", () => {
    expect(templateLinks([LINKS[0]!])).toBe(LINKS[0]);
  });

  it("is empty when there is nothing to send", () => {
    expect(templateLinks([])).toBe("");
  });
});

describe("composeMessage", () => {
  it("puts the links under the note, separated by a blank line", () => {
    // The blank line is what makes WhatsApp render the first link as a
    // preview card rather than running it into the sentence before.
    expect(composeMessage("Please review these.", LINKS)).toBe(
      `Please review these.\n\n${LINKS.join("\n")}`,
    );
  });

  it("sends the links alone when no note was typed", () => {
    expect(composeMessage("   ", LINKS)).toBe(LINKS.join("\n"));
  });

  it("keeps every link, one per line", () => {
    const body = composeMessage("Hi", LINKS);
    expect(body.split("\n").filter((line) => line.startsWith("http"))).toEqual(
      LINKS,
    );
  });
});
