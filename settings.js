// Channel Age Watchdog — shared settings (defaults + loader)
// M7: heuristic thresholds and badge-visibility preferences are user-configurable.
// This file is loaded FIRST in every context (background event page, content script,
// options page) so DEFAULT_SETTINGS / getSettings() are available to the script that
// follows. No build step, so a shared global file keeps the defaults in one place.

const SETTINGS_KEY = "settings";

// Defaults mirror the original hardcoded heuristic (M5) and "show every badge".
const DEFAULT_SETTINGS = {
  ratioThreshold: 1.0, // suspicious sustained videos/day since creation
  // M10: engagement floors. A channel is flagged only when its publishing rate is high
  // AND both of these per-video averages fall below their threshold (logical AND). Both
  // are cumulative-lifetime metrics, so they favour older channels; defaults are tunable
  // and niche/region-dependent — revisit as needed.
  maxViewsPerVideo: 1000, // flag only if average views per video is below this
  maxSubsPerVideo: 10, // flag only if average subscribers per video is below this
  scanFeed: false, // false = watch pages only; true = also scan feeds (M8)
  showFlagged: true, // ⚠️ suspicious publishing rate
  showLegit: true, // ✅ looks legit
  showNeutral: true, // ❔ no verdict (no key, error, unsupported, not found)
};

// Coerce a stored number, falling back to the default for blank/invalid/non-positive
// values so a bad entry can never disable the heuristic.
function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Read settings merged over defaults. Storage failures degrade to defaults so the
// extension still works. Numeric fields are sanitised; booleans come straight from
// storage (the options page only ever writes real booleans).
async function getSettings() {
  let stored = {};
  try {
    const got = await browser.storage.local.get(SETTINGS_KEY);
    stored = got[SETTINGS_KEY] || {};
  } catch {
    // ignore — fall back to defaults
  }
  const merged = { ...DEFAULT_SETTINGS, ...stored };
  merged.ratioThreshold = positiveNumber(merged.ratioThreshold, DEFAULT_SETTINGS.ratioThreshold);
  merged.maxViewsPerVideo = positiveNumber(merged.maxViewsPerVideo, DEFAULT_SETTINGS.maxViewsPerVideo);
  merged.maxSubsPerVideo = positiveNumber(merged.maxSubsPerVideo, DEFAULT_SETTINGS.maxSubsPerVideo);
  return merged;
}

// --- Trusted channels (M8.5) ---------------------------------------------------
// A user allowlist of channels that should never be flagged. Kept separate from
// `settings` so it can grow without bloating that object. Keyed by the canonical
// channel ID (UC…) — the most stable identity, available on every found result —
// so a channel stays trusted whether reached via its handle, ID, or legacy URL.
// Each entry stores the title (for the Options list) and when it was added.
const TRUSTED_KEY = "trusted";

// Read the trusted-channel map ({ channelId: { title, addedAt } }). Storage failures
// degrade to "nothing trusted" so the extension still works.
async function getTrustedChannels() {
  try {
    const got = await browser.storage.local.get(TRUSTED_KEY);
    return got[TRUSTED_KEY] || {};
  } catch {
    return {};
  }
}

// Add a channel to the allowlist. No-op without a channel ID (we can't key it).
async function trustChannel(channelId, info) {
  if (!channelId) return;
  const map = await getTrustedChannels();
  map[channelId] = { title: (info && info.title) || channelId, addedAt: Date.now() };
  await browser.storage.local.set({ [TRUSTED_KEY]: map });
}

// Remove a channel from the allowlist.
async function untrustChannel(channelId) {
  const map = await getTrustedChannels();
  if (channelId in map) {
    delete map[channelId];
    await browser.storage.local.set({ [TRUSTED_KEY]: map });
  }
}
