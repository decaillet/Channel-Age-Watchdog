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

// Pull the channel identity out of the owner renderer's link. YouTube uses
// either a handle URL (/@SomeHandle) or a canonical channel URL (/channel/UC…),
// and occasionally legacy /c/ or /user/ vanity paths. Return whichever we find.
function detectChannel() {
  const link = document.querySelector(
    "ytd-video-owner-renderer #channel-name a, ytd-video-owner-renderer a.yt-simple-endpoint"
  );
  if (!link) return null;

  const href = link.getAttribute("href") || "";
  const path = href.replace(/^https?:\/\/[^/]+/, ""); // strip origin if absolute

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
  if (result.flagged) {
    const why =
      result.reason === "new+volume"
        ? "new channel, high upload volume"
        : "high sustained publishing rate";
    return {
      kind: "flagged",
      icon: "⚠️",
      color: "#c62828",
      summary: `Flagged: ${why} (publishing pattern, not AI detection)`,
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

// On navigation the owner element may not exist yet (and the badge may show the
// previous video's channel until YouTube updates the link). Retry until the
// owner is present and the observer is attached; the observer then keeps the
// badge correct for any later async link swap.
function onNavigate(attempt = 0) {
  const ready = ensureObserver();
  syncBadge();
  maybeShowKeyNotice();
  if (!ready && location.pathname === "/watch" && attempt < 20) {
    setTimeout(() => onNavigate(attempt + 1), 250);
  }
}

// Fires on every YouTube SPA navigation (and once on the first load).
window.addEventListener("yt-navigate-finish", () => onNavigate());

// Cover the initial page load too, in case yt-navigate-finish already fired.
onNavigate();
