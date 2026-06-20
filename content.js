// Channel Age Watchdog — content script
// M3: detect the real channel (handle or ID) from the watch page DOM and show
// it in the badge, surviving YouTube's SPA navigation.
console.log("Watchdog loaded");

const BADGE_ID = "caw-badge";

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
  if (!ready && location.pathname === "/watch" && attempt < 20) {
    setTimeout(() => onNavigate(attempt + 1), 250);
  }
}

// Fires on every YouTube SPA navigation (and once on the first load).
window.addEventListener("yt-navigate-finish", () => onNavigate());

// Cover the initial page load too, in case yt-navigate-finish already fired.
onNavigate();
