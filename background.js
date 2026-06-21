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

// Default heuristic thresholds. M7 will make these configurable.
const RATIO_THRESHOLD = 1.0; // sustained videos/day since creation
const NEW_AGE_DAYS = 30; // "brand new" cutoff for the absolute rule
const NEW_MIN_VIDEOS = 50; // min videos for the new-channel rule
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
// a fallback served because the live refresh failed, so the badge can hint at it.
function verdictFromCache(entry, stale) {
  if (entry.found === false) return { ok: true, found: false, cached: true, stale };
  return { ...evaluate(entry.facts), cached: true, stale };
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

// Apply the publishing-rate heuristic to a channel's raw facts. Kept separate from
// fetching so it can run on both fresh API data and cached facts; age and ratio are
// always recomputed against "now" so a cached entry never reports a stale age.
function evaluate(facts) {
  const { channelId, title, publishedAt, videoCount } = facts;
  const ageDays = (Date.now() - new Date(publishedAt).getTime()) / MS_PER_DAY;
  const ratio = ageDays > 0 ? videoCount / ageDays : Infinity;
  const flaggedByRate = ratio > RATIO_THRESHOLD;
  const flaggedByNew = ageDays < NEW_AGE_DAYS && videoCount > NEW_MIN_VIDEOS;
  const flagged = flaggedByRate || flaggedByNew;

  return {
    ok: true,
    found: true,
    flagged,
    reason: flaggedByNew ? "new+volume" : flaggedByRate ? "rate" : null,
    channelId,
    title,
    publishedAt,
    videoCount,
    ageDays,
    ratio: Number.isFinite(ratio) ? ratio : null,
  };
}

// Look up a channel and decide whether the publishing rate is suspicious. Returns a
// plain object the content script can render. Never throws: on any failure it returns
// { ok: false, ... } so the page is never broken. M6: serve a fresh cache hit without
// any API call, and fall back to a stale cache entry when the live refresh fails.
async function lookupChannel(channel) {
  const cacheKey = cacheKeyFor(channel);
  const cached = await getCacheEntry(cacheKey);
  if (isFresh(cached)) {
    console.log(`${LOG} cache hit (no API call):`, cacheKey);
    return verdictFromCache(cached, false);
  }

  let apiKey;
  try {
    const stored = await browser.storage.local.get("apiKey");
    apiKey = stored.apiKey;
  } catch (err) {
    if (cached) return verdictFromCache(cached, true);
    return { ok: false, reason: "storage", message: err.message };
  }
  // Missing/invalid key is a silent no-op: serve any stale cache, else say so.
  if (!apiKey) {
    if (cached) {
      console.warn(`${LOG} no API key, serving stale cache:`, cacheKey);
      return verdictFromCache(cached, true);
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
      return verdictFromCache(cached, true);
    }
    return { ok: false, reason: "network", message: err.message };
  }

  // Quota exceeded / invalid key / any API error: prefer a stale cache over breaking.
  if (!response.ok) {
    if (cached) {
      console.warn(`${LOG} API error ${response.status}, serving stale cache:`, cacheKey);
      return verdictFromCache(cached, true);
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
  const videoCount = Number(item && item.statistics && item.statistics.videoCount);
  if (!item || !publishedAt || !Number.isFinite(videoCount)) {
    await writeCache(cacheKey, { found: false });
    return { ok: true, found: false };
  }

  const facts = {
    channelId: item.id,
    title: (item.snippet && item.snippet.title) || channel.value,
    publishedAt,
    videoCount,
  };
  await writeCache(cacheKey, { found: true, facts });
  return evaluate(facts);
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
});
