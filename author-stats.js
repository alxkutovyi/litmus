// Per-author AI detection tracking.
// Maintains a rolling 90-day window of post classifications per author,
// capped at 30 posts per author to bound storage growth.
//
// Storage: one key per author — 'litmus:authorStats:<authorId>' — so each
// write is O(1) in author count. Stale authors (lastSeen older than 90 days)
// are evicted asynchronously on every update.
//
// Schema (per key): { authorId, name, profileUrl, posts, lastSeen }
//   posts: [{ postId, label, score, timestamp }]
(function (LAI) {

  const KEY_PREFIX           = 'litmus:authorStats:';
  const NINETY_DAYS_MS       = 90 * 24 * 60 * 60 * 1000;
  const MAX_POSTS_PER_AUTHOR = 30;

  LAI.AuthorStats = {

    // Record a classified post for an author.
    // authorId   — LinkedIn profile slug (e.g. "person:nazar-mozgovoy")
    // name       — display name (may be null for company pages)
    // profileUrl — full profile URL
    // postId     — cacheKey (the :v3 key) used as a stable post identifier
    // label      — 'ai' | 'human' | 'mixed' | 'uncertain'
    // score      — 0–1 probability from the classifier (optional)
    async update(authorId, name, profileUrl, postId, label, score) {
      if (!authorId || !postId) return;

      const storageKey = KEY_PREFIX + authorId;
      const result     = await LAI.safeStorage.get(storageKey);

      const now    = Date.now();
      const record = result[storageKey] ?? {
        authorId,
        name:       name ?? null,   // null until extraction succeeds; never fall back to slug
        profileUrl: profileUrl ?? null,
        posts:      [],
        lastSeen:   now,
      };

      // Dedupe: skip if this exact post has already been recorded.
      if (record.posts.some(p => p.postId === postId)) return;

      // Append new post.
      record.posts.push({ postId, label, score: score ?? null, timestamp: now });

      // Decay: drop posts older than 90 days.
      const cutoff = now - NINETY_DAYS_MS;
      record.posts = record.posts.filter(p => (p.timestamp ?? p.seenAt ?? 0) >= cutoff);

      // Cap: keep the 30 most-recent posts.
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
