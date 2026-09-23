import { describe, expect, it } from "vitest";
import {
  findOtherLinks,
  findPostLinks,
  objectKeyOf,
  parsePostLink,
  shortcodeOf,
} from "./post-link.js";

describe("parsePostLink", () => {
  /** Both spellings occur in our own tracker rows. */
  it("reads /reel/ and /reels/ as the same thing", () => {
    const one = parsePostLink("https://www.instagram.com/reel/Dc3xTdXtjgf/");
    const two = parsePostLink("https://www.instagram.com/reels/Dc3xTdXtjgf/");
    expect(one?.shortcode).toBe("Dc3xTdXtjgf");
    expect(two?.shortcode).toBe("Dc3xTdXtjgf");
    expect(one?.canonical).toBe(two?.canonical);
  });

  it("ignores the share-sheet tracking token", () => {
    // What the Instagram app actually puts on the clipboard.
    const link = parsePostLink(
      "https://www.instagram.com/reel/DdEDFoKSiz-/?igsh=MXY5ZmZ2bjJx",
    );
    expect(link?.shortcode).toBe("DdEDFoKSiz-");
    expect(link?.canonical).toBe("https://www.instagram.com/reel/DdEDFoKSiz-/");
  });

  it("reads the /<username>/reel/<code> shape", () => {
    const link = parsePostLink(
      "https://instagram.com/sunshine__girl15/reel/DdCCRoUzTh3",
    );
    expect(link?.shortcode).toBe("DdCCRoUzTh3");
  });

  it("reads feed posts and IGTV, not just reels", () => {
    expect(parsePostLink("https://instagram.com/p/Abc12/")?.kind).toBe("post");
    expect(parsePostLink("https://instagram.com/tv/Abc12/")?.kind).toBe("tv");
  });

  it("keeps the raw link as the vendor sent it", () => {
    const raw = "https://www.instagram.com/reel/Dc3xTdXtjgf/?igsh=xyz";
    expect(parsePostLink(raw)?.raw).toBe(raw);
  });

  it("refuses a profile link, which names no post", () => {
    // A vendor sending their profile has not told us what they posted.
    expect(parsePostLink("https://www.instagram.com/sunshine__girl15/")).toBeNull();
    expect(parsePostLink("https://instagram.com/")).toBeNull();
  });

  it("refuses another platform", () => {
    expect(parsePostLink("https://youtube.com/watch?v=abc")).toBeNull();
    expect(parsePostLink("https://fake-instagram.com/reel/Abc12/")).toBeNull();
  });

  it("refuses anything that is not a URL", () => {
    expect(parsePostLink("posted it")).toBeNull();
    expect(parsePostLink("")).toBeNull();
  });
});

describe("findPostLinks", () => {
  it("finds a bare link with no other words", () => {
    // The commonest reply: the vendor pastes the link and sends it.
    const links = findPostLinks("https://www.instagram.com/reel/Dc3xTdXtjgf/");
    expect(links).toHaveLength(1);
    expect(links[0]?.shortcode).toBe("Dc3xTdXtjgf");
  });

  it("finds a link inside a sentence", () => {
    const links = findPostLinks(
      "Done bhai, posted here https://www.instagram.com/reel/DdEOK6KyLap/ check it",
    );
    expect(links[0]?.shortcode).toBe("DdEOK6KyLap");
  });

  it("does not swallow the sentence's punctuation", () => {
    // "…/abc/." would otherwise carry the full stop into the shortcode.
    const links = findPostLinks(
      "posted https://www.instagram.com/reel/DdEhqCHv7bB/.",
    );
    expect(links[0]?.shortcode).toBe("DdEhqCHv7bB");
  });

  it("finds several posts in one message", () => {
    const links = findPostLinks(
      "https://www.instagram.com/reel/Aaaaa/ and https://www.instagram.com/reel/Bbbbb/",
    );
    expect(links.map((one) => one.shortcode)).toEqual(["Aaaaa", "Bbbbb"]);
  });

  it("counts one post once, however it was spelled", () => {
    // The share-sheet link and a cleaned one are the same post.
    const links = findPostLinks(
      "https://www.instagram.com/reel/Aaaaa/?igsh=x https://instagram.com/reels/Aaaaa",
    );
    expect(links).toHaveLength(1);
  });

  it("returns nothing for a message with no links", () => {
    expect(findPostLinks("will post tomorrow")).toEqual([]);
  });
});

describe("findOtherLinks", () => {
  it("separates a non-post link from the posts", () => {
    // "They sent something, but not a post" is a different conversation from
    // "they sent nothing".
    const text = "https://youtube.com/watch?v=x https://www.instagram.com/reel/Aaaaa/";
    expect(findOtherLinks(text)).toEqual(["https://youtube.com/watch?v=x"]);
    expect(findPostLinks(text)).toHaveLength(1);
  });
});

describe("shortcodeOf", () => {
  it("reads our own stored permalinks", () => {
    expect(shortcodeOf("https://www.instagram.com/reel/Dc3xTdXtjgf/")).toBe(
      "Dc3xTdXtjgf",
    );
    expect(shortcodeOf("https://www.instagram.com/reels/DdDXn_rtBgr/")).toBe(
      "DdDXn_rtBgr",
    );
  });

  it("handles a reel with no permalink stored", () => {
    expect(shortcodeOf(null)).toBeNull();
  });
});

describe("objectKeyOf", () => {
  /**
   * A playback link is presigned, so the same video yields a different URL on
   * every send. Comparing whole URLs would never match; the key is the part
   * that does not change.
   */
  it("ignores the signature and expiry", () => {
    const first = objectKeyOf(
      "https://meldit.fsn1.your-objectstorage.com/instagram/1785215350458_x.mp4?X-Amz-Signature=aaa&X-Amz-Expires=3600",
    );
    const second = objectKeyOf(
      "https://meldit.fsn1.your-objectstorage.com/instagram/1785215350458_x.mp4?X-Amz-Signature=bbb&X-Amz-Expires=86400",
    );
    expect(first).toBe("instagram/1785215350458_x.mp4");
    expect(second).toBe(first);
  });

  it("reads both bucket spellings as the same key", () => {
    // The bucket appears as a host label in one shape and a path segment in
    // the other; our storage has produced both. The path style needs the
    // bucket name, which the app reads from its environment.
    const previous = process.env.HETZNER_BUCKET_NAME;
    process.env.HETZNER_BUCKET_NAME = "meldit";
    try {
      expect(
        objectKeyOf("https://meldit.fsn1.your-objectstorage.com/instagram/a.mp4"),
      ).toBe("instagram/a.mp4");
      expect(
        objectKeyOf("https://fsn1.your-objectstorage.com/meldit/instagram/a.mp4"),
      ).toBe("instagram/a.mp4");
    } finally {
      if (previous === undefined) delete process.env.HETZNER_BUCKET_NAME;
      else process.env.HETZNER_BUCKET_NAME = previous;
    }
  });

  it("keeps a nested campaign key whole", () => {
    expect(
      objectKeyOf(
        "https://meldit.fsn1.your-objectstorage.com/campaigns/cmu2c99vb/da45ee99.mp4",
      ),
    ).toBe("campaigns/cmu2c99vb/da45ee99.mp4");
  });

  it("does not treat two different videos as one", () => {
    const a = objectKeyOf("https://meldit.fsn1.x.com/instagram/a.mp4");
    const b = objectKeyOf("https://meldit.fsn1.x.com/instagram/b.mp4");
    expect(a).not.toBe(b);
  });

  it("returns null for anything that is not a URL", () => {
    expect(objectKeyOf("not a url")).toBeNull();
    expect(objectKeyOf("https://meldit.fsn1.x.com/")).toBeNull();
  });
});
