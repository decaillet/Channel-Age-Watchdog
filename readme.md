# Channel Age Watchdog

A Firefox extension that flags YouTube channels with a **suspicious publishing pattern** —
channels posting an unusually high number of videos relative to how long they have existed.

> **This is not AI detection.** The extension does no content analysis, no watermark or
> SynthID checking, and no ML classification. It only looks at public channel metadata
> (creation date and total video count) and applies a simple publishing-rate heuristic.
> A flag means *"this channel's upload volume looks suspicious — judge for yourself"*,
> not *"this is AI-generated."* Plenty of legitimate channels publish a lot; plenty of
> slop channels don't. Treat the badge as a prompt to look closer, nothing more.

## What it does

On a YouTube watch page (and optionally on feeds, search, and recommendations), it shows a
small badge near the channel name:

- ⚠️ **Flagged** — publishing rate exceeds your threshold
- ✅ **Looks legit** — below the threshold
- ❔ **No verdict** — no API key, an API error, or an unsupported/unknown channel

Click any badge to see the underlying numbers (channel age, video count, videos/day ratio) so
you can make your own call rather than trusting a verdict.

## The heuristic

```
ratio = video_count / channel_age_in_days
flagged if ratio > ratioThreshold   (default: 0.05, i.e. > 1 video / 20 days sustained)
```

The threshold is configurable in Options. Lowering it flags more channels; the verdict is
recomputed from cached facts, so changing the threshold re-evaluates channels on your next
visit with no extra API calls.

## Getting a YouTube Data API key

The extension needs your own free Google API key. It is stored only in
`browser.storage.local` and is sent only to Google's YouTube Data API — never anywhere else.
No key ships with the extension.

1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a project (or select an existing one).
3. In **APIs & Services → Library**, search for **"YouTube Data API v3"** and click **Enable**.
4. In **APIs & Services → Credentials**, click **Create Credentials → API key**.
5. Copy the key (it starts with `AIza…`).
6. (Recommended) Click the new key to **restrict** it: under *API restrictions*, limit it to
   the YouTube Data API v3 so it can't be used for anything else if leaked.
7. Open the extension's Options page and paste the key in. It persists across restarts.

If no key is set, the extension shows a one-time non-blocking notice linking here and otherwise
stays out of the way.

## Loading the extension in Firefox (unpacked)

There is no build step — load the source directly:

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…**.
3. Select `manifest.json` in this repository.
4. Open `youtube.com` and visit a video; the badge appears near the channel name.
5. After editing files, click **Reload** on the add-on in `about:debugging`.

Notes:

- Temporary add-ons are removed when you close Firefox. Re-load it the same way next session.
- Firefox does **not** run extensions in Private Browsing windows by default, so the content
  script silently skips there and demos can look broken. Test in a normal window, or enable it
  via `about:addons` → the extension → **Run in Private Windows: Allow**.
- To configure it, open `about:addons` → Channel Age Watchdog → **Preferences**, or use the
  Options entry. Set your API key and adjust the threshold and badge visibility there.

## Quota notes

- The YouTube Data API gives **10,000 units/day** for free. Resets daily at midnight Pacific Time.
- This extension uses the `channels.list` endpoint, which costs **1 unit per channel lookup**.
- Lookups are **cached for 7 days** in `browser.storage.local`, so a given channel costs at
  most 1 unit per week. In normal browsing the daily cap is effectively unreachable.
- Feed/thumbnail scanning is **opt-in** and rate-limited (debounced, capped in-flight, and
  deduped per session) specifically to avoid bursts of API calls while scrolling.
- The extension never displays a "requests remaining" counter — the API does not expose
  remaining quota (only the Cloud Console does), so any in-extension number would just be a
  drifting local estimate.
- If the key is missing, invalid, or quota is exceeded, the extension simply shows ❔ / no
  badge and never breaks the page.

## Options

Open via `about:addons` → Channel Age Watchdog → **Preferences**:

- **API key** — your YouTube Data API v3 key.
- **Ratio threshold** — videos/day above which a channel is flagged.
- **Badge visibility** — independently show/hide ⚠️ flagged, ✅ legit, and ❔ no-verdict badges
  (e.g. hide the green ✅ to only ever see warnings).
- **Scan feed / search / recommendations** — opt in to thumbnail badges beyond the watch page.

## Privacy

- Your API key and the channel-lookup cache live only in `browser.storage.local` on your
  machine.
- The only network requests are `channels.list` calls to Google's YouTube Data API, made with
  your key. Nothing is sent to any other server.

## Non-goals

No AI/watermark/ML content detection · no crowdsourcing or voting · no auto-hiding or blocking
of videos — **it flags, and that's all**.
