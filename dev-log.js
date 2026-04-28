// Developer log — only active when LAI.DEV_MODE is true.
// Stores post extractions + detection results in chrome.storage.local so the
// user can export them as a labeled dataset from the popup.
//
// Storage: one key per entry — 'litmus:devlog:<timestamp>' — so each write is
// O(1) in entry count regardless of how many entries exist. This prevents the
// single-array pattern from growing unboundedly and triggering quota errors.
// Max 200 entries are kept; excess oldest entries are pruned asynchronously.

(function (LAI) {

  const KEY_PREFIX  = 'litmus:devlog:';
  const MAX_ENTRIES = 200;

  // ── Public API ──────────────────────────────────────────────────────────────

  LAI.DevLog = {

    // Append one post + its detection result to the log.
    // Silently no-ops when DEV_MODE is false.
    async logPost(extracted, detection) {
      if (!LAI.DEV_MODE) return;

      const ts = Date.now();
      const entry = {
        ts,
        cacheKey:   extracted.cacheKey,
        author:     extracted.author,
        wordCount:  extracted.wordCount,
        isReshare:  extracted.isReshare,
        hasMedia:   extracted.hasMedia,
        isPromoted:       extracted.isPromoted,
        isSuggested:      extracted.isSuggested,
        isRecommendedFor: extracted.isRecommendedFor,
        text:       extracted.text ?? null,
        label:      detection.label,
        score:      detection.score,
        confidence: detection.confidenceCategory ?? detection.confidence ?? null,
        // Placeholder for manual ground-truth labelling in the dataset.
        groundTruth: null,
      };

      // Write a single per-entry key — O(1) cost regardless of log size.
      try {
        await LAI.safeStorage.set({ [KEY_PREFIX + ts]: entry });
      } catch (err) {
        console.warn(`${LAI.LOG_PREFIX} DevLog.logPost failed:`, err.message);
        return;
      }

      // Prune excess entries — async so the write path is not blocked.
      _pruneIfNeeded().catch(() => {});
    },

    // Return all entries as a JSON string ready for download, newest first.
    async exportAsJSON() {
      try {
        const all     = await LAI.safeStorage.get(null);
        const entries = _collectEntries(all);
        entries.sort((a, b) => b.ts - a.ts);
        return JSON.stringify(entries, null, 2);
      } catch {
        return '[]';
      }
    },

    // Remove all log entries.
    async clearLog() {
      try {
        const all  = await LAI.safeStorage.get(null);
        const keys = Object.keys(all).filter(k => _isDevlogKey(k, all[k]));
        if (keys.length) await LAI.safeStorage.remove(keys);
      } catch (err) {
        console.warn(`${LAI.LOG_PREFIX} DevLog.clearLog failed:`, err.message);
      }
    },

    // How many entries are currently stored.
    async getLogSize() {
      try {
        const all = await LAI.safeStorage.get(null);
        return Object.keys(all).filter(k => _isDevlogKey(k, all[k])).length;
      } catch {
        return 0;
      }
    },
  };

  // ── Internal helpers ────────────────────────────────────────────────────────

  // Guard: a valid per-entry key starts with the prefix and holds an object
  // with a numeric ts field. This excludes the legacy 'litmus:devlog:entries'
  // array key that may exist before migration 8 completes.
  function _isDevlogKey(key, value) {
    return key.startsWith(KEY_PREFIX) && typeof value?.ts === 'number';
  }

  function _collectEntries(all) {
    return Object.entries(all)
      .filter(([k, v]) => _isDevlogKey(k, v))
      .map(([, v]) => v);
  }

  async function _pruneIfNeeded() {
    const all   = await LAI.safeStorage.get(null);
    const pairs = Object.entries(all).filter(([k, v]) => _isDevlogKey(k, v));
    if (pairs.length <= MAX_ENTRIES) return;

    // Sort oldest first by the entry's own timestamp, then delete the excess.
    pairs.sort((a, b) => (a[1].ts ?? 0) - (b[1].ts ?? 0));
    const toDelete = pairs.slice(0, pairs.length - MAX_ENTRIES).map(([k]) => k);
    await LAI.safeStorage.remove(toDelete);
  }

}(window.LAI = window.LAI || {}));
