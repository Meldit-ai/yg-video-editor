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

/** Upstream feed of currently-active tracker campaigns. No auth today. */
const TRACKER_LIST_URL =
  "https://api-tracker.meldit.ai/api/v1/campaign/active/list-id-name";

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
