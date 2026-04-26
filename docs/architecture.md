# Architecture

## Stack
- Manifest V3 Chrome extension
- Vanilla JS, no framework, no build step
- Target: Chromium browsers (Chrome, Edge, Brave)

## File layout

```
manifest.json   Extension config
content.js      Entry point, injected on linkedin.com
observer.js     MutationObserver for new posts during scroll
selectors.js    Single source of truth for LinkedIn DOM selectors
extractor.js    Extract text + cache key from a post element
cache.js        chrome.storage.local wrapper for post results
ui.js           Render indicator pill on a post
config.js       Version, log prefix, default thresholds
background.js   Service worker — proxies GPTZero API calls
popup/
popup.html      Extension icon popup
popup.js        Session stats, API key management
stats/
stats.html      Author statistics page
stats.js        Stats page logic
dev-log.js      (dev mode only) Log extracted posts for dataset building
```

## Core contracts

### Classifier (GPTZero)
Classification is handled by the background service worker via `chrome.runtime.sendMessage({ type: 'classify', text })`.
The background proxies to `api.gptzero.me/v2/predict/text` and returns `{ label, score, confidenceCategory, engine: 'gptzero' }`.

### Extractor interface
```javascript
// extractor.js
export function extractPost(postElement) {
  return {
    cacheKey: string,       // stable ID from componentkey
    author: string,
    text: string,
    wordCount: number,
    hasMedia: boolean,
    isReshare: boolean,
    timestamp: number
  };
}
```

## Selectors (LinkedIn DOM as of April 2026)
All class names on LinkedIn are hashed and volatile. Never rely on class names alone.

### Post wrapper
- Primary: `div[role="listitem"][componentkey*="FeedType_MAIN_FEED"]`
- Fallback: `div[role="listitem"]` inside `div[data-testid="mainFeed"]`

### Post body text
- Primary: `[data-testid="expandable-text-box"]`
- This element appears exactly once per post in all samples.

### Cache key extraction
- Read `componentkey` attribute, match `/^expanded(.+?)FeedType_/`
- The captured group is a stable per-post LinkedIn ID.
- Fallback if pattern doesn't match: SHA-256 of post text (first 200 chars).

### Author name
- Look for `<a>` with `href` matching `/linkedin.com/in/[^/]+/` inside the post wrapper
- Take the `aria-label` or first text node

## Design principles
1. Selectors live ONLY in selectors.js. Never inline. 2-3 fallbacks per selector.
2. MutationObserver, never polling. Never setInterval.
3. Cache by post ID indefinitely in chrome.storage.local. Never re-scan.
4. Classification via GPTZero API only — proxied through background service worker.
5. No telemetry. No external calls. No background scraping.
6. Content script runs only on linkedin.com/feed and /in/*.

