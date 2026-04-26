// Global namespace pattern — all content-script files listed in manifest.json
// share one isolated JS world and can read/write window.LAI.
//
// "type":"module" is not used because Chrome's support for ES module content
// scripts is inconsistent across versions. The global namespace is simpler
// and fully reliable. See manifest.json for load order.
(function (LAI) {
  LAI.VERSION    = '0.2.0';
  LAI.DEV_MODE   = true;
  LAI.LOG_PREFIX = '[Litmus]';

  // Default thresholds — actual values live in storage (minPosts, aiThreshold).
  // These are used only when storage hasn't been written yet (first run).
  LAI.DEFAULT_MIN_POSTS    = 5;
  LAI.DEFAULT_AI_THRESHOLD = 80; // integer percent
}(window.LAI = window.LAI || {}));
