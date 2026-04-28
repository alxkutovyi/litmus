// Threshold check and hide dispatch.
// Called from content.js after every AuthorStats.update().
// If the author's current stats cross the configured threshold and they are
// not already blacklisted, adds them to the blacklist and hides their
// already-rendered posts in this tab.
(function (LAI) {

  const MIN_POSTS_KEY       = 'litmus:minPosts';
  const AI_THRESHOLD_KEY    = 'litmus:aiThreshold';
  const AUTHOR_STATS_PREFIX = 'litmus:authorStats:';

  // Threshold cache — invalidated whenever the settings keys change.
  let _thresholds = null;

  chrome.storage.onChanged.addListener((changes, area) => {
    try { if (!chrome.runtime?.id) return; } catch { return; }
    if (area === 'local' && (MIN_POSTS_KEY in changes || AI_THRESHOLD_KEY in changes)) {
      _thresholds = null;
    }
  });

  async function getThresholds() {
    if (_thresholds) return _thresholds;
    const result = await LAI.safeStorage.get([MIN_POSTS_KEY, AI_THRESHOLD_KEY]);
    _thresholds = {
      minPosts:    result[MIN_POSTS_KEY]     ?? LAI.DEFAULT_MIN_POSTS    ?? 5,
      aiThreshold: result[AI_THRESHOLD_KEY]  ?? LAI.DEFAULT_AI_THRESHOLD ?? 80,
    };
    return _thresholds;
  }

  LAI.ActionDispatcher = {

    // authorId, name, profileUrl — from the extracted post data.
    // Reads current authorStats from storage, checks threshold, hides if needed.
    async maybeHide(authorId, name, profileUrl) {
      if (!authorId) return;
      if (LAI.Blacklist.has(authorId))   return; // manually hidden
      if (LAI.AutoHidden.has(authorId))  return; // already auto-hidden

      const { minPosts, aiThreshold } = await getThresholds();

      const storageKey = AUTHOR_STATS_PREFIX + authorId;
      const result     = await LAI.safeStorage.get(storageKey);
      const record     = result[storageKey];
      if (!record) return;

      const posts   = record.posts ?? [];
      const total   = posts.length;
      if (total < minPosts) return;

      const aiCount = posts.filter(p => p.label === 'ai').length;
      const aiRate  = aiCount / total;
      if (aiRate * 100 < aiThreshold) return;

      // Threshold crossed — recompute auto-hidden set and hide visible posts.
      // The author's status stays "auto" — NOT added to the manual blacklist.
      await LAI.AutoHidden.recompute();
      LAI.hideVisiblePostsFromAuthor(authorId, name);
    },

  };

}(window.LAI = window.LAI || {}));
