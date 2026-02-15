# Website Time Tracker — Privacy Policy

**Last updated:** February 2025

## Summary

Website Time Tracker is designed to be **fully private**. All data stays on your device. Nothing is sent to any server or third party.

## Data collection

- **What we store:** Only hostnames (e.g. `example.com`) and time spent per day. We do not store full URLs unless you explicitly opt in (not implemented in the default extension).
- **Where it is stored:** Data is stored only in Chrome’s local storage on your machine (`chrome.storage.local`). It is never uploaded.
- **Incognito:** If you enable the extension in Incognito, that data is kept separate from your normal browsing data and is still only on your device.

## What we do not do

- We do **not** send any data to the internet.
- We do **not** use analytics, tracking, or third-party scripts.
- We do **not** sell or share data (there is no data to share).

## Your control

- **Export:** You can export your data as JSON or CSV from the extension popup.
- **Delete:** You can delete all stored data at any time via “Delete all data” in the popup.
- **Exclude domains:** In Settings you can add domains to exclude from tracking.

## Permissions

The extension requests:

- **tabs** — To know which tab is active and its hostname (for time tracking).
- **storage** — To save your usage data locally.
- **alarms** — To persist data periodically without keeping the background script always active.
- **idle** — To stop counting time when you are idle.

No “host” or “broad” website access is required for basic tracking; the extension only reads tab metadata (e.g. URL) to derive the hostname.

## Contact

This is an open-source, local-first extension. For questions about privacy or the code, refer to the project repository or documentation.
