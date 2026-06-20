# Channel Age Watchdog — project notes for Claude

A Firefox MV3 WebExtension that flags likely AI-slop YouTube channels using a publishing-rate
heuristic (`video_count / channel_age_in_days > threshold`). Full intent lives in `overview.md`;
the build is tracked agile-style in `todo.md`.

See @todo.md for the current milestone board.

## How we work
- Build in small, **demonstrable** milestones (see `todo.md`). A milestone is done only when its
  Demo passes in a real Firefox browser.
- Claude writes code; the **user loads & tests** the extension (Claude cannot run a browser).
- Don't jump ahead milestones without the user's go-ahead after a demo.

## Tech decisions
- **Vanilla JS, no build step** for now (loads directly via `about:debugging`). May add `web-ext`
  later if the dev loop needs live-reload/linting.
- Firefox **MV3** specifics:
  - `manifest_version: 3`, plus `browser_specific_settings.gecko.id`.
  - Background is an **event page**: `"background": { "scripts": ["background.js"] }` — not a
    Chrome-style `service_worker`.
  - Use the `browser.*` promise API.
- API key lives only in `browser.storage.local`; it is sent only to Google's YouTube Data API,
  never anywhere else. Never hardcode a key. Never commit a key.

## How to load/test (the demo loop)
1. Firefox → `about:debugging#/runtime/this-firefox`
2. "Load Temporary Add-on…" → select `manifest.json` in this repo
3. Open `youtube.com`; inspect via the page console or the add-on's "Inspect" button.
4. After editing files, click "Reload" on the add-on in `about:debugging`.

## Conventions
- Conventional Commits. Commit/push only when the user asks.
