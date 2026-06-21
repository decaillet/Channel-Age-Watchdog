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

## M10 — Better heuristic: three-conditions AND
Flag a channel as suspicious ONLY when all three hold at once (logical AND):
  1. videos/day high       — existing `ratio = videoCount / ageDays > ratioThreshold` (unchanged)
  2. views per video low   — `viewCount / videoCount < maxViewsPerVideo`
  3. subs per video low    — `subscriberCount / videoCount < maxSubsPerVideo`

Rationale: the lone videos/day ratio over-flags old prolific legit channels. AND-ing an
engagement floor lets those channels escape while still catching high-volume, low-engagement
slop. `viewCount`/`subscriberCount` already come back in the `part=statistics` response, so
this adds zero quota.

- [x] `settings.js`: add `maxViewsPerVideo` + `maxSubsPerVideo` defaults; sanitize via
      `positiveNumber()`; keep `ratioThreshold`.
- [x] `background.js` `evaluate()`: read views/subs, compute the two per-video metrics, AND
      the three conditions. Guard `videoCount === 0` and hidden subscriber counts.
- [x] `background.js` cache: store `viewCount`/`subscriberCount`/`hiddenSubscriberCount` in
      `facts` so the verdict recomputes on cached entries (old entries backfill on next
      7-day refresh).
- [x] Options: two new threshold inputs (views/video, subs/video) + labels.
- [x] Badge detail popup: show views/video and subs/video next to the ratio.

Design notes / open questions:
  - Does NOT address the slow-drip slop under-flag: condition 1 is still the gate, and AND
    only narrows flagging. This iteration targets false positives, not coverage.
  - Conditions 2 and 3 are strongly correlated (subs track views); 3 rarely flips the
    verdict. Keep both for now; consider collapsing into one engagement floor later.
  - Both metrics are lifetime-cumulative → favour age. New slop has "low" views/subs for
    innocent reasons; old channels clear the floor by accumulation. Thresholds need care.
  - Hidden subscriber count → DECIDED (post-demo): treat as condition 3 *met* ("counts as
    low"), not a free pass. Hiding the count is a weak slop signal and we only ever warn,
    so a false warning is cheap; conditions 1+2 still gate the flag, protecting legit
    channels that hide subs but have real views / a sane rate. Popup shows "hidden
    (counts as low)". (A non-hidden but genuinely-missing viewCount still counts as
    not-met — only the explicit hidden flag is treated as low.)
  - "Low" thresholds are niche/language/region dependent. Ship tunable, revisit defaults.

- **Demo:** pick a known slop channel and a known old-prolific-legit channel; lower
  the videos/day threshold so both trip condition 1, then confirm only the slop one flags
  once the engagement floors are in. (Awaiting Firefox test.)
- Implemented:
  - `settings.js`: `maxViewsPerVideo` (default 1000) + `maxSubsPerVideo` (default 10),
    both sanitised via `positiveNumber()`. Defaults are tunable placeholders — niche/
    region dependent, revisit after real-world use.
  - `background.js` `evaluate()`: computes `viewsPerVideo`/`subsPerVideo` and flags only
    when `highRate && lowViews && lowSubs`. A metric we can't compute (videoCount 0, or
    hidden subs) is treated as not-met, so an unknown never flags (favour false negative).
    All three echoed back in `result` (+ `thresholds`) for the popup.
  - `facts` now caches `viewCount`/`subscriberCount`/`hiddenSubscriberCount`; old entries
    backfill on the next 7-day refresh (a pre-M10 entry lacks them → those conditions
    read as not-met → it won't flag until refreshed). Verdict still recomputes on read.
  - Options: "...and engagement is low" field with two number inputs; save validates all
    three numeric thresholds as positive.
  - Popup: "Views / video" and "Subscribers / video" rows next to the rate, each showing
    the flag-below threshold; hidden subs render as "hidden", missing data as "unknown".

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

## M12 — Package & lint (local, no Mozilla account)
- [x] Adopt `web-ext` as a dev dependency (`package.json`, scripts: `lint`/`build`/`sign`).
- [x] `npm run lint` clean: 0 errors, 0 warnings (one forward-looking notice only —
      `data_collection_permissions`, see below).
- [x] `npm run build` → reproducible zip in `web-ext-artifacts/`, dev files excluded
      (`node_modules`, `package.json`, `*.md`, `.gitignore` ignored via `--ignore-files`).
- **Demo:** load `web-ext-artifacts/channel_age_watchdog-0.1.0.zip` as a temp add-on →
  works; `npm run lint` passes. (Awaiting Firefox test.)
- Notes:
  - SVG manifest icon passes lint; no PNG conversion needed for now.
  - Lint notice: Mozilla will eventually require `data_collection_permissions` in the
    manifest. Non-blocking for unlisted signing. Relevant because channel IDs are sent
    to Google's API. Decide on the declaration (likely `none` for developer collection,
    since there is no backend) before it becomes mandatory.

## M13 — Sign for self-distribution (unlisted .xpi)
- [ ] User: create an AMO account at https://addons.mozilla.org/developers/
- [ ] User: generate API credentials (JWT issuer + secret) at
      https://addons.mozilla.org/developers/addon/api/key/
- [ ] Run `npm run sign -- --api-key=<issuer> --api-secret=<secret>` →
      Mozilla-signed `.xpi` in `web-ext-artifacts/`.
- [ ] Install the signed `.xpi` in normal Firefox; confirm it survives a restart.
- **Demo:** install the signed `.xpi`, restart Firefox → extension still present and working.
- Notes:
  - `--channel=unlisted` = signed for self-distribution, not listed on AMO, no public
    review. The API secret is the user's; the user runs the sign command.
  - Unlisted self-distribution has no auto-update unless an `update_url` is added later.

---

## Non-goals (do not build)
No AI/watermark/ML content detection · no crowdsourcing · no auto-hide/block — **flag only**.
