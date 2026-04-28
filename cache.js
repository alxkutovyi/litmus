// Thin wrapper around chrome.storage.local.
// All keys are namespaced with PREFIX to isolate post entries from any other
// storage this extension may add later (popup state, settings, etc.).
//
// Byte-aware eviction: every EVICT_EVERY writes (and on startup), checks actual
// storage consumption via getBytesInUse(). Evicts oldest 20% of post:* entries
// when usage exceeds EVICT_THRESHOLD_BYTES (8 MB, 80% of the 10 MB default).
// LAI.Cache._emergencyEvict() is also exposed for safeStorage.set to call
// on quota errors before retrying the write.
(function (LAI) {

  const PREFIX                = 'post:';
  const STATS_KEY             = 'litmus:stats:cache';
  const EVICT_EVERY           = 50;                  // write-interval between checks
  const EVICT_THRESHOLD_BYTES = 8 * 1024 * 1024;    // 8 MB → trigger eviction
  const EVICT_PCT             = 0.20;                // drop oldest 20% of post:* entries

  let _writeCount = 0;

  // Returns all post:* [key, value] pairs sorted oldest-first by cachedAt.
  async function _getPostPairsSorted() {
    const all = await LAI.safeStorage.get(null);
    const pairs = Object.entries(all).filter(([k]) => k.startsWith(PREFIX));
    pairs.sort((a, b) => (a[1]?.cachedAt ?? 0) - (b[1]?.cachedAt ?? 0));
    return pairs;
  }

  async function _evictIfNeeded() {
    let bytesInUse;
    try {
      bytesInUse = await chrome.storage.local.getBytesInUse(null);
    } catch {
      return; // Can't check — skip this cycle.
    }
    if (bytesInUse < EVICT_THRESHOLD_BYTES) return;

    const pairs = await _getPostPairsSorted();
    if (!pairs.length) return;

    const evictCount = Math.max(1, Math.ceil(pairs.length * EVICT_PCT));
    const toDelete   = pairs.slice(0, evictCount).map(([k]) => k);
    await LAI.safeStorage.remove(toDelete);
    console.log(`${LAI.LOG_PREFIX} cache evicted ${toDelete.length} oldest entries (storage was ${Math.round(bytesInUse / 1024)} KB)`);
  }

  // Called by safeStorage.set when a quota error is caught.
  // Evicts 30% of post:* entries to make room, then returns so the caller can retry.
  async function _emergencyEvict() {
    const pairs = await _getPostPairsSorted();
    if (!pairs.length) return;
    const evictCount = Math.max(1, Math.ceil(pairs.length * 0.30));
    const toDelete   = pairs.slice(0, evictCount).map(([k]) => k);
    await LAI.safeStorage.remove(toDelete);
    console.warn(`${LAI.LOG_PREFIX} emergency eviction: removed ${toDelete.length} cache entries`);
  }

  LAI.Cache = {

    async get(cacheKey) {
      const storageKey = PREFIX + cacheKey;
      const result = await LAI.safeStorage.get(storageKey);
      return result[storageKey] ?? null;
    },

    async set(cacheKey, value) {
      await LAI.safeStorage.set({ [PREFIX + cacheKey]: value });
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
      const all = await LAI.safeStorage.get(null);
      return Object.keys(all).filter(k => k.startsWith(PREFIX)).length;
    },

    // Returns accumulated hit/miss counters persisted by content.js.
    async getStats() {
      const result = await LAI.safeStorage.get(STATS_KEY);
      return result[STATS_KEY] ?? { hits: 0, misses: 0 };
    },

    // Removes all post:* entries. Intended for DevTools debugging only.
    async clear() {
      const all = await LAI.safeStorage.get(null);
      const postKeys = Object.keys(all).filter(k => k.startsWith(PREFIX));
      if (postKeys.length > 0) await LAI.safeStorage.remove(postKeys);
    },

    // Exposed for safeStorage.set quota-error recovery.
    _emergencyEvict,
  };

  // Evict on startup to clean up any over-threshold data from previous sessions.
  _evictIfNeeded().catch(() => {});

}(window.LAI = window.LAI || {}));
