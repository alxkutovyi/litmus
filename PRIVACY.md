# Litmus Privacy Policy

**Last updated: April 26, 2026**

Litmus is a Chrome extension that classifies LinkedIn posts as AI-generated or human-written. This document explains what data Litmus handles and how.

## What data Litmus collects

Litmus reads the following data from LinkedIn pages you visit:

- **Post text** — the body of posts in your feed, used for AI classification.
- **Author information** — names, profile slugs, and profile URLs of post authors, used to track per-author AI rates over time.
- **Post metadata** — flags such as whether a post is promoted, suggested, or from a company page, used for filtering.

Litmus also stores user preferences you configure:

- Your GPTZero API key
- Filter toggle states (skip promoted, skip company posts, etc.)
- Auto-hide rule thresholds
- Manual blacklist and whitelist entries

## Where the data is stored

All data is stored locally in your browser using `chrome.storage.local`. Nothing is uploaded to a Litmus-operated server. There is no Litmus server.

Per-author statistics, blacklists, whitelists, the cache of previously classified posts, and your API key never leave your browser.

## What data is sent to third parties

Litmus sends **post text only** to the GPTZero API (`api.gptzero.me`) for classification. This is your own GPTZero account, accessed using the API key you provide. GPTZero's privacy policy applies to data sent there: https://gptzero.me/privacy

No other third parties receive any data from Litmus. There is no analytics, telemetry, advertising, or tracking.

## What data is NOT collected

Litmus does not collect:

- Your name, email, or any account information from LinkedIn
- Direct messages, connection details, or private LinkedIn data
- Browsing activity outside the LinkedIn feed and individual profile pages
- Any data from sites other than linkedin.com

## Data retention and deletion

Data persists in your browser until you:

- Uninstall the extension (clears all storage)
- Click "Reset stats" on the stats page (clears author statistics and cache)
- Manually clear extension storage from chrome://extensions

You may export or delete your data at any time using the extension's controls.

## Open source

Litmus is open source under the MIT license. The full source code is available at https://github.com/alxkutovyi/litmus. You can verify the privacy claims above by reading the code.

## Contact

Questions or concerns: alxkutovyi@gmail.com