// Channel Age Watchdog — background (event page)
// M4: open the Options page on behalf of the content script (content scripts can't
// call openOptionsPage() themselves, and Firefox blocks navigating to
// moz-extension:// links from web content).
// M5: resolve a detected channel via the YouTube Data API v3 channels.list endpoint
// and apply the publishing-rate heuristic. All network calls live here so the API
// key never touches the page; it is sent only to Google's API, never anywhere else.

const API_BASE = "https://www.googleapis.com/youtube/v3/channels";

// Default heuristic thresholds. M7 will make these configurable.
const RATIO_THRESHOLD = 1.0; // sustained videos/day since creation
const NEW_AGE_DAYS = 30; // "brand new" cutoff for the absolute rule
const NEW_MIN_VIDEOS = 50; // min videos for the new-channel rule
const MS_PER_DAY = 86400000;

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

// Look up a channel and decide whether the publishing rate is suspicious. Returns a
// plain object the content script can render. Never throws: on any failure it returns
// { ok: false, ... } so the page is never broken (graceful no-op is hardened in M6).
async function lookupChannel(channel) {
  let apiKey;
  try {
    const stored = await browser.storage.local.get("apiKey");
    apiKey = stored.apiKey;
  } catch (err) {
    return { ok: false, reason: "storage", message: err.message };
  }
  if (!apiKey) return { ok: false, reason: "noKey" };

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
    response = await fetch(`${API_BASE}?${params.toString()}`);
    data = await response.json();
  } catch (err) {
    return { ok: false, reason: "network", message: err.message };
  }

  if (!response.ok) {
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
    return { ok: true, found: false };
  }

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
    channelId: item.id,
    title: (item.snippet && item.snippet.title) || channel.value,
    publishedAt,
    videoCount,
    ageDays,
    ratio: Number.isFinite(ratio) ? ratio : null,
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
});
