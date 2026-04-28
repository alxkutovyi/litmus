// Global namespace pattern — all content-script files listed in manifest.json
// share one isolated JS world and can read/write window.LAI.
//
// "type":"module" is not used because Chrome's support for ES module content
// scripts is inconsistent across versions. The global namespace is simpler
// and fully reliable. See manifest.json for load order.
(function (LAI) {
  LAI.VERSION    = '0.2.3';
  LAI.DEV_MODE   = true;
  LAI.LOG_PREFIX = '[Litmus]';

  // Default thresholds — actual values live in storage (minPosts, aiThreshold).
  // These are used only when storage hasn't been written yet (first run).
  LAI.DEFAULT_MIN_POSTS    = 5;
  LAI.DEFAULT_AI_THRESHOLD = 80; // integer percent

  // ── Extension context guard ────────────────────────────────────────────────
  // Returns false after the extension is reloaded/uninstalled while the tab
  // stays open — chrome.runtime.id becomes undefined in that state.
  function isExtensionContextValid() {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  }

  // Safe wrappers around chrome.storage.local — silently no-op when the
  // extension context has been invalidated (e.g. after a reload without a
  // tab refresh). Only needed in content scripts; background/popup/stats pages
  // always have a fresh context.
  LAI.safeStorage = {
    async get(keyOrKeys) {
      if (!isExtensionContextValid()) return {};
      try {
        return await chrome.storage.local.get(keyOrKeys);
      } catch (err) {
        if (/context invalidated/i.test(err.message)) return {};
        throw err;
      }
    },
    async set(items) {
      if (!isExtensionContextValid()) return;
      try {
        await chrome.storage.local.set(items);
      } catch (err) {
        if (/context invalidated/i.test(err.message)) return;
        if (/quota/i.test(err.message)) {
          // Storage full — evict cache entries and retry once.
          if (LAI.Cache?._emergencyEvict) {
            try { await LAI.Cache._emergencyEvict(); } catch { /* best-effort */ }
          }
          try {
            await chrome.storage.local.set(items);
          } catch (retryErr) {
            console.warn(`${LAI.LOG_PREFIX} safeStorage.set: quota retry failed, dropping write`);
          }
          return;
        }
        throw err;
      }
    },
    async remove(keyOrKeys) {
      if (!isExtensionContextValid()) return;
      try {
        await chrome.storage.local.remove(keyOrKeys);
      } catch (err) {
        if (/context invalidated/i.test(err.message)) return;
        throw err;
      }
    },
  };

  // Safe wrapper around chrome.runtime.sendMessage — returns
  // { error: 'context-invalid' } instead of throwing when the context is gone.
  LAI.safeSendMessage = async function(message) {
    if (!isExtensionContextValid()) return { error: 'context-invalid' };
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (err) {
      if (/context invalidated|message port closed/i.test(err.message)) {
        return { error: 'context-invalid' };
      }
      throw err;
    }
  };

}(window.LAI = window.LAI || {}));
