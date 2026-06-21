// Channel Age Watchdog — content script
// M3: detect the real channel (handle or ID) from the watch page DOM and show
// it in the badge, surviving YouTube's SPA navigation.
console.log("Watchdog loaded");

const BADGE_ID = "caw-badge";
const NOTICE_ID = "caw-notice";

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
  if ((match = path.match(/^\/(?:c|user)\/([^/?#]+)/))) {
    return { kind: "vanity", value: match[1] };
  }
  return null;
}

// Write the detected channel into an existing badge. Returns true if anything
// changed — used to avoid re-triggering our own MutationObserver in a loop.
function setBadgeChannel(badge, channel) {
  const text = channel ? `⚠️ ${channel.value}` : "⚠️ ?";
  const title = channel
    ? `Channel Age Watchdog — detected ${channel.kind}: ${channel.value}`
    : "Channel Age Watchdog (channel not detected)";
  if (badge.textContent === text && badge.title === title) return false;
  badge.textContent = text;
  badge.title = title;
  return true;
}

// Build the badge element. M3 shows the detected channel; M5 fills in real numbers.
function createBadge(channel) {
  const badge = document.createElement("span");
  badge.id = BADGE_ID;
  setBadgeChannel(badge, channel);
  Object.assign(badge.style, {
    display: "inline-flex",
    alignItems: "center",
    marginLeft: "8px",
    padding: "2px 8px",
    borderRadius: "12px",
    background: "#c62828",
    color: "#fff",
    fontSize: "12px",
    fontWeight: "600",
    lineHeight: "1.4",
    whiteSpace: "nowrap",
    verticalAlign: "middle",
  });
  return badge;
}

// Insert the badge if missing, or update it in place to match the currently
// detected channel. YouTube reuses the owner element across SPA navigations and
// swaps its link asynchronously, so we must re-read the DOM and update, not just
// inject once.
function syncBadge() {
  if (location.pathname !== "/watch") {
    removeBadge();
    return;
  }

  const owner = document.querySelector("ytd-video-owner-renderer #channel-name");
  const channel = detectChannel();
  if (!owner || !channel) return;

  const existing = document.getElementById(BADGE_ID);
  if (existing) {
    setBadgeChannel(existing, channel);
  } else {
    owner.appendChild(createBadge(channel));
  }
}

function removeBadge() {
  document.getElementById(BADGE_ID)?.remove();
}

// Watch the owner renderer so we re-sync whenever YouTube replaces its link
// (e.g. after navigating to another video). setBadgeChannel is a no-op when
// nothing changed, so our own writes don't loop the observer.
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
