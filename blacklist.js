// Manages the hide blacklist.
// Storage key: 'litmus:blacklist'
// Schema: [{ authorId, name, profileUrl, hiddenAt, aiRateAtHide, postsAtHide: {ai, total} }]
//
// Uses an in-memory Set for synchronous has() checks — the Set is populated
// from storage on init and kept in sync via chrome.storage.onChanged.
(function (LAI) {

  const BLACKLIST_KEY = 'litmus:blacklist';

  let _cache = new Set(); // authorId strings

  // ── Init ────────────────────────────────────────────────────────────────────

  chrome.storage.local.get(BLACKLIST_KEY).then(result => {
    const list = result[BLACKLIST_KEY] ?? [];
    _cache = new Set(list.map(e => e.authorId));
  }).catch(() => { /* extension context not ready yet — _cache stays empty */ });

  // Keep in-memory cache in sync whenever storage changes (handles cross-tab
  // unhides triggered from the stats page).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !(BLACKLIST_KEY in changes)) return;
    const newList = changes[BLACKLIST_KEY].newValue ?? [];
    _cache = new Set(newList.map(e => e.authorId));
  });

  // ── Public API ──────────────────────────────────────────────────────────────

  LAI.Blacklist = {

    // Synchronous — safe to call from the hot post-processing path.
    has(authorId) {
      return _cache.has(authorId);
    },

    async add(entry) {
      if (!entry?.authorId) return;
      if (_cache.has(entry.authorId)) return; // already hidden

      _cache.add(entry.authorId);
      const result   = await chrome.storage.local.get(BLACKLIST_KEY);
      const list     = result[BLACKLIST_KEY] ?? [];
      const filtered = list.filter(e => e.authorId !== entry.authorId); // dedup
      filtered.push(entry);
      await chrome.storage.local.set({ [BLACKLIST_KEY]: filtered });
    },

    async remove(authorId) {
      if (!authorId) return;
      _cache.delete(authorId);
      const result   = await chrome.storage.local.get(BLACKLIST_KEY);
      const list     = result[BLACKLIST_KEY] ?? [];
      const filtered = list.filter(e => e.authorId !== authorId);
      await chrome.storage.local.set({ [BLACKLIST_KEY]: filtered });
    },

    async getAll() {
      const result = await chrome.storage.local.get(BLACKLIST_KEY);
      return result[BLACKLIST_KEY] ?? [];
    },

  };

}(window.LAI = window.LAI || {}));
