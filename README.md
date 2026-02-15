# Website Time Tracker

A **Chrome Extension (Manifest V3)** that tracks time spent per website (by domain) locally on your machine. Includes Incognito support with isolated data.

## Features

- **Daily timeline** — Chronological breakdown of domain + duration
- **Pie chart** — Percentage breakdown per domain (small domains grouped as “Other”)
- **Privacy-first** — No backend; all data in `chrome.storage.local`
- **Incognito** — Optional; data stays separate from normal browsing
- **Export** — JSON or CSV
- **Delete all data** — One-click clear
- **Domain exclusion** — Exclude domains from tracking in Settings

## Installation (unpacked)

1. Clone or download this folder.
2. Open Chrome → **Extensions** → **Manage extensions** → **Developer mode** (on).
3. Click **Load unpacked** and select the `tracker` folder (the one containing `manifest.json`).
4. (Optional) Right-click the extension → **Manage extension** → enable **Allow in Incognito**.

## Building / packaging

No build step required. The extension runs as-is. For store submission:

- Icons: `icons/icon16.png`, `icons/icon48.png`, `icons/icon128.png` (128×128 required for Chrome Web Store).
- Add screenshots for the store listing.
- Update version in `manifest.json` for each release.

## Permissions

- **tabs** — Detect active tab and hostname
- **storage** — Store usage data locally
- **alarms** — Periodic persistence
- **idle** — Pause tracking when you’re idle

## Privacy

See [PRIVACY.md](PRIVACY.md). All data stays on your device; nothing is sent to any server.

## Testing

- **Unit tests:** `node tests/unit.js` — tests date key, hostname extraction, time rounding, timeline aggregation.
- **Manual:** Use normal and Incognito windows, switch tabs/windows, leave idle, change date at midnight.

## Version

1.0.0 — Increment in `manifest.json` when publishing updates.
