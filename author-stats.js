// Per-author AI detection tracking.
// Maintains a rolling 90-day window of post classifications per author,
// capped at MAX_POSTS_PER_AUTHOR posts per author to bound storage growth.
//
// Storage: one key per author — 'litmus:authorStats:<authorId>' — so each
// write is O(1) in author count. Stale authors (lastSeen older than 90 days)
// are evicted asynchronously on every update.
//
// Total author count is capped at MAX_AUTHORS via LRU eviction (oldest lastSeen
// is dropped when a new author would exceed the cap).
//
// Schema (per key): { authorId, name, profileUrl, posts, lastSeen }
//   posts: [{ postId, label, timestamp }]
(function (LAI) {

  const KEY_PREFIX           = 'litmus:authorStats:';
  const NINETY_DAYS_MS       = 90 * 24 * 60 * 60 * 1000;

  // Rolling window size for AI-rate calculations. Exposed on LAI so settings
  // UI can reference it for the minPosts cap without hardcoding a second copy.
  const MAX_POSTS_PER_AUTHOR = 20;
  const MAX_AUTHORS          = 3000;

  LAI.MAX_POSTS_PER_AUTHOR = MAX_POSTS_PER_AUTHOR;

  LAI.AuthorStats = {

    // Record a classified post for an author.
    // authorId   — LinkedIn profile slug (e.g. "person:nazar-mozgovoy")
    // name       — display name (may be null for company pages)
    // profileUrl — full profile URL
    // postId     — cacheKey (the :v3 key) used as a stable post identifier
    // label      — 'ai' | 'human' | 'mixed' | 'uncertain'
    async update(authorId, name, profileUrl, postId, label) {
      if (!authorId || !postId) return;

      const storageKey = KEY_PREFIX + authorId;
      const result     = await LAI.safeStorage.get(storageKey);

      const now        = Date.now();
      const isNewAuthor = !result[storageKey];
      const record     = result[storageKey] ?? {
        authorId,
        name:       name ?? null,   // null until extraction succeeds; never fall back to slug
        profileUrl: profileUrl ?? null,
        posts:      [],
        lastSeen:   now,
      };

      // Dedupe: skip if this exact post has already been recorded.
      if (record.posts.some(p => p.postId === postId)) return;

      // LRU cap: when adding a brand-new author, evict the stalest if at the limit.
      if (isNewAuthor) {
        await _evictOldestIfAtCap().catch(() => {});
      }

      // Append new post (score intentionally omitted — only label is used downstream).
      record.posts.push({ postId, label, timestamp: now });

      // Decay: drop posts older than 90 days.
      const cutoff = now - NINETY_DAYS_MS;
      record.posts = record.posts.filter(p => (p.timestamp ?? p.seenAt ?? 0) >= cutoff);

      // Cap: keep the most-recent MAX_POSTS_PER_AUTHOR posts.
      if (record.posts.length > MAX_POSTS_PER_AUTHOR) {
        record.posts.sort((a, b) => (b.timestamp ?? b.seenAt ?? 0) - (a.timestamp ?? a.seenAt ?? 0));
        record.posts = record.posts.slice(0, MAX_POSTS_PER_AUTHOR);
      }

      // Refresh mutable metadata.
      if (name)       record.name       = name;
      if (profileUrl) record.profileUrl = profileUrl;
      record.lastSeen = now;

      await LAI.safeStorage.set({ [storageKey]: record });

      // Evict authors unseen for 90+ days — async so the write path is not blocked.
      _evictStaleAuthors().catch(() => {});

      // Trigger AutoHidden recompute — guard because this file loads before auto-hidden.js.
      if (LAI.AutoHidden?.recompute) LAI.AutoHidden.recompute();
    },

  };

  // ── Internal helpers ────────────────────────────────────────────────────────

  // If the author count is at MAX_AUTHORS, remove the one with the oldest lastSeen.
  async function _evictOldestIfAtCap() {
    const all   = await LAI.safeStorage.get(null);
    const pairs = Object.entries(all).filter(([k]) => k.startsWith(KEY_PREFIX));
    if (pairs.length < MAX_AUTHORS) return;

    // Find the stalest author by lastSeen.
    let oldestKey = null, oldestTs = Infinity;
    for (const [k, v] of pairs) {
      const ts = v?.lastSeen ?? 0;
      if (ts < oldestTs) { oldestTs = ts; oldestKey = k; }
    }
    if (oldestKey) {
      await LAI.safeStorage.remove(oldestKey);
    }
  }

  // Remove all per-author keys whose lastSeen timestamp is older than 90 days.
  async function _evictStaleAuthors() {
    const cutoff    = Date.now() - NINETY_DAYS_MS;
    const all       = await LAI.safeStorage.get(null);
    const staleKeys = Object.entries(all)
      .filter(([k, v]) => k.startsWith(KEY_PREFIX) && (v?.lastSeen ?? Infinity) < cutoff)
      .map(([k]) => k);
    if (staleKeys.length) {
      await LAI.safeStorage.remove(staleKeys);
      console.log(`${window.LAI?.LOG_PREFIX ?? '[Litmus]'} AuthorStats: evicted ${staleKeys.length} stale author(s)`);
    }
  }

}(window.LAI = window.LAI || {}));
