// Channel Age Watchdog — content script
// M2: inject a visible (dummy) badge near the channel name on /watch pages,
// surviving YouTube's SPA navigation.
console.log("Watchdog loaded");

const BADGE_ID = "caw-badge";

// Build the (dummy) badge element. Hardcoded for now; M5 fills in real numbers.
function createBadge() {
  const badge = document.createElement("span");
  badge.id = BADGE_ID;
  badge.textContent = "⚠️ test";
  badge.title = "Channel Age Watchdog (placeholder)";
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

// Try to place the badge next to the channel name. The owner element is not in
// the DOM immediately after navigation, so retry a few times before giving up.
function injectBadge(attempt = 0) {
  if (location.pathname !== "/watch") return;
  if (document.getElementById(BADGE_ID)) return;

  const owner = document.querySelector("ytd-video-owner-renderer #channel-name");
  if (!owner) {
    if (attempt < 20) setTimeout(() => injectBadge(attempt + 1), 250);
    return;
  }

  owner.appendChild(createBadge());
}

function removeBadge() {
  document.getElementById(BADGE_ID)?.remove();
}

function onNavigate() {
  // Drop any stale badge, then (re)inject if we landed on a watch page.
  removeBadge();
  injectBadge();
}

// Fires on every YouTube SPA navigation (and once on the first load).
window.addEventListener("yt-navigate-finish", onNavigate);

// Cover the initial page load too, in case yt-navigate-finish already fired.
onNavigate();
