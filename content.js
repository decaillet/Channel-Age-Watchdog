// Channel Age Watchdog — content script
// M3: detect the real channel from the watch page DOM, surviving SPA navigation.
// M5: ask the background page to evaluate the channel via the YouTube Data API and
// show the badge with real numbers only when the publishing rate is flagged.
console.log("Watchdog loaded");

const BADGE_ID = "caw-badge";
const POPUP_ID = "caw-popup";
const NOTICE_ID = "caw-notice";

// The settings in effect for the current evaluation (thresholds echoed back by the
// background page live on the result; these drive per-verdict badge visibility and
// the detail popup). Reloaded on every evaluation so Options changes apply on the
// next navigation without reloading the add-on.
let currentSettings = DEFAULT_SETTINGS;

// The channel we've already evaluated for the current page, keyed as "kind:value".
// Skipping re-evaluation of the same channel avoids both redundant API calls and a
// feedback loop where our own badge mutation re-triggers the MutationObserver.
let currentChannelKey = null;
// Bumped on each lookup so a slow response for a channel the user has already
// navigated away from is ignored instead of painting a stale badge.
let lookupToken = 0;

// Once the user dismisses the "no API key" notice (or we open the Options page for
// them), don't re-nag for the rest of this page session. Not persisted: after a real
// chance to set the key it can resurface on the next fresh load.
let noticeDismissed = false;

// Show a small, non-blocking notice when no API key is configured yet. It links to
// the Options page (via the background event page, since content scripts can't open
// it directly). M5 uses the key for real lookups; until then this just points there.
async function maybeShowKeyNotice() {
  if (noticeDismissed || document.getElementById(NOTICE_ID)) return;

  let hasKey = false;
  try {
    const stored = await browser.storage.local.get("apiKey");
    hasKey = Boolean(stored.apiKey);
  } catch {
    return; // storage unavailable — stay silent, never break the page
  }
  if (hasKey || noticeDismissed || document.getElementById(NOTICE_ID)) return;

  const notice = document.createElement("div");
  notice.id = NOTICE_ID;
  Object.assign(notice.style, {
    position: "fixed",
    right: "16px",
    bottom: "16px",
    zIndex: "2147483647",
    maxWidth: "320px",
    padding: "12px 14px",
    borderRadius: "10px",
    background: "#212121",
    color: "#fff",
    fontSize: "13px",
    lineHeight: "1.4",
    boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
    fontFamily: "system-ui, -apple-system, sans-serif",
  });

  const text = document.createElement("div");
  text.textContent =
    "Channel Age Watchdog needs a YouTube Data API key to flag channels.";
  notice.appendChild(text);

  const actions = document.createElement("div");
  Object.assign(actions.style, {
    display: "flex",
    gap: "8px",
    marginTop: "10px",
  });

  const setup = document.createElement("button");
  setup.textContent = "Set it up";
  Object.assign(setup.style, {
    cursor: "pointer",
    border: "none",
    borderRadius: "6px",
    padding: "5px 10px",
    fontSize: "12px",
    fontWeight: "600",
    background: "#c62828",
    color: "#fff",
  });
  setup.addEventListener("click", () => {
    browser.runtime.sendMessage({ type: "openOptions" });
    noticeDismissed = true;
    notice.remove();
  });

  const dismiss = document.createElement("button");
  dismiss.textContent = "Dismiss";
  Object.assign(dismiss.style, {
    cursor: "pointer",
    border: "1px solid #555",
    borderRadius: "6px",
    padding: "5px 10px",
    fontSize: "12px",
    background: "transparent",
    color: "#fff",
  });
  dismiss.addEventListener("click", () => {
    noticeDismissed = true;
    notice.remove();
  });

  actions.appendChild(setup);
  actions.appendChild(dismiss);
  notice.appendChild(actions);
  document.body.appendChild(notice);
}

// Parse a channel identity out of an href. YouTube uses either a handle URL
// (/@SomeHandle) or a canonical channel URL (/channel/UC…), and occasionally legacy
// /c/ or /user/ vanity paths. Returns the first match, or null for anything else
// (notably /watch links, which lets the feed scanner ignore the video link itself).
// Shared by the watch-page detector and the M8 feed scanner.
function parseChannelHref(href) {
  const path = (href || "").replace(/^https?:\/\/[^/]+/, ""); // strip origin if absolute

  let match;
  if ((match = path.match(/^\/(@[^/?#]+)/))) {
    return { kind: "handle", value: match[1] };
  }
  if ((match = path.match(/^\/channel\/(UC[^/?#]+)/))) {
    return { kind: "id", value: match[1] };
  }
  if ((match = path.match(/^\/user\/([^/?#]+)/))) {
    return { kind: "user", value: match[1] };
  }
  if ((match = path.match(/^\/c\/([^/?#]+)/))) {
    return { kind: "vanity", value: match[1] };
  }
  return null;
}

// Pull the channel identity out of the watch page's owner renderer link.
function detectChannel() {
  const link = document.querySelector(
    "ytd-video-owner-renderer #channel-name a, ytd-video-owner-renderer a.yt-simple-endpoint"
  );
  if (!link) return null;
  return parseChannelHref(link.getAttribute("href"));
}

// Render a channel age for humans: days while a channel is young (the case that
// matters for the heuristic), then months, then years as it gets older.
function formatAge(days) {
  const whole = Math.max(0, Math.round(days));
  if (whole < 1) return "under a day";
  if (whole === 1) return "1 day";
  if (whole < 90) return `${whole} days`;
  const months = Math.round(days / 30.44);
  if (months < 24) return `${months} months`;
  return `${(days / 365.25).toFixed(1).replace(/\.0$/, "")} years`;
}

// Build the (empty) badge element. Colour and content are set per-result in showBadge.
function createBadge() {
  const badge = document.createElement("span");
  badge.id = BADGE_ID;
  Object.assign(badge.style, {
    display: "inline-flex",
    alignItems: "center",
    marginLeft: "8px",
    padding: "2px 8px",
    borderRadius: "12px",
    color: "#fff",
    fontSize: "12px",
    fontWeight: "600",
    lineHeight: "1.4",
    whiteSpace: "nowrap",
    verticalAlign: "middle",
    cursor: "pointer",
  });
  return badge;
}

// Get or create the badge inside the owner element, wiring its click-to-popup
// handler exactly once. The latest result is stashed on the element so the popup
// renders from whatever verdict is currently showing.
function ensureBadge(owner) {
  let badge = document.getElementById(BADGE_ID);
  if (badge) return badge;
  badge = createBadge();
  badge.addEventListener("click", (event) => {
    event.stopPropagation(); // don't let the outside-click handler immediately close it
    toggleDetailPopup(badge);
  });
  owner.appendChild(badge);
  return badge;
}

// Classify a found result into its verdict, returning the bits both the badge and the
// detail popup need: icon, colour, a one-line summary, and the kind used to decide
// per-verdict visibility (M7).
function verdictInfo(result) {
  if (result.trusted) {
    return {
      kind: "trusted",
      icon: "🛡️",
      color: "#1565c0",
      summary: "Trusted by you — never flagged regardless of publishing rate",
    };
  }
  if (result.flagged) {
    return {
      kind: "flagged",
      icon: "⚠️",
      color: "#c62828",
      summary: "Flagged: high sustained publishing rate (publishing pattern, not AI detection)",
    };
  }
  return {
    kind: "legit",
    icon: "✅",
    color: "#2e7d32",
    summary: "Looks legit: publishing rate within normal range",
  };
}

// Show the badge with the real numbers. ⚠️ (red) for a suspicious publishing rate,
// ✅ (green) when it looks legit. Inserted next to the channel name; clicking it opens
// the detail popup (M7) with the full breakdown.
function showBadge(result) {
  const owner = document.querySelector("ytd-video-owner-renderer #channel-name");
  if (!owner) return;

  const verdict = verdictInfo(result);
  const ageText = formatAge(result.ageDays);

  const badge = ensureBadge(owner);
  badge._result = result;
  const staleNote = result.stale ? " (cached, could not refresh)" : "";

  badge.style.background = verdict.color;
  badge.textContent = `${verdict.icon} ${result.videoCount} videos in ${ageText}`;
  badge.title = `Channel Age Watchdog — ${result.title}\nClick for details${staleNote}`;
}

// Explain, in a few words, why we have no verdict for this channel.
function neutralMessage(result) {
  switch (result && result.reason) {
    case "noKey":
      return "no API key set";
    case "unsupported":
      return "channel type not supported";
    case "apiError":
      return `API error${result.status ? ` (${result.status})` : ""}`;
    case "network":
      return "network error";
    case "storage":
      return "storage unavailable";
    default:
      return result && result.found === false ? "channel not found" : "unavailable";
  }
}

// Show a neutral (grey) badge when there's no verdict to give: missing key, API
// error, unsupported channel, or not found. Keeps a badge present at all times.
function showNeutralBadge(result) {
  const owner = document.querySelector("ytd-video-owner-renderer #channel-name");
  if (!owner) return;

  const message = neutralMessage(result);
  const badge = ensureBadge(owner);
  badge._result = result;
  badge.style.background = "#616161";
  badge.textContent = `❔ ${message}`;
  badge.title = `Channel Age Watchdog — ${message}\nClick for details`;
}

// One "label / value" line for the detail popup.
function popupRow(label, value) {
  const row = document.createElement("div");
  Object.assign(row.style, {
    display: "flex",
    justifyContent: "space-between",
    gap: "16px",
  });
  const l = document.createElement("span");
  l.textContent = label;
  l.style.color = "#aaa";
  const v = document.createElement("span");
  v.textContent = value;
  v.style.fontWeight = "600";
  v.style.textAlign = "right";
  row.append(l, v);
  return row;
}

// A small outline button for the popup action row (trust / adjust settings).
function popupButton(label) {
  const btn = document.createElement("button");
  btn.textContent = label;
  Object.assign(btn.style, {
    cursor: "pointer",
    border: "1px solid #555",
    borderRadius: "6px",
    padding: "5px 10px",
    fontSize: "12px",
    fontWeight: "600",
    background: "transparent",
    color: "#fff",
  });
  return btn;
}

// Toggle the detail popup for the badge: clicking the badge again closes it.
function toggleDetailPopup(badge) {
  if (document.getElementById(POPUP_ID)) {
    removePopup();
    return;
  }
  showDetailPopup(badge);
}

// Build the breakdown rows from a found result (the case the M7 demo cares about:
// channel age, video count, ratio vs the configured threshold).
function foundPopupRows(result) {
  const rows = [popupRow("Videos", String(result.videoCount)), popupRow("Channel age", formatAge(result.ageDays))];

  const t = result.thresholds || {};
  const ratioText = result.ratio != null ? `~${result.ratio.toFixed(2)}/day` : "very high";
  const thresholdText = t.ratio != null ? ` (threshold ${t.ratio}/day)` : "";
  rows.push(popupRow("Publishing rate", `${ratioText}${thresholdText}`));

  if (result.publishedAt) {
    rows.push(popupRow("Created", new Date(result.publishedAt).toLocaleDateString()));
  }
  return rows;
}

// Open the detail popup anchored under the badge. Renders from the result stashed on
// the badge, so it works for both a found verdict and a neutral ❔ badge. Closes on
// outside click, Escape, or scroll.
function showDetailPopup(badge) {
  const result = badge._result;
  if (!result) return;

  const popup = document.createElement("div");
  popup.id = POPUP_ID;
  Object.assign(popup.style, {
    position: "fixed",
    zIndex: "2147483647",
    width: "280px",
    padding: "12px 14px",
    borderRadius: "10px",
    background: "#212121",
    color: "#fff",
    fontSize: "13px",
    lineHeight: "1.5",
    boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
    fontFamily: "system-ui, -apple-system, sans-serif",
    display: "flex",
    flexDirection: "column",
    gap: "6px",
  });

  const header = document.createElement("div");
  Object.assign(header.style, { fontWeight: "700", marginBottom: "2px" });

  if (result.ok && result.found) {
    const verdict = verdictInfo(result);
    header.textContent = `${verdict.icon} ${result.title}`;
    popup.appendChild(header);
    foundPopupRows(result).forEach((row) => popup.appendChild(row));

    const summary = document.createElement("div");
    summary.textContent = verdict.summary;
    Object.assign(summary.style, { color: "#ccc", marginTop: "4px", lineHeight: "1.4" });
    popup.appendChild(summary);
  } else {
    header.textContent = "❔ No verdict";
    popup.appendChild(header);
    popup.appendChild(popupRow("Reason", neutralMessage(result)));
  }

  if (result.stale) {
    const stale = document.createElement("div");
    stale.textContent = "Cached data — could not refresh (quota, network, or no key).";
    Object.assign(stale.style, { color: "#ffb74d", marginTop: "4px", lineHeight: "1.4" });
    popup.appendChild(stale);
  }

  // Action buttons sit in a wrapping row under the breakdown.
  const actions = document.createElement("div");
  Object.assign(actions.style, {
    display: "flex",
    gap: "8px",
    marginTop: "8px",
    flexWrap: "wrap",
  });

  // Trust / untrust the channel. Only for a found channel (we key trust by its
  // canonical channel ID, which only a found result carries). A trusted channel is
  // never flagged (M8.5); the change applies to this page immediately via onTrustChanged.
  if (result.ok && result.found && result.channelId) {
    const trustBtn = popupButton(result.trusted ? "stop trusting" : "trust this channel");
    trustBtn.addEventListener("click", async (event) => {
      event.stopPropagation();
      const { channelId } = result;
      if (result.trusted) await untrustChannel(channelId);
      else await trustChannel(channelId, { title: result.title });
      removePopup();
      onTrustChanged(channelId);
    });
    actions.appendChild(trustBtn);
  }

  // Shortcut to the Options page so the threshold can be tweaked without leaving the video.
  const settingsBtn = popupButton("adjust settings");
  settingsBtn.addEventListener("click", () => {
    browser.runtime.sendMessage({ type: "openOptions" });
    removePopup();
  });
  actions.appendChild(settingsBtn);

  popup.appendChild(actions);

  document.body.appendChild(popup);

  // Anchor under the badge, clamped to the viewport so it never overflows the edge.
  const rect = badge.getBoundingClientRect();
  const left = Math.min(rect.left, window.innerWidth - popup.offsetWidth - 8);
  popup.style.left = `${Math.max(8, left)}px`;
  popup.style.top = `${rect.bottom + 6}px`;

  document.addEventListener("click", onDocClickForPopup, true);
  document.addEventListener("keydown", onKeydownForPopup, true);
  window.addEventListener("scroll", removePopup, true);
}

function onDocClickForPopup(event) {
  const popup = document.getElementById(POPUP_ID);
  if (popup && !popup.contains(event.target)) removePopup();
}

function onKeydownForPopup(event) {
  if (event.key === "Escape") removePopup();
}

function removePopup() {
  document.getElementById(POPUP_ID)?.remove();
  document.removeEventListener("click", onDocClickForPopup, true);
  document.removeEventListener("keydown", onKeydownForPopup, true);
  window.removeEventListener("scroll", removePopup, true);
}

// Ask the background page to evaluate the channel, then badge it with the result.
// Stale responses (user moved on, or a different channel won the race) are dropped.
async function evaluateChannel(channel, key) {
  const token = ++lookupToken;
  currentSettings = await getSettings(); // reload so Options changes apply on navigation
  let result = null;
  try {
    result = await browser.runtime.sendMessage({ type: "lookupChannel", channel });
  } catch {
    // background unavailable — fall through to a neutral badge, never break the page
  }
  if (token !== lookupToken || key !== currentChannelKey) return;

  // Easy demo check from the normal page console: shows whether this came from the
  // cache (no API call) and whether it was a stale fallback.
  const source = result?.cached ? (result.stale ? "cache (stale fallback)" : "cache") : "API";
  console.log(`Watchdog [${source}]`, key, result);

  if (result && result.ok && result.found) {
    // ✅ legit or ⚠️ flagged — show the numbers, unless that verdict is hidden (M7).
    const { kind } = verdictInfo(result);
    const visible = kind === "flagged" ? currentSettings.showFlagged : currentSettings.showLegit;
    if (visible) showBadge(result);
    else removeBadge();
  } else if (currentSettings.showNeutral) {
    showNeutralBadge(result); // ❔ no key, API error, unsupported, or not found
  } else {
    removeBadge();
  }
}

// Detect the current channel and, when it changes, kick off an evaluation. YouTube
// reuses the owner element across SPA navigations and swaps its link asynchronously,
// so this runs both on navigation and on every relevant owner mutation; the
// currentChannelKey guard keeps it to one evaluation per channel.
function syncBadge() {
  if (location.pathname !== "/watch") {
    currentChannelKey = null;
    removeBadge();
    return;
  }

  const channel = detectChannel();
  if (!channel) return;

  const key = `${channel.kind}:${channel.value}`;
  if (key === currentChannelKey) return;
  currentChannelKey = key;
  removeBadge(); // drop any badge belonging to the previous channel
  evaluateChannel(channel, key);
}

function removeBadge() {
  document.getElementById(BADGE_ID)?.remove();
  removePopup(); // the popup is anchored to the badge — drop it too
}

// Re-render the current page after the user trusts/untrusts a channel from a popup, so
// the change shows immediately (Options-page changes still apply on the next
// navigation). Forces the watch badge to re-evaluate, and drops any feed badges/cached
// feed results for the affected channel so they re-evaluate against the new trust state
// (a newly-trusted channel's ⚠️ badge disappears; an untrusted one can re-flag on
// scroll). Other channels' badges are left untouched.
function onTrustChanged(channelId) {
  currentChannelKey = null; // force the watch badge to re-evaluate on the next syncBadge
  for (const [key, result] of feedResultCache) {
    if (result && result.channelId === channelId) feedResultCache.delete(key);
  }
  document.querySelectorAll(`.${FEED_BADGE_CLASS}`).forEach((badge) => {
    if (badge._result && badge._result.channelId === channelId) badge.remove();
  });
  syncBadge();
}

// Watch the owner renderer so we re-sync whenever YouTube replaces its link
// (e.g. after navigating to another video). syncBadge early-returns when the
// channel is unchanged, so our own badge writes don't loop the observer.
let observer = null;
function ensureObserver() {
  const target = document.querySelector("ytd-video-owner-renderer");
  if (!target || (observer && observer._target === target)) return Boolean(target);

  if (observer) observer.disconnect();
  observer = new MutationObserver(() => syncBadge());
  observer._target = target;
  observer.observe(target, {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: true,
  });
  return true;
}

// --- M8 — Feed / thumbnail scanning -------------------------------------------
// Opt-in (Options → "Also scan feed…"). Overlays a small corner badge on the
// thumbnails of *flagged* channels across the homepage, search, subscriptions and
// the watch-page sidebar. Two safeguards keep this from burning API quota:
//   - an IntersectionObserver, so only thumbnails actually scrolled into view are
//     ever looked up (off-screen items in a long feed cost nothing);
//   - a rate-limited queue (one dispatch per FEED_DISPATCH_MS, max FEED_MAX_INFLIGHT
//     in flight) plus per-session dedupe, so a feed of many channels never fires an
//     API burst. The background cache absorbs repeats across sessions.
const FEED_BADGE_CLASS = "caw-feed-badge";

// Renderer elements that wrap a single feed/search/recommendation video.
const THUMB_SELECTOR = [
  "ytd-rich-item-renderer", // homepage / subscriptions grid
  "ytd-video-renderer", // search results
  "ytd-compact-video-renderer", // watch-page sidebar recommendations
  "ytd-grid-video-renderer", // channel pages / legacy grids
].join(",");

const FEED_MAX_INFLIGHT = 2; // concurrent lookups
const FEED_DISPATCH_MS = 350; // min gap between dispatches

const observedThumbs = new WeakSet(); // renderers already handed to the IO
const feedResultCache = new Map(); // channelKey -> result (this page session)
const pendingElements = new Map(); // channelKey -> Set<renderer> awaiting a result
const feedQueue = []; // channelKeys waiting to be dispatched
const feedQueued = new Map(); // channelKey -> channel (dedupe queue membership)
const feedInflight = new Set(); // channelKeys currently being looked up

let feedIO = null;
let feedMutationObserver = null;
let feedScanDebounce = null;
let feedTimer = null;

// Find the channel a thumbnail belongs to: the first link in the renderer that
// resolves to a channel (the byline/avatar). The /watch video link never matches.
function detectChannelIn(root) {
  for (const a of root.querySelectorAll("a[href]")) {
    const channel = parseChannelHref(a.getAttribute("href"));
    if (channel) return channel;
  }
  return null;
}

// A thumbnail entered the viewport: resolve its channel and ensure a lookup. Cached
// results apply immediately; otherwise the renderer waits on the throttled queue.
function onThumbVisible(el) {
  if (!currentSettings.scanFeed) return;
  if (el.querySelector(`.${FEED_BADGE_CLASS}`)) return; // already badged

  const channel = detectChannelIn(el);
  // Vanity /c/ paths have no channels.list selector, so a lookup could never flag
  // them — skip rather than waste a throttle slot.
  if (!channel || channel.kind === "vanity") return;

  const key = `${channel.kind}:${channel.value}`;
  if (feedResultCache.has(key)) {
    applyFeedResult(el, feedResultCache.get(key));
    return;
  }

  let waiting = pendingElements.get(key);
  if (!waiting) {
    waiting = new Set();
    pendingElements.set(key, waiting);
  }
  waiting.add(el);

  if (!feedQueued.has(key) && !feedInflight.has(key)) {
    feedQueued.set(key, channel);
    feedQueue.push(key);
    scheduleFeedTick();
  }
}

// Throttle: at most one dispatch per FEED_DISPATCH_MS, capped at FEED_MAX_INFLIGHT.
function scheduleFeedTick() {
  if (feedTimer) return;
  feedTimer = setTimeout(() => {
    feedTimer = null;
    feedTick();
  }, FEED_DISPATCH_MS);
}

function feedTick() {
  if (feedInflight.size < FEED_MAX_INFLIGHT && feedQueue.length > 0) {
    const key = feedQueue.shift();
    const channel = feedQueued.get(key);
    feedQueued.delete(key);
    feedInflight.add(key);
    dispatchFeedLookup(key, channel);
  }
  if (feedQueue.length > 0) scheduleFeedTick();
}

// Ask the background page to evaluate one channel, then badge every visible
// thumbnail that was waiting on it. Errors degrade to "no badge", never break the page.
async function dispatchFeedLookup(key, channel) {
  let result = null;
  try {
    result = await browser.runtime.sendMessage({ type: "lookupChannel", channel });
  } catch {
    // background unavailable — leave the thumbnail unbadged
  }
  feedInflight.delete(key);

  if (result) {
    feedResultCache.set(key, result);
    const waiting = pendingElements.get(key);
    if (waiting) {
      for (const el of waiting) applyFeedResult(el, result);
      pendingElements.delete(key);
    }
  }
  if (feedQueue.length > 0) scheduleFeedTick(); // a slot freed up
}

// Feed badges are deliberately flagged-only: overlaying every legit thumbnail would
// be noise. Honour the same ⚠️ visibility toggle the watch badge uses.
function applyFeedResult(el, result) {
  if (!currentSettings.scanFeed || !currentSettings.showFlagged) return;
  if (!(result.ok && result.found && result.flagged)) return;
  addFeedBadge(el, result);
}

// Overlay a small corner badge on the thumbnail. Clicking it opens the shared detail
// popup (anchored to the badge) instead of following the thumbnail link.
function addFeedBadge(el, result) {
  if (el.querySelector(`.${FEED_BADGE_CLASS}`)) return;

  const thumb = el.querySelector("a#thumbnail") || el;
  if (getComputedStyle(thumb).position === "static") thumb.style.position = "relative";

  const badge = document.createElement("span");
  badge.className = FEED_BADGE_CLASS;
  badge._result = result;
  badge.textContent = `⚠️ ${result.videoCount} in ${formatAge(result.ageDays)}`;
  Object.assign(badge.style, {
    position: "absolute",
    top: "4px",
    left: "4px",
    zIndex: "100",
    padding: "2px 6px",
    borderRadius: "8px",
    background: "rgba(198, 40, 40, 0.95)",
    color: "#fff",
    fontSize: "11px",
    fontWeight: "700",
    lineHeight: "1.3",
    whiteSpace: "nowrap",
    fontFamily: "system-ui, -apple-system, sans-serif",
    boxShadow: "0 1px 4px rgba(0, 0, 0, 0.4)",
    cursor: "pointer",
    pointerEvents: "auto",
  });
  badge.title = `Channel Age Watchdog — ${result.title}\nClick for details`;
  badge.addEventListener("click", (event) => {
    event.preventDefault(); // don't navigate to the video
    event.stopPropagation();
    toggleDetailPopup(badge);
  });
  thumb.appendChild(badge);
}

// Hand any not-yet-observed thumbnail renderers to the IntersectionObserver. Cheap to
// re-run (the WeakSet skips known elements), so it's safe to call on every mutation.
function scanForThumbnails() {
  if (!currentSettings.scanFeed) return;
  if (!feedIO) {
    feedIO = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) onThumbVisible(entry.target);
        }
      },
      { rootMargin: "100px" } // start a touch before they're fully on-screen
    );
  }
  for (const el of document.querySelectorAll(THUMB_SELECTOR)) {
    if (observedThumbs.has(el)) continue;
    observedThumbs.add(el);
    feedIO.observe(el);
  }
}

// Infinite scroll keeps appending renderers, so watch the DOM and re-scan (debounced)
// to observe the new ones. The debounce keeps YouTube's chatty mutations bounded.
function ensureFeedMutationObserver() {
  if (feedMutationObserver) return;
  feedMutationObserver = new MutationObserver(() => {
    if (feedScanDebounce) return;
    feedScanDebounce = setTimeout(() => {
      feedScanDebounce = null;
      scanForThumbnails();
    }, 400);
  });
  feedMutationObserver.observe(document.body, { childList: true, subtree: true });
}

// Tear everything down when scanning is off: stop observing, drop pending work, and
// remove any badges we placed. Lets a navigation after disabling the option clean up.
function teardownFeedScanning() {
  if (feedIO) {
    feedIO.disconnect();
    feedIO = null;
  }
  if (feedMutationObserver) {
    feedMutationObserver.disconnect();
    feedMutationObserver = null;
  }
  if (feedTimer) {
    clearTimeout(feedTimer);
    feedTimer = null;
  }
  feedQueue.length = 0;
  feedQueued.clear();
  pendingElements.clear();
  document.querySelectorAll(`.${FEED_BADGE_CLASS}`).forEach((b) => b.remove());
}

// Reload settings, then start or stop feed scanning to match. Called on each
// navigation so toggling the option in Options takes effect on the next page.
async function refreshFeedScanning() {
  currentSettings = await getSettings();
  if (currentSettings.scanFeed) {
    ensureFeedMutationObserver();
    scanForThumbnails();
  } else {
    teardownFeedScanning();
  }
}

// On navigation the owner element may not exist yet (and the badge may show the
// previous video's channel until YouTube updates the link). Retry until the
// owner is present and the observer is attached; the observer then keeps the
// badge correct for any later async link swap.
function onNavigate(attempt = 0) {
  const ready = ensureObserver();
  syncBadge();
  maybeShowKeyNotice();
  refreshFeedScanning();
  if (!ready && location.pathname === "/watch" && attempt < 20) {
    setTimeout(() => onNavigate(attempt + 1), 250);
  }
}

// Fires on every YouTube SPA navigation (and once on the first load).
window.addEventListener("yt-navigate-finish", () => onNavigate());

// Cover the initial page load too, in case yt-navigate-finish already fired.
onNavigate();
