# Website Time Tracker

**Website Time Tracker** is a Chrome Extension (Manifest V3) that helps you understand how you spend your time online. See exactly where your attention goes and make smarter decisions about your browsing habits.

Track time spent on each website, automatically categorize sites by tags (social, study, work, etc.), and view a clear daily breakdown with an interactive timeline and pie chart. 

All data stays on your device — no accounts, no cloud syncing, no external servers. Simple, private, and built to help you stay focused.

## Features

- **Daily timeline** — Chronological breakdown of domain + duration
- **Pie chart** — Percentage breakdown per domain (small domains grouped as “Other”)
- **Privacy-first** — No backend; all data in `chrome.storage.local`
- **Delete all data** — One-click clear
- **Domain exclusion** — Exclude domains from tracking in Settings

## Installation (unpacked)

1. Clone or download this folder.
2. Open Chrome → **Extensions** → **Manage extensions** → **Developer mode** (on).
3. Click **Load unpacked** and select this folder (the one containing `manifest.json`).
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

See [PRIVACY.md](PRIVACY.md). All data stays on your device; nothing is sent anywhere.

## Testing

- **Unit tests:** `node tests/unit.js` — tests date key, hostname extraction, time rounding, timeline aggregation.
- **Manual:** Use normal and Incognito windows, switch tabs/windows, leave idle, change date at midnight.

## Version

1.0.0 — Increment in `manifest.json` when publishing updates.
