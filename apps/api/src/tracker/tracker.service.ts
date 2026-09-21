import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";

/**
 * One selectable campaign from the external tracker.
 *
 * `name` is display-only and is NOT unique across the feed (two live entries
 * are both called "Airbnb"). `id` is the only real key — never key a map, a
 * list or a React key on the name.
 */
export interface TrackerCampaign {
  id: string;
  name: string;
}

/**
 * One Instagram reel from a tracker campaign.
 *
 * Only reels carry exactly one video, which is what makes them matchable; a
 * carousel post has several and a story has none. `postedAt` is half the
 * evidence for reading who published first, so it is carried through even when
 * upstream leaves it null.
 */
export interface TrackerReel {
  trackerPostId: string;
  /** Verbatim from upstream — a profile URL, not a bare handle. */
  socialUsername: string;
  /** The handle parsed out of it, lowercased. */
  username: string;
  permalink: string | null;
  /** The direct .mp4. Never normalised: the engine caches on this string. */
  mediaUrl: string;
  postedAt: Date | null;
  postCounts: unknown;
  caption: string | null;
  invoiceApproved: boolean;
  /**
   * What a HEAD on `mediaUrl` said, when one was made (see reels/media-head).
   * Absent — not null — when it was not, so an import that skipped the HEAD
   * leaves the stored values alone.
   */
  mediaSizeBytes?: number | null;
  mediaEtag?: string | null;
}

/** Upstream feed of currently-active tracker campaigns. No auth today. */
const TRACKER_LIST_URL =
  "https://api-tracker.meldit.ai/api/v1/campaign/active/list-id-name";

/** Upstream posts for one campaign. */
const TRACKER_POSTS_URL =
  "https://api-tracker.meldit.ai/api/v1/campaign/dashboard/posts";

/** Upstream's own label for a single-video Instagram post. */
const REEL_POST_TYPE = "instareel";

/**
 * Posts per request. The upstream accepts a thousand, which turns a
 * ten-thousand-post campaign into eleven requests rather than fifty-four.
 */
const POSTS_PAGE_SIZE = 1000;

/**
 * Stops a paging loop that never sees its own end.
 *
 * At the page size above this is ten times the largest campaign measured, so
 * reaching it means the upstream is repeating a page or miscounting, not that
 * a campaign is genuinely that big.
 */
const MAX_POSTS_PAGES = 100;

/**
 * Per page, not per import. Raised with the page size — a thousand posts is a
 * far bigger payload than the two hundred this was sized for.
 */
const POSTS_TIMEOUT_MS = 60_000;

/** How long a fetched list stays fresh. The feed changes a few times a day. */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** Upstream is a third party — never let a hung socket hold a request open. */
const REQUEST_TIMEOUT_MS = 8_000;

interface CachedList {
  campaigns: TrackerCampaign[];
  fetchedAt: number;
}

/**
 * Read-only proxy over the external campaign tracker.
 *
 * The browser deliberately does not call the upstream directly: it sets no
 * CORS headers for our origin, the payload (~250 entries, ~28KB) is worth
 * caching once per process rather than once per tab, and routing it through
 * here keeps a future API key server-side.
 *
 * Availability is favoured over freshness. A refresh that fails while a
 * previously-fetched list is still in memory serves that stale list instead
 * of erroring: a briefing tool is more useful with slightly old campaign
 * names than with a 503.
 */
@Injectable()
export class TrackerService {
  private readonly logger = new Logger(TrackerService.name);

  /** Last successful fetch, kept past its TTL so it can be served stale. */
  private cached: CachedList | null = null;

  /** In-flight refresh, shared by every caller so they cannot stampede. */
  private refreshing: Promise<TrackerCampaign[]> | null = null;

  /** Active tracker campaigns, from cache when fresh. */
  async listCampaigns(): Promise<TrackerCampaign[]> {
    const cached = this.cached;
    if (cached !== null && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.campaigns;
    }
    return this.refresh();
  }

  /**
   * Display name for a tracker id, or null when the tracker does not know it.
   *
   * Callers persist the returned name alongside the id, so the pair can never
   * disagree — see CampaignsService.
   */
  async resolveName(id: string): Promise<string | null> {
    const campaigns = await this.listCampaigns();
    return campaigns.find((campaign) => campaign.id === id)?.name ?? null;
  }

  /**
   * Every matchable reel on a tracker campaign, oldest post first.
   *
   * Ordered upstream by `postDate`, not by the tracker's own `createdAt`. The
   * two disagree: a campaign's earliest *post* can be ingested long after a
   * later one, so a window taken in ingest order can miss the beginning of the
   * campaign entirely. On the Traitors campaign that window started five and a
   * half weeks late, which matters because the earliest post is the original
   * every later reel is read against.
   *
   * Paged to the end rather than taking a first page. The campaign carries ten
   * thousand posts and a page holds a thousand, so one page is a sample, not
   * the campaign.
   *
   * Deliberately NOT cached, unlike the campaign picker above. That list
   * tolerates staleness because it only fills a dropdown; an ingest is asking
   * "what is on this campaign right now" and would rather fail loudly and be
   * retried than quietly match against an hour-old feed.
   */
  async listReels(trackerCampaignId: string): Promise<TrackerReel[]> {
    const reels: TrackerReel[] = [];
    let fetched = 0;

    for (let page = 1; page <= MAX_POSTS_PAGES; page += 1) {
      const { rows, total } = await this.fetchPostsPage(trackerCampaignId, page);
      fetched += rows.length;
      reels.push(...parseTrackerReels(rows));

      // A short page is the end of the feed; `total` is the upstream's own
      // count, checked as well so a page that happens to come back full on the
      // last boundary does not cost an extra request.
      if (rows.length < POSTS_PAGE_SIZE || fetched >= total) break;
    }

    this.logger.log(
      `Tracker campaign ${trackerCampaignId}: ${reels.length} matchable reel(s) from ${fetched} post(s)`,
    );
    return reels;
  }

  /** One page of posts, with the upstream's total so paging can stop. */
  private async fetchPostsPage(
    trackerCampaignId: string,
    page: number,
  ): Promise<{ rows: unknown[]; total: number }> {
    const url =
      `${TRACKER_POSTS_URL}/${encodeURIComponent(trackerCampaignId)}` +
      `?skip=${(page - 1) * POSTS_PAGE_SIZE}&orderBy=asc&orderByProp=postDate` +
      `&limit=${POSTS_PAGE_SIZE}&search=&field=&page=${page}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(POSTS_TIMEOUT_MS),
      });
    } catch (caught) {
      const reason = caught instanceof Error ? caught.message : String(caught);
      throw new ServiceUnavailableException(
        `The campaign tracker did not answer: ${reason}`,
      );
    }

    if (!response.ok) {
      throw new ServiceUnavailableException(
        `The campaign tracker responded with HTTP ${response.status}`,
      );
    }

    const payload: unknown = await response.json();
    return { rows: postRowsOf(payload), total: totalCountOf(payload) };
  }

  /**
   * Fetches a new list, collapsing concurrent callers onto one request.
   *
   * The promise is stored before it is awaited, so a second caller arriving
   * while the first is still in flight joins that request rather than opening
   * another one.
   */
  private refresh(): Promise<TrackerCampaign[]> {
    const inFlight = this.refreshing;
    if (inFlight !== null) {
      return inFlight;
    }

    const request = this.fetchCampaigns()
      .then((campaigns) => {
        this.cached = { campaigns, fetchedAt: Date.now() };
        return campaigns;
      })
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        const stale = this.cached;
        if (stale !== null) {
          const age = Math.round((Date.now() - stale.fetchedAt) / 1000);
          this.logger.warn(
            `Tracker refresh failed (${reason}) — serving the cached list, ${age}s old.`,
          );
          return stale.campaigns;
        }
        this.logger.error(`Tracker campaign list unavailable: ${reason}`);
        throw new ServiceUnavailableException(
          "The campaign tracker is unavailable. Please try again shortly.",
        );
      })
      .finally(() => {
        this.refreshing = null;
      });

    this.refreshing = request;
    return request;
  }

  /** One upstream round trip. Throws on anything that is not a usable list. */
  private async fetchCampaigns(): Promise<TrackerCampaign[]> {
    const response = await fetch(TRACKER_LIST_URL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`tracker responded with HTTP ${response.status}`);
    }

    const payload: unknown = await response.json();
    return parseTrackerCampaigns(payload);
  }
}

/**
 * Maps the upstream payload onto TrackerCampaign[].
 *
 * The upstream is not ours, so nothing about the shape is assumed: a response
 * that is not `{ data: [...] }` is rejected outright (the caller then falls
 * back to the stale cache), while individual entries that cannot produce an
 * id are dropped rather than poisoning the whole list.
 */
function parseTrackerCampaigns(payload: unknown): TrackerCampaign[] {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("tracker response was not a JSON object");
  }

  const { data } = payload as { data?: unknown };
  if (!Array.isArray(data)) {
    throw new Error("tracker response had no `data` array");
  }

  const campaigns: TrackerCampaign[] = [];
  const seen = new Set<string>();

  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) continue;

    const { campaign_id: rawId, campaign_name: rawName } = entry as {
      campaign_id?: unknown;
      campaign_name?: unknown;
    };

    // The id is the key: an entry without one is unusable, so drop it.
    if (typeof rawId !== "string") continue;
    const id = rawId.trim();
    if (id.length === 0 || seen.has(id)) continue;

    // Several upstream names carry stray whitespace (" Ikkis", "AJIO ORM ").
    const name = typeof rawName === "string" ? rawName.trim() : "";

    seen.add(id);
    // Fall back to the id so every option still renders as something.
    campaigns.push({ id, name: name.length > 0 ? name : id });
  }

  return campaigns;
}

/**
 * Maps the upstream posts payload onto TrackerReel[].
 *
 * Same discipline as parseTrackerCampaigns: a response that is not the shape
 * we expect throws, while an individual record that cannot produce a usable
 * reel is dropped rather than poisoning the page. Upstream is a third party
 * and its records vary — some posts carry no media, some carry several.
 */
/** The post rows of one page. Throws rather than guessing at a changed shape. */
export function postRowsOf(payload: unknown): unknown[] {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("tracker response was not a JSON object");
  }
  const { data } = payload as { data?: { records?: unknown } };
  const records = data?.records;
  if (!Array.isArray(records)) {
    throw new Error("tracker response had no `data.records` array");
  }
  return records;
}

/**
 * The upstream's count of posts on the campaign.
 *
 * Zero when it is missing, which stops paging after the first short page
 * rather than trusting a number that is not there.
 */
export function totalCountOf(payload: unknown): number {
  if (typeof payload !== "object" || payload === null) return 0;
  const { data } = payload as { data?: { totalCount?: unknown } };
  const total = data?.totalCount;
  return typeof total === "number" && Number.isFinite(total) ? total : 0;
}

export function parseTrackerReels(records: readonly unknown[]): TrackerReel[] {
  const reels: TrackerReel[] = [];
  const seen = new Set<string>();

  for (const entry of records) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as Record<string, unknown>;

    // Reels only: they are the single-video posts, so one reel maps to exactly
    // one thing to fingerprint. A carousel has several and a story has none.
    if (row.post_type !== REEL_POST_TYPE) continue;

    const trackerPostId = typeof row.id === "string" ? row.id : null;
    if (trackerPostId === null || seen.has(trackerPostId)) continue;

    const mediaUrl = firstVideoUrl(row.media_urls);
    if (mediaUrl === null) continue;

    const socialUsername =
      typeof row.social_username === "string" ? row.social_username.trim() : "";
    const username = handleFrom(socialUsername);
    if (username === null) continue;

    seen.add(trackerPostId);
    reels.push({
      trackerPostId,
      socialUsername,
      username,
      permalink: typeof row.message === "string" ? row.message : null,
      mediaUrl,
      postedAt: parseDate(row.postDate),
      postCounts: row.post_counts ?? null,
      caption: typeof row.caption === "string" ? row.caption : null,
      invoiceApproved: row.invoice_approved === true,
    });
  }

  return reels;
}

/** The first playable video in a post's media list, if it has one. */
function firstVideoUrl(mediaUrls: unknown): string | null {
  if (!Array.isArray(mediaUrls)) return null;
  for (const url of mediaUrls) {
    if (typeof url !== "string") continue;
    const lower = url.toLowerCase();
    if (lower.endsWith(".mp4") || lower.endsWith(".mov")) return url;
  }
  return null;
}

/**
 * The handle from a profile URL.
 *
 * Upstream sends "https://instagram.com/cric_bold", but tolerate a bare handle
 * and a leading "@" too — it is a third party, and one of the three forms will
 * turn up eventually. Lowercased, because the handle is the grouping key and
 * Instagram treats it case-insensitively.
 */
export function handleFrom(socialUsername: string): string | null {
  const trimmed = socialUsername.trim().replace(/\/+$/, "");
  if (trimmed.length === 0) return null;

  const afterSlash = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  const handle = afterSlash.replace(/^@/, "").split("?")[0] ?? "";
  return handle.length === 0 ? null : handle.toLowerCase();
}

/** An upstream date, or null when it sent nothing usable. */
function parseDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
