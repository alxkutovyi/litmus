// Per-author AI detection tracking.
// Maintains a rolling 90-day window of post classifications per author,
// capped at 200 posts per author to bound storage growth.
//
// Storage key: 'litmus:authorStats'
// Schema: { [authorId]: { authorId, name, profileUrl, posts, lastSeen } }
//   posts: [{ postId, label, seenAt }]
(function (LAI) {

  const STATS_KEY          = 'litmus:authorStats';
  const NINETY_DAYS_MS     = 90 * 24 * 60 * 60 * 1000;
  const MAX_POSTS_PER_AUTHOR = 200;

  LAI.AuthorStats = {

    // Record a classified post for an author.
    // authorId   — LinkedIn profile slug (e.g. "nazar-mozgovoy")
    // name       — display name (may be null for company pages)
    // profileUrl — full profile URL
    // postId     — cacheKey (the :v3 key) used as a stable post identifier
    // label      — 'ai' | 'human' | 'mixed' | 'uncertain'
    // score      — 0–1 probability from the classifier (optional)
    async update(authorId, name, profileUrl, postId, label, score) {
      if (!authorId || !postId) return;

      const result = await LAI.safeStorage.get(STATS_KEY);
      const stats  = result[STATS_KEY] ?? {};

      const now    = Date.now();
      const record = stats[authorId] ?? {
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

      // Cap: keep the 200 most-recent posts.
      if (record.posts.length > MAX_POSTS_PER_AUTHOR) {
        record.posts.sort((a, b) => (b.timestamp ?? b.seenAt ?? 0) - (a.timestamp ?? a.seenAt ?? 0));
        record.posts = record.posts.slice(0, MAX_POSTS_PER_AUTHOR);
      }

      // Refresh mutable metadata.
      if (name)       record.name       = name;
      if (profileUrl) record.profileUrl = profileUrl;
      record.lastSeen = now;

      stats[authorId] = record;
      await LAI.safeStorage.set({ [STATS_KEY]: stats });

      // Trigger AutoHidden recompute — guard because this file loads before auto-hidden.js.
      if (LAI.AutoHidden?.recompute) LAI.AutoHidden.recompute();
    },

  };

}(window.LAI = window.LAI || {}));
