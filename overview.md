# Overview
(generate by Claude.ai - not claude code - may contain mistakes...)

Build a Firefox browser extension (Manifest V3 / WebExtensions API) called "Channel Age Watchdog" that flags likely AI-slop YouTube channels based on a simple heuristic: a channel publishing an unusually high number of videos relative to how long it has existed.

## Core heuristic

Flag a channel if:
```
video_count / channel_age_in_days > threshold
```
Default threshold: a channel posting more than ~1 video/day sustained since creation is suspicious (configurable — see Options below). Also flag outright if channel age < 30 days AND video_count > 50, regardless of ratio (catches brand-new mass-upload channels even before enough history exists for the ratio to be meaningful).

## Data source

Use the official **YouTube Data API v3** (`channels.list` endpoint, `part=snippet,statistics`) to get:
- `snippet.publishedAt` → channel creation date
- `statistics.videoCount` → total videos

This requires a free Google Cloud API key (quota: 10,000 units/day, `channels.list` costs 1 unit — generous for personal browsing). The extension should NOT ship with a hardcoded key. Instead:
- Add an **Options page** where the user pastes in their own API key (stored in `browser.storage.local`, never transmitted anywhere except directly to Google's API).
- If no key is set, show a one-time non-blocking notice linking to where to get one (Google Cloud Console → enable "YouTube Data API v3" → create credentials).

## Where it activates

1. **Watch page** (`youtube.com/watch?v=...`): inject a small badge near the channel name/subscribe button showing a warning icon + tooltip ("⚠️ 480 videos in 12 days") if flagged.
2. **Feed/recommendations/subscriptions/search results**: optionally overlay a small corner badge on video thumbnails for flagged channels (toggle in Options — this is more API-call-intensive, so make it opt-in and rate-limited).

## Caching & rate limiting

- Cache channel lookups (channel ID → {publishedAt, videoCount, flagged, timestamp}) in `browser.storage.local` for at least 7 days before re-querying, to avoid burning API quota.
- Batch/debounce lookups when scrolling a feed with many thumbnails (don't fire 50 API calls instantly).
- Gracefully no-op (no badge, no console spam) if the API key is missing, invalid, or quota is exceeded — never break the page.

## UI / UX requirements

- Badges should be small, unobtrusive, and not shift page layout (absolute-positioned overlay).
- Clicking a badge shows a small popup/tooltip with the actual numbers (channel age, video count, ratio) so the user can judge for themselves rather than just trusting a verdict.
- Options page lets the user adjust:
  - The ratio threshold
  - The "new channel + high volume" absolute thresholds (age in days, min video count)
  - Whether feed/thumbnail scanning is enabled or just the watch page
  - API key field

## Explicit non-goals (do not implement)

- No actual AI-content/watermark detection (no SynthID, no C2PA, no ML classification of video/audio/visuals). This tool only reasons about channel publishing metadata. Don't claim or imply it detects "AI-generated" content — only "suspicious publishing pattern."
- No crowdsourced voting/community features.
- No blocking/hiding of videos — flag only, never auto-hide (user can decide to add a hide toggle later, but don't build it as default behavior).

## Deliverables

- Full extension source (manifest.json targeting Firefox MV3, background/service worker script, content script for injection, options page HTML/JS).
- A short README with: how to get a YouTube Data API key, how to load the extension unpacked in Firefox (`about:debugging`), and a note on quota limits.
