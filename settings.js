// Channel Age Watchdog — shared settings (defaults + loader)
// M7: heuristic thresholds and badge-visibility preferences are user-configurable.
// This file is loaded FIRST in every context (background event page, content script,
// options page) so DEFAULT_SETTINGS / getSettings() are available to the script that
// follows. No build step, so a shared global file keeps the defaults in one place.

const SETTINGS_KEY = "settings";

// Defaults mirror the original hardcoded heuristic (M5) and "show every badge".
const DEFAULT_SETTINGS = {
  ratioThreshold: 1.0, // suspicious sustained videos/day since creation
  newAgeDays: 30, // "brand new" cutoff for the absolute rule (days)
  newMinVideos: 50, // min videos for the new-channel rule
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
  merged.newAgeDays = positiveNumber(merged.newAgeDays, DEFAULT_SETTINGS.newAgeDays);
  merged.newMinVideos = positiveNumber(merged.newMinVideos, DEFAULT_SETTINGS.newMinVideos);
  return merged;
}
