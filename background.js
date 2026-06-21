// Channel Age Watchdog — background (event page)
// M4: open the Options page on behalf of the content script (content scripts can't
// call openOptionsPage() themselves, and Firefox blocks navigating to
// moz-extension:// links from web content).
// M5: resolve a detected channel via the YouTube Data API v3 channels.list endpoint
// and apply the publishing-rate heuristic. All network calls live here so the API
// key never touches the page; it is sent only to Google's API, never anywhere else.

const API_BASE = "https://www.googleapis.com/youtube/v3/channels";

// Prefix all background logs so the cache/API activity is easy to spot in the
// add-on's "Inspect" console during the demo.
const LOG = "[Watchdog]";

// Heuristic thresholds are user-configurable as of M7; their defaults and the
// getSettings() loader live in settings.js (loaded before this file).
const MS_PER_DAY = 86400000;

// M6: cache channel facts so revisiting a channel costs no API call. We store the
// raw facts (not the verdict) and recompute the verdict on every read, so the cache
// stays correct as channels age and as thresholds change (M7). Entries older than
// the TTL are refreshed; if the refresh fails (quota/network) we fall back to the
// stale entry rather than break the badge.
const CACHE_PREFIX = "cache:";
const CACHE_TTL_MS = 7 * MS_PER_DAY;

// Key a cache entry by the same identity the content script detects. Vanity /c/
// paths have no channels.list selector, so they are never looked up or cached.
function cacheKeyFor(channel) {
  if (!channel || !channel.kind || !channel.value) return null;
  if (!lookupParam(channel)) return null;
  return `${CACHE_PREFIX}${channel.kind}:${channel.value}`;
}

// Read a raw cache entry (or null). Storage failures degrade to a cache miss.
async function getCacheEntry(key) {
  if (!key) return null;
  try {
    const stored = await browser.storage.local.get(key);
    return stored[key] || null;
  } catch {
    return null;
  }
}

function isFresh(entry) {
  return Boolean(entry) && Date.now() - entry.cachedAt <= CACHE_TTL_MS;
}

// M10 added viewCount/subscriberCount to a found entry's facts. An entry cached before
// M10 lacks them, so its verdict can only report "unknown" engagement. Treat such an
// entry as needing a refresh (re-fetch on next visit) rather than serving it as a fresh
// hit forever. "not found" entries carry no facts and are always complete.
function hasEngagementFacts(entry) {
  return Boolean(entry) && (entry.found === false || (entry.facts && "viewCount" in entry.facts));
}

// Best-effort write; caching is an optimisation, so storage failures are ignored.
async function writeCache(key, entry) {
  if (!key) return;
  try {
    await browser.storage.local.set({ [key]: { ...entry, cachedAt: Date.now() } });
  } catch {
    // ignore — never break a lookup just because we couldn't cache it
  }
}

// Turn a cache entry into the same result shape lookupChannel returns. `stale` marks
// a fallback served because the live refresh failed, so the badge can hint at it. The
// verdict is recomputed against the current settings, so changing a threshold (M7)
// re-flags a cached channel on the next visit without any API call.
function verdictFromCache(entry, stale, settings, trusted, blocked) {
  if (entry.found === false) return { ok: true, found: false, cached: true, stale };
  return { ...evaluate(entry.facts, settings, trusted, blocked), cached: true, stale };
}

// Map a detected channel to the channels.list selector it needs. Handles carry
// their leading "@" (forHandle accepts it). Legacy /c/ vanity URLs have no direct
// channels.list selector, so we report them as unsupported rather than guess.
function lookupParam(channel) {
  switch (channel && channel.kind) {
    case "id":
      return { id: channel.value };
    case "handle":
      return { forHandle: channel.value };
    case "user":
      return { forUsername: channel.value };
    default:
      return null;
  }
}

// Apply the publishing-rate heuristic to a channel's raw facts, using the user's
// configured thresholds (M7). Kept separate from fetching so it can run on both fresh
// API data and cached facts; age and the per-video metrics are always recomputed
// against "now" so a cached entry never reports a stale age. The thresholds used are
// echoed back so the detail popup can show "rate vs threshold". A channel on the user's
// trust allowlist (M8.5) is never flagged regardless of its rate, and is marked
// `trusted` so the badge can reflect it. Conversely, a channel on the user's manual
// blocklist is always flagged regardless of its rate, and marked `manuallyFlagged`.
// The two lists are mutually exclusive (settings.js); trust wins by construction.
//
// M10: a channel is flagged only when all three conditions hold at once (logical AND):
//   1. high publishing rate — ratio = videoCount / ageDays > ratioThreshold (the gate)
//   2. low views per video  — viewCount / videoCount < maxViewsPerVideo
//   3. low subs per video   — subscriberCount / videoCount < maxSubsPerVideo
// AND-ing the two engagement floors onto the rate lets old prolific legit channels
// escape while still catching high-volume low-engagement slop. A view metric we can't
// compute (videoCount 0, or viewCount absent) counts as not-met, so an unknown there
// never flags — we favour a false negative over a false positive.
//
// A *hidden* subscriber count is the exception: hiding the count is itself a weak
// slop-adjacent signal, and since we only ever warn (never hide/block), a false warning
// is cheap. So a hidden count counts as "low subs" (condition 3 met) rather than a free
// pass. Conditions 1 and 2 still gate the flag, so a legit channel that hides its count
// but has real views and a sane publishing rate is unaffected.
function evaluate(facts, settings, trusted, blocked) {
  const { channelId, title, publishedAt, videoCount, viewCount, subscriberCount, hiddenSubscriberCount } =
    facts;
  const ageDays = (Date.now() - new Date(publishedAt).getTime()) / MS_PER_DAY;
  const ratio = ageDays > 0 ? videoCount / ageDays : Infinity;

  const viewsPerVideo = videoCount > 0 && Number.isFinite(viewCount) ? viewCount / videoCount : null;
  const subsPerVideo =
    videoCount > 0 && !hiddenSubscriberCount && Number.isFinite(subscriberCount)
      ? subscriberCount / videoCount
      : null;

  const highRate = ratio > settings.ratioThreshold;
  const lowViews = viewsPerVideo != null && viewsPerVideo < settings.maxViewsPerVideo;
  const lowSubs =
    hiddenSubscriberCount || (subsPerVideo != null && subsPerVideo < settings.maxSubsPerVideo);

  const isTrusted = Boolean(trusted && trusted[channelId]);
  const isManuallyFlagged = !isTrusted && Boolean(blocked && blocked[channelId]);
  const heuristicFlag = highRate && lowViews && lowSubs;
  const flagged = !isTrusted && (isManuallyFlagged || heuristicFlag);

  return {
    ok: true,
    found: true,
    flagged,
    trusted: isTrusted,
    manuallyFlagged: isManuallyFlagged,
    reason: isTrusted ? "trusted" : isManuallyFlagged ? "manual" : heuristicFlag ? "rate" : null,
    channelId,
    title,
    publishedAt,
    videoCount,
    ageDays,
    ratio: Number.isFinite(ratio) ? ratio : null,
    viewsPerVideo,
    subsPerVideo,
    hiddenSubscriberCount: Boolean(hiddenSubscriberCount),
    thresholds: {
      ratio: settings.ratioThreshold,
      maxViewsPerVideo: settings.maxViewsPerVideo,
      maxSubsPerVideo: settings.maxSubsPerVideo,
    },
  };
}

// Look up a channel and decide whether the publishing rate is suspicious. Returns a
// plain object the content script can render. Never throws: on any failure it returns
// { ok: false, ... } so the page is never broken. M6: serve a fresh cache hit without
// any API call, and fall back to a stale cache entry when the live refresh fails.
async function lookupChannel(channel) {
  const settings = await getSettings();
  const trusted = await getTrustedChannels();
  const blocked = await getFlaggedChannels();
  const cacheKey = cacheKeyFor(channel);
  const cached = await getCacheEntry(cacheKey);
  if (isFresh(cached) && hasEngagementFacts(cached)) {
    console.log(`${LOG} cache hit (no API call):`, cacheKey);
    return verdictFromCache(cached, false, settings, trusted, blocked);
  }

  let apiKey;
  try {
    const stored = await browser.storage.local.get("apiKey");
    apiKey = stored.apiKey;
  } catch (err) {
    if (cached) return verdictFromCache(cached, true, settings, trusted, blocked);
    return { ok: false, reason: "storage", message: err.message };
  }
  // Missing/invalid key is a silent no-op: serve any stale cache, else say so.
  if (!apiKey) {
    if (cached) {
      console.warn(`${LOG} no API key, serving stale cache:`, cacheKey);
      return verdictFromCache(cached, true, settings, trusted, blocked);
    }
    return { ok: false, reason: "noKey" };
  }

  const param = lookupParam(channel);
  if (!param) return { ok: false, reason: "unsupported" };

  const params = new URLSearchParams({
    part: "snippet,statistics",
    key: apiKey,
    ...param,
  });

  let response;
  let data;
  try {
    console.log(`${LOG} API call:`, cacheKey || channel);
    response = await fetch(`${API_BASE}?${params.toString()}`);
    data = await response.json();
  } catch (err) {
    if (cached) {
      console.warn(`${LOG} network error, serving stale cache:`, cacheKey);
      return verdictFromCache(cached, true, settings, trusted, blocked);
    }
    return { ok: false, reason: "network", message: err.message };
  }

  // Quota exceeded / invalid key / any API error: prefer a stale cache over breaking.
  if (!response.ok) {
    if (cached) {
      console.warn(`${LOG} API error ${response.status}, serving stale cache:`, cacheKey);
      return verdictFromCache(cached, true, settings, trusted, blocked);
    }
    return {
      ok: false,
      reason: "apiError",
      status: response.status,
      message: data && data.error && data.error.message,
    };
  }

  const item = data.items && data.items[0];
  const publishedAt = item && item.snippet && item.snippet.publishedAt;
  const stats = (item && item.statistics) || {};
  const videoCount = Number(stats.videoCount);
  if (!item || !publishedAt || !Number.isFinite(videoCount)) {
    await writeCache(cacheKey, { found: false });
    return { ok: true, found: false };
  }

  // viewCount/subscriberCount already come back in the part=statistics response, so
  // caching them for the M10 engagement floors adds zero quota. subscriberCount is
  // omitted when the channel hides it; hiddenSubscriberCount records that case.
  const facts = {
    channelId: item.id,
    title: (item.snippet && item.snippet.title) || channel.value,
    publishedAt,
    videoCount,
    viewCount: Number(stats.viewCount),
    subscriberCount: Number(stats.subscriberCount),
    hiddenSubscriberCount: Boolean(stats.hiddenSubscriberCount),
  };
  await writeCache(cacheKey, { found: true, facts });
  return evaluate(facts, settings, trusted, blocked);
}

// M11: validate a key with a single witness channels.list call (1 unit, same cost as
// a normal lookup). We only care whether the request is accepted, so we ask for the
// cheapest part and filter by a stable, well-known channel id — the response body is
// irrelevant. Returns a small status the Options page can render. Never throws.
//   valid   — the key works
//   quota   — key is fine but today's quota is spent (403 quotaExceeded)
//   invalid — anything else the API rejects (bad key, API not enabled, …); the API's
//             own message is passed through so the user can act on it
//   network — the request never reached Google
const WITNESS_CHANNEL_ID = "UC_x5XG1OV2P6uZZ5FSM9Ttw"; // Google Developers — stable
const QUOTA_REASONS = new Set(["quotaExceeded", "dailyLimitExceeded", "rateLimitExceeded"]);

async function testApiKey(key) {
  const apiKey = (key || "").trim();
  if (!apiKey) return { state: "unset" };

  const params = new URLSearchParams({
    part: "id",
    id: WITNESS_CHANNEL_ID,
    key: apiKey,
  });

  let response;
  let data;
  try {
    console.log(`${LOG} testing API key (witness channels.list call)`);
    response = await fetch(`${API_BASE}?${params.toString()}`);
    data = await response.json();
  } catch (err) {
    return { state: "network", message: err.message };
  }

  if (response.ok) return { state: "valid" };

  const error = data && data.error;
  const reason = error && error.errors && error.errors[0] && error.errors[0].reason;
  if (response.status === 403 && QUOTA_REASONS.has(reason)) {
    return { state: "quota" };
  }
  return {
    state: "invalid",
    status: response.status,
    message: (error && error.message) || `HTTP ${response.status}`,
  };
}

// Returning a promise from the listener sends its resolved value back to the sender.
browser.runtime.onMessage.addListener((message) => {
  if (!message) return;
  if (message.type === "openOptions") {
    return browser.runtime.openOptionsPage();
  }
  if (message.type === "lookupChannel") {
    return lookupChannel(message.channel);
  }
  if (message.type === "testApiKey") {
    return testApiKey(message.key);
  }
});
