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
- [ ] `background.js` calls YouTube Data API v3 `channels.list`
- [ ] Compute ratio + "new channel + high volume" rule
- [ ] Badge shows real numbers, only when flagged
- **Demo:** slop channel → flagged with numbers; normal channel → no badge.

## M6 — Caching + graceful no-op
- [ ] Cache channel lookups in `browser.storage.local` (reuse ≥7 days)
- [ ] Silent no-op on missing/invalid key or quota exceeded — never break the page
- **Demo:** revisit a channel → no second API call; remove key → page still works.

## M7 — Badge detail popup + configurable thresholds
- [ ] Click badge → popup with channel age, video count, ratio
- [ ] Options: ratio threshold, new-channel thresholds, watch-only vs feed toggle
- **Demo:** lower the threshold → a previously-unflagged channel now flags.

## M8 — (Later pass) Feed / thumbnail scanning
- [ ] Opt-in, debounced + rate-limited badges on feed/search/recommendation thumbnails
- **Demo:** enable in Options → scroll homepage → flagged thumbnails get a corner badge, no API burst.

## M9 — README / docs polish
- [ ] How to get a YouTube Data API key
- [ ] How to load unpacked in Firefox + quota notes
- [ ] "Suspicious publishing pattern, not AI detection" framing

---

## Non-goals (do not build)
No AI/watermark/ML content detection · no crowdsourcing · no auto-hide/block — **flag only**.
