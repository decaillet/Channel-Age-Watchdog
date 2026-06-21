// Channel Age Watchdog — content script
// M3: detect the real channel from the watch page DOM, surviving SPA navigation.
// M5: ask the background page to evaluate the channel via the YouTube Data API and
// show the badge with real numbers only when the publishing rate is flagged.
console.log("Watchdog loaded");

const BADGE_ID = "caw-badge";
const NOTICE_ID = "caw-notice";

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
    cursor: "default",
  });
  return badge;
}

// Show the badge with the real numbers — always, whether or not the channel is
// flagged. ⚠️ (red) for a suspicious publishing rate, ✅ (green) when it looks legit.
// Inserted next to the channel name; the tooltip carries the full breakdown.
function showBadge(result) {
  const owner = document.querySelector("ytd-video-owner-renderer #channel-name");
  if (!owner) return;

  const ratioText = result.ratio != null ? `~${result.ratio.toFixed(2)}/day` : "very high rate";
  const ageText = formatAge(result.ageDays);

  let verdict;
  if (result.flagged) {
    const why =
      result.reason === "new+volume"
        ? "new channel, high upload volume"
        : "high sustained publishing rate";
    verdict = {
      icon: "⚠️",
      color: "#c62828",
      summary: `Flagged: ${why} (publishing pattern, not AI detection)`,
    };
  } else {
    verdict = {
      icon: "✅",
      color: "#2e7d32",
      summary: "Looks legit: publishing rate within normal range",
    };
  }

  let badge = document.getElementById(BADGE_ID);
  if (!badge) {
    badge = createBadge();
    owner.appendChild(badge);
  }
  // A stale result is cached data served because the live refresh failed (quota,
  // network, or no key). The verdict still holds; just note it may be out of date.
  const staleNote = result.stale ? "\nCached data (could not refresh)" : "";

  badge.style.background = verdict.color;
  badge.textContent = `${verdict.icon} ${result.videoCount} videos in ${ageText}`;
  badge.title =
    `Channel Age Watchdog — ${result.title}\n` +
    `${result.videoCount} videos · channel age ${ageText} · ${ratioText}\n` +
    verdict.summary +
    staleNote;
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
  let badge = document.getElementById(BADGE_ID);
  if (!badge) {
    badge = createBadge();
    owner.appendChild(badge);
  }
  badge.style.background = "#616161";
  badge.textContent = `❔ ${message}`;
  badge.title = `Channel Age Watchdog — ${message}`;
}

// Ask the background page to evaluate the channel, then badge it with the result.
// Stale responses (user moved on, or a different channel won the race) are dropped.
async function evaluateChannel(channel, key) {
  const token = ++lookupToken;
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
    showBadge(result); // ✅ legit or ⚠️ flagged — show the numbers
  } else {
    showNeutralBadge(result); // ❔ no key, API error, unsupported, or not found
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
