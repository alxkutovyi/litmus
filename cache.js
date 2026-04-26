// Thin wrapper around chrome.storage.local.
// All keys are namespaced with PREFIX to isolate post entries from any other
// storage this extension may add later (popup state, settings, etc.).
//
// LRU eviction: every 100 writes the cache checks whether it holds more than
// 10 000 post:* entries.  If so, the oldest 1 000 (by cachedAt) are deleted.
// This keeps storage growth bounded without a per-entry TTL.
(function (LAI) {

  const PREFIX      = 'post:';
  const STATS_KEY   = 'litmus:stats:cache';
  const EVICT_EVERY = 100;   // check interval (writes)
  const EVICT_MAX   = 10000; // trigger threshold
  const EVICT_COUNT = 1000;  // entries to delete per eviction

  let _writeCount = 0;

  async function _evictIfNeeded() {
    const all        = await chrome.storage.local.get(null);
    const postPairs  = Object.entries(all).filter(([k]) => k.startsWith(PREFIX));
    if (postPairs.length <= EVICT_MAX) return;

    // Sort ascending by cachedAt so index 0 is the oldest.
    postPairs.sort((a, b) => (a[1]?.cachedAt ?? 0) - (b[1]?.cachedAt ?? 0));
    const toDelete = postPairs.slice(0, EVICT_COUNT).map(([k]) => k);
    await chrome.storage.local.remove(toDelete);
    console.log(`${LAI.LOG_PREFIX} cache evicted ${toDelete.length} oldest entries (had ${postPairs.length})`);
  }

  LAI.Cache = {

    async get(cacheKey) {
      const storageKey = PREFIX + cacheKey;
      const result = await chrome.storage.local.get(storageKey);
      return result[storageKey] ?? null;
    },

    async set(cacheKey, value) {
      await chrome.storage.local.set({ [PREFIX + cacheKey]: value });
      _writeCount++;
      if (_writeCount % EVICT_EVERY === 0) {
        _evictIfNeeded().catch(() => { /* non-critical */ });
      }
    },

    async has(cacheKey) {
      return (await LAI.Cache.get(cacheKey)) !== null;
    },

    // Returns the count of post:* entries only — not total extension storage.
    async size() {
      const all = await chrome.storage.local.get(null);
      return Object.keys(all).filter(k => k.startsWith(PREFIX)).length;
    },

    // Returns accumulated hit/miss counters persisted by content.js.
    async getStats() {
      const result = await chrome.storage.local.get(STATS_KEY);
      return result[STATS_KEY] ?? { hits: 0, misses: 0 };
    },

    // Removes all post:* entries. Intended for DevTools debugging only.
    async clear() {
      const all = await chrome.storage.local.get(null);
      const postKeys = Object.keys(all).filter(k => k.startsWith(PREFIX));
      if (postKeys.length > 0) await chrome.storage.local.remove(postKeys);
    },
  };

}(window.LAI = window.LAI || {}));
