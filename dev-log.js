// Developer log — only active when LAI.DEV_MODE is true.
// Stores post extractions + detection results in chrome.storage.local so the
// user can export them as a labeled dataset from the popup.
//
// Key: 'litmus:devlog:entries'  Value: array of entry objects, newest first, max 1000.

(function (LAI) {

  const STORAGE_KEY = 'litmus:devlog:entries';
  const MAX_ENTRIES = 1000;

  // ── Public API ──────────────────────────────────────────────────────────────

  LAI.DevLog = {

    // Append one post + its detection result to the log.
    // Silently no-ops when DEV_MODE is false.
    async logPost(extracted, detection) {
      if (!LAI.DEV_MODE) return;

      const entry = {
        ts:         Date.now(),
        cacheKey:   extracted.cacheKey,
        author:     extracted.author,
        wordCount:  extracted.wordCount,
        isReshare:  extracted.isReshare,
        hasMedia:   extracted.hasMedia,
        isPromoted:   extracted.isPromoted,
        isSuggested:      extracted.isSuggested,
        isRecommendedFor: extracted.isRecommendedFor,
        text:       extracted.text,
        score:      detection.score,
        label:      detection.label,
        confidence: detection.confidence,
        reasons:    detection.reasons,
        // Placeholder for manual ground-truth labelling in the dataset.
        groundTruth: null,
      };

      let entries;
      try {
        const result = await LAI.safeStorage.get(STORAGE_KEY);
        entries = result[STORAGE_KEY] ?? [];
      } catch {
        entries = [];
      }

      // Newest first, capped at MAX_ENTRIES.
      entries.unshift(entry);
      if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;

      try {
        await LAI.safeStorage.set({ [STORAGE_KEY]: entries });
      } catch (err) {
        console.warn(`${LAI.LOG_PREFIX} DevLog.logPost failed:`, err.message);
      }
    },

    // Return all entries as a JSON string ready for download.
    async exportAsJSON() {
      try {
        const result = await LAI.safeStorage.get(STORAGE_KEY);
        return JSON.stringify(result[STORAGE_KEY] ?? [], null, 2);
      } catch {
        return '[]';
      }
    },

    // Remove all log entries.
    async clearLog() {
      try {
        await LAI.safeStorage.remove(STORAGE_KEY);
      } catch (err) {
        console.warn(`${LAI.LOG_PREFIX} DevLog.clearLog failed:`, err.message);
      }
    },

    // How many entries are currently stored.
    async getLogSize() {
      try {
        const result = await LAI.safeStorage.get(STORAGE_KEY);
        return (result[STORAGE_KEY] ?? []).length;
      } catch {
        return 0;
      }
    },
  };

}(window.LAI = window.LAI || {}));
