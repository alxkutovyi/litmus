# Litmus

A Chrome extension that flags AI-generated posts in your LinkedIn feed using GPTZero.

---

<!-- Screenshot path is a placeholder. Drop docs/screenshot.png into the repo to make this render. -->
![Litmus screenshot](docs/screenshot.png)

---

## What it does

Litmus runs in the background as you scroll your LinkedIn feed. Each post gets an inline
indicator next to the author's name showing whether the post was classified as AI-generated,
mixed, or human-written. The classification happens automatically without any extra clicks.

Litmus tracks per-author AI rates over time. The stats page shows every author you have
encountered, their post count, and what percentage of their posts were classified as
AI-generated. Open the stats page from the toolbar popup at any time.

Authors who cross a configurable threshold — for example 80% AI rate after at least 5 posts —
are automatically hidden from your feed. You can also manually blacklist or whitelist any
author regardless of their rate. The popup lets you undo auto-hides and manage your lists.

Optional filters let you skip promoted posts, suggested posts, company posts, and
"Recommended for you" widget blocks entirely, before any API call is made.

---

## Why it exists

LinkedIn's feed has filled up with AI-generated thought-leadership posts. Litmus is a small
tool to flag that pattern and give you control over what stays in your feed.

---

## Requirements

- Chrome or any Chromium-based browser with Manifest V3 support
- A GPTZero API key. Details available at https://app.gptzero.me/api-subscription.

---

## Installation

1. Clone or download this repo.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked** and select the `litmus` folder.
5. Pin the Litmus icon to your toolbar.
6. Click the toolbar icon, paste your GPTZero API key into the field, and navigate to
   `linkedin.com/feed`.

Posts will start receiving badges as they appear in your feed.

---

## How it works

A content script runs on `linkedin.com/feed` and `linkedin.com/in/*` pages. A
`MutationObserver` watches the DOM and fires whenever new posts appear as you scroll.

For each new post, Litmus extracts the text, deduplicates it by hash, and sends it to the
GPTZero `/v2/predict/text` endpoint via the extension's background service worker. The service
worker holds the API key and makes the outbound fetch; content scripts never touch the key
directly.

Results are stored in `chrome.storage.local` indefinitely. If you scroll past the same post a
second time Litmus shows the cached result immediately without an API call. Per-author stats
are aggregated locally from those cached results. Nothing leaves your machine except the post
text sent to GPTZero for classification.

---

## Privacy

- Litmus sends post text to GPTZero for classification. That is the only outbound network call.
- Your GPTZero API key is stored in `chrome.storage.local` and never leaves your browser.
- Author names, profile URLs, and per-author stats are stored locally and never transmitted.
- No analytics, no telemetry, no tracking of any kind.

---

## Limitations

- GPTZero is not 100% accurate. Treat results as a strong signal, not a verdict.
- Some post types are skipped: image-only posts, video-only posts, very short text, and posts
  already in the local cache.
- LinkedIn's DOM changes occasionally. If posts stop receiving badges, the selectors in
  `selectors.js` may need updating to match LinkedIn's current markup.

---

## Author

- Alexander Kutovyi
- alxkutovyi@gmail.com
- https://www.linkedin.com/in/alexanderkutovyi/

---

## License

MIT — see [LICENSE](LICENSE).

---

## Contributing

PRs welcome. For substantial changes, open an issue first to discuss.
