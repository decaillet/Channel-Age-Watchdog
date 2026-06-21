# Channel Age Watchdog — Build Board

Agile, demonstrable milestones. Each one ends with something you can **see working** in
Firefox. We finish a milestone only when its **Demo** passes.

Legend: `[ ]` todo · `[~]` in progress · `[x]` done

---

## M0 — Project + Claude setup
- [x] `todo.md` (this board)
- [x] `CLAUDE.md` (project conventions + how to load/test)
- [x] `.gitignore`
- Starting tooling: **vanilla JS, no build step** (revisit later if needed)
- **Demo:** repo has a clear structure; `git status` shows the scaffolding.

## M1 — "Does-nothing" extension that loads
- [x] `manifest.json` (Firefox MV3)
- [x] placeholder icon(s)
- [x] `content.js` logging `Watchdog loaded` on YouTube
- **Demo:** `about:debugging` → Load Temporary Add-on → open YouTube → see the log in console.

## M2 — Visible (dummy) badge on watch pages
- [x] Inject a small badge near the channel name on `/watch` pages (hardcoded "⚠️ test")
- [x] Survive YouTube SPA navigation (re-inject on `yt-navigate-finish`)
- **Demo:** badge appears on a watch page and re-appears when you click to another video.

## M3 — Detect the real channel from the page
- [x] Parse channel handle/ID from the DOM
- [x] Badge shows the detected channel
- **Demo:** badge shows the actual channel handle/ID across several videos.

## M4 — Options page + API key storage
- [x] `options.html` + `options.js` (save key to `browser.storage.local`)
- [x] One-time notice + link when no key is set
- **Demo:** save a key in Options, reload Firefox → key persists.

## M5 — Real API call + heuristic + real badge
- [x] `background.js` calls YouTube Data API v3 `channels.list`
- [x] Compute ratio + "new channel + high volume" rule
- [x] Badge always shows real numbers: ⚠️ flagged · ✅ legit · ❔ no verdict
- **Demo:** slop channel → red ⚠️ with numbers; normal channel → green ✅; no key /
  unsupported channel → grey ❔ with reason.

## M6 — Caching + graceful no-op
- [x] Cache channel lookups in `browser.storage.local` (reuse ≥7 days)
- [x] Silent no-op on missing/invalid key or quota exceeded — never break the page
- **Demo:** revisit a channel → no second API call; remove key → page still works.

## M7 — Badge detail popup + configurable thresholds
- [x] Click badge → popup with channel age, video count, ratio
- [x] Options: ratio threshold, new-channel thresholds, watch-only vs feed toggle
- [x] Options: per-verdict badge visibility — let the user disable individual badges
      (notably hide the green ✅ "legit" badge), keeping ⚠️ flagged / ❔ neutral
- **Demo:** lower the threshold → a previously-unflagged channel now flags.
- Done — demoed in Firefox. Notes:
  - Shared `settings.js` (defaults + `getSettings()`) loaded first in all contexts.
  - Single heuristic now: `ratio = videoCount / ageDays > ratioThreshold`. The
    earlier "new-channel" rule was dropped — see M10.
  - Threshold recomputes from cached facts, so lowering it re-flags on next visit
    with no API call. Watch-only vs feed toggle is stored now; honored in M8.

## M8 — Feed / thumbnail scanning
- [x] Opt-in, debounced + rate-limited badges on feed/search/recommendation thumbnails
- **Demo:** enable in Options → scroll homepage → flagged thumbnails get a corner badge, no API burst.
- Done — demoed in Firefox. Notes:
  - Gated on the existing `scanFeed` option; applies on the next navigation.
  - `IntersectionObserver` looks up only thumbnails scrolled into view; a debounced
    `MutationObserver` picks up infinite-scroll content.
  - Rate-limited queue: one dispatch per 350 ms, max 2 in flight, per-session dedupe.
    The background cache (M6) absorbs repeats across sessions, so no API burst.
  - Flagged-only corner badge (⚠️), honouring the `showFlagged` toggle; reuses the
    shared M7 detail popup on click. Covers home, search, subscriptions, and the
    watch-page sidebar (`ytd-rich-item`/`video`/`compact-video`/`grid-video`).

## M8.5 — Trusted channels (allowlist)
- [x] "Trust this channel" button in the badge detail popup (next to "adjust
      settings"); toggles to "stop trusting" for an already-trusted channel
- [x] Trusted channels are never flagged, whatever their publishing rate; the badge
      shows a distinct 🛡️ trusted verdict (follows the ✅ legit visibility toggle)
- [x] Allowlist stored in `browser.storage.local` under `trusted`, keyed by canonical
      channel ID (UC…); shared helpers in `settings.js`
      (`getTrustedChannels`/`trustChannel`/`untrustChannel`)
- [x] Options: "Trusted channels" section lists each trusted channel with a Remove
      button + empty state
- [x] Trusting/untrusting from a popup re-renders the current page immediately (watch
      badge re-evaluates; matching feed badges drop); Options changes apply on the
      next navigation
- **Demo:** trust a flagged channel → ⚠️ turns into 🛡️ trusted and its feed badges
  disappear; open Options → it's listed; Remove it → it can be flagged again on the
  next visit. (Awaiting Firefox test.)

## M9 — README / docs polish
- [x] How to get a YouTube Data API key
- [x] How to load unpacked in Firefox + quota notes
- [x] "Suspicious publishing pattern, not AI detection" framing
- Done — rewrote `readme.md` (kept the lowercase filename). Notes:
  - API-key section: Cloud Console flow (enable YouTube Data API v3 → create
    credentials → restrict the key), plus stored-only-in-`storage.local` framing.
  - Load/quota: `about:debugging` steps, Private-Browsing gotcha, quota notes
    (10k units/day, 1 unit per `channels.list`, 7-day cache, opt-in rate-limited
    feed scan, no quota-counter per M11 rationale).
  - "Not AI detection" callout up top + Non-goals; also added Options/Privacy.

## M10 — Better heuristic (co-design)
- [ ] Co-design a stronger signal than the single `videos/day` ratio. The naive ratio
      over-flags old prolific channels and under-flags slow-drip slop; the dropped
      "new-channel" rule was too blunt to keep.
- [ ] Ideas to explore together: recent upload velocity (last N days vs lifetime),
      upload regularity/burstiness, account age vs upload-start gap, per-category
      norms. Decide what the YouTube Data API can actually supply within quota.
- **Demo:** TBD once the heuristic is agreed.

## M11 — API key status in Options (no quota counter)
- [x] Show key state in Options: not set / set / "Test key" button that does one witness
      `channels.list` call and reports ✅ valid · ❌ invalid · quota exceeded.
- **Demo:** paste a bad key → "Test key" shows invalid; paste a good one → valid.
- Done — demoed in Firefox.
- Implemented:
  - `keyState` line under the key form reflects the *saved* key (not the unsaved input):
    "A key is saved." / "No key saved." Updated on load and after every save/clear.
  - "Test key" button validates the key currently in the field (so a freshly-pasted
    key can be checked before saving). Background runs one witness `channels.list`
    call (`part=id` against a stable channel id, 1 unit) via a new `testApiKey`
    message; the page only renders the verdict, so the network call stays in the
    background page.
  - Verdict mapping: `ok` → valid · 403 quotaExceeded/dailyLimit/rateLimit → quota
    ("valid but quota exhausted") · anything else → invalid, surfacing the API's own
    error message (covers bad key, API-not-enabled, etc.) · fetch failure → network.
- Note: do NOT build a "requests remaining" counter. The YouTube Data API does not
  expose remaining quota (only the Cloud Console does), so it could only be a local
  estimate that drifts. Quota is 10,000 units/day, resets daily at midnight PT, and
  with the M6 7-day cache (1 unit per channel per week) the cap is effectively
  unreachable in normal use — there is nothing to "pay" or re-key for.

---

## Non-goals (do not build)
No AI/watermark/ML content detection · no crowdsourcing · no auto-hide/block — **flag only**.
