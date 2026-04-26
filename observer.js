(function (LAI) {

  const seen = new WeakSet();

  let activeObserver = null;
  let feedWatcher    = null;

  // ── Helpers ───────────────────────────────────────────────────────────────

  function matchesPostWrapper(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return false;
    return LAI.SELECTORS.POST_WRAPPER.some(sel => node.matches(sel));
  }

  function processNode(node, onNewPost) {
    if (matchesPostWrapper(node)) {
      if (!seen.has(node)) { seen.add(node); onNewPost(node); }
    }
    // Also scan descendants — LinkedIn sometimes inserts a container holding
    // multiple posts rather than individual post nodes.
    for (const sel of LAI.SELECTORS.POST_WRAPPER) {
      node.querySelectorAll?.(sel).forEach(el => {
        if (!seen.has(el)) { seen.add(el); onNewPost(el); }
      });
    }
  }

  // ── Feed attachment ────────────────────────────────────────────────────────

  function attachToFeed(container, onNewPost) {
    let count = 0;
    for (const sel of LAI.SELECTORS.POST_WRAPPER) {
      container.querySelectorAll(sel).forEach(el => {
        if (!seen.has(el)) { seen.add(el); onNewPost(el); count++; }
      });
    }
    console.log(`${LAI.LOG_PREFIX} attached to feed, flushed ${count} initial posts`);

    const mo = new MutationObserver(mutations => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          processNode(node, onNewPost);
        }
      }
    });
    mo.observe(container, { childList: true, subtree: true });
    return mo;

    // Known gap: if LinkedIn replaces the container node itself mid-session,
    // this observer silently stops. SPA navigation is handled separately;
    // an in-place container swap is documented but not yet observed.
  }

  // ── Wait for posts ─────────────────────────────────────────────────────────
  //
  // Previous approach: wait for the feed *container* to appear, then attach.
  // Bug: the container (LinkedIn's LazyColumn) appears in the DOM as an empty
  // shell before React renders posts into it. The observer attached to the
  // empty shell and the initial flush found 0 posts. Subsequent post additions
  // were also missed, likely because LinkedIn swaps or re-parents the container
  // node before populating it.
  //
  // Fix: wait for the first actual *post wrapper* to appear. By that point the
  // container is fully initialised and all initial posts are present, so the
  // flush in attachToFeed catches everything, and the MutationObserver handles
  // scroll-loaded additions normally.

  function findFirstPost() {
    for (const sel of LAI.SELECTORS.POST_WRAPPER) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function waitForFeed(onNewPost) {
    const firstPost = findFirstPost();

    if (firstPost) {
      // Posts already in DOM — find the container they live in and attach.
      const container =
        document.querySelector(LAI.SELECTORS.FEED_CONTAINER) ?? document.body;
      activeObserver = attachToFeed(container, onNewPost);
      return;
    }

    // No posts yet — watch the entire body until the first post wrapper appears.
    // We watch body (not the container) because the container itself may not
    // exist or may be replaced before posts are inserted.
    console.log(`${LAI.LOG_PREFIX} no posts in DOM yet, watching body for first post`);
    feedWatcher = new MutationObserver(() => {
      const post = findFirstPost();
      if (post) {
        feedWatcher.disconnect();
        feedWatcher = null;
        const container =
          document.querySelector(LAI.SELECTORS.FEED_CONTAINER) ?? document.body;
        activeObserver = attachToFeed(container, onNewPost);
      }
    });
    feedWatcher.observe(document.body, { childList: true, subtree: true });
  }

  function teardown() {
    activeObserver?.disconnect(); activeObserver = null;
    feedWatcher?.disconnect();    feedWatcher    = null;
  }

  // ── SPA navigation ─────────────────────────────────────────────────────────

  let navigationPatched = false;
  function patchNavigation() {
    if (navigationPatched) return;
    navigationPatched = true;
    ['pushState', 'replaceState'].forEach(method => {
      const orig = history[method].bind(history);
      history[method] = function (...args) {
        orig(...args);
        window.dispatchEvent(new Event('ld-ai-locationchange'));
      };
    });
    window.addEventListener('popstate', () =>
      window.dispatchEvent(new Event('ld-ai-locationchange'))
    );
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  LAI.startObserver = function (onNewPost) {
    patchNavigation();
    window.addEventListener('ld-ai-locationchange', () => {
      console.log(`${LAI.LOG_PREFIX} SPA navigation detected, restarting observer`);
      teardown();
      waitForFeed(onNewPost);
    });
    waitForFeed(onNewPost);
  };

}(window.LAI = window.LAI || {}));
