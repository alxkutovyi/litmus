// Computed auto-hidden state — never stored, always derived from authorStats + thresholds.
//
// An author is auto-hidden when:
//   • NOT in the manual blacklist
//   • NOT in the manual whitelist
//   • post count >= minPosts
//   • AI% >= aiThreshold
//
// Loaded AFTER author-stats.js (per manifest order) so AuthorStats.update()
// can call LAI.AutoHidden.recompute() immediately after a storage write.

(function (LAI) {

  const STATS_KEY        = 'litmus:authorStats';
  const BLACKLIST_KEY    = 'litmus:blacklist';
  const WHITELIST_KEY    = 'litmus:whitelist';
  const MIN_POSTS_KEY    = 'litmus:minPosts';
  const AI_THRESHOLD_KEY = 'litmus:aiThreshold';

  const DEFAULT_MIN_POSTS    = 5;
  const DEFAULT_AI_THRESHOLD = 80;

  let _hiddenSet   = new Set();  // authorId strings currently auto-hidden
  let _hiddenList  = [];         // [{authorId, name, profileUrl, posts, aiCount, mixed, human, lastSeen}]
  let _onRemovedCb = null;       // called when authors leave the hidden set

  async function recompute() {
    let data;
    try {
      data = await LAI.safeStorage.get([
        STATS_KEY, BLACKLIST_KEY, WHITELIST_KEY,
        MIN_POSTS_KEY, AI_THRESHOLD_KEY,
      ]);
    } catch { return; }

    const stats       = data[STATS_KEY]       ?? {};
    const blacklist   = data[BLACKLIST_KEY]   ?? [];
    const whitelist   = data[WHITELIST_KEY]   ?? [];
    const minPosts    = data[MIN_POSTS_KEY]    ?? DEFAULT_MIN_POSTS;
    const aiThreshold = data[AI_THRESHOLD_KEY] ?? DEFAULT_AI_THRESHOLD;

    const blacklistIds = new Set(blacklist.map(e => e.authorId));
    const whitelistIds = new Set(whitelist.map(e => e.authorId));

    const prevSet = _hiddenSet;
    const newSet  = new Set();
    const newList = [];

    for (const [id, record] of Object.entries(stats)) {
      if (blacklistIds.has(id) || whitelistIds.has(id)) continue;
      const posts   = record.posts ?? [];
      const total   = posts.length;
      if (total < minPosts || total === 0) continue;
      const aiCount = posts.filter(p => p.label === 'ai').length;
      if (aiCount / total * 100 < aiThreshold) continue;

      newSet.add(id);
      newList.push({
        authorId:   id,
        name:       record.name       ?? null,
        profileUrl: record.profileUrl ?? null,
        posts:      total,
        aiCount,
        mixed:    posts.filter(p => p.label === 'mixed').length,
        human:    posts.filter(p => p.label === 'human').length,
        lastSeen: record.lastSeen ?? 0,
      });
    }

    // Find authors that just dropped out of the hidden set.
    const removed = [];
    for (const id of prevSet) {
      if (!newSet.has(id)) removed.push(id);
    }

    _hiddenSet  = newSet;
    _hiddenList = newList;

    if (removed.length && _onRemovedCb) {
      try { _onRemovedCb(removed); } catch { /* non-critical */ }
    }
  }

  // Recompute whenever relevant storage keys change.
  chrome.storage.onChanged.addListener((changes, area) => {
    try { if (!chrome.runtime?.id) return; } catch { return; }
    if (area !== 'local') return;
    const keys = [STATS_KEY, BLACKLIST_KEY, WHITELIST_KEY, MIN_POSTS_KEY, AI_THRESHOLD_KEY];
    if (keys.some(k => k in changes)) recompute();
  });

  recompute(); // initial load

  // ── Public API ──────────────────────────────────────────────────────────────

  LAI.AutoHidden = {

    // Synchronous — safe on the hot post-processing path.
    has(authorId) { return _hiddenSet.has(authorId); },

    // Returns a snapshot of the current auto-hidden list.
    list() { return [..._hiddenList]; },

    // Manually trigger a recompute (called by action-dispatcher after threshold cross).
    recompute,

    // Register a callback called with [authorId, ...] when authors leave the set.
    // content.js uses this to unhide visible posts when the threshold is loosened.
    onRemoved(fn) { _onRemovedCb = fn; },

  };

}(window.LAI = window.LAI || {}));
