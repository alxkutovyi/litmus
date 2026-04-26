// Single source of truth for all LinkedIn DOM selectors.
// Architecture rule: nothing else in the codebase may inline a selector string.
(function (LAI) {

  LAI.SELECTORS = {

    // Verified against 6 samples (April 2026). role="listitem" is semantic and
    // stable; componentkey is LinkedIn's own internal key that survives hashed
    // class-name redeploys.
    POST_WRAPPER: [
      'div[role="listitem"][componentkey*="FeedType_MAIN_FEED"]',
      // Fallback: less specific — matches any listitem inside the feed container.
      'div[data-testid="mainFeed"] div[role="listitem"]',
    ],

    POST_BODY: '[data-testid="expandable-text-box"]',

    FEED_CONTAINER: 'div[data-testid="mainFeed"]',

    // HYPOTHESIS — not verified against a real promoted post.
    // LinkedIn marks sponsored posts with a "Promoted" label. Class names are
    // volatile so the candidates below use structural/attribute anchors only.
    // TODO: capture a real promoted post HTML and replace with a confirmed selector.
    PROMOTED_MARKER: [
      '[data-testid="feed-item-promoted-tag"]',
      '[data-testid="sponsored-tag"]',
      '[aria-label="Promoted"]',
      '[componentkey*="SPONSORED"]',
    ],
  };

  // Try each selector in order; return the first element found, or null.
  LAI.findFirst = function (element, selectorList) {
    for (const selector of selectorList) {
      const match = element.querySelector(selector);
      if (match) return match;
    }
    return null;
  };

  // Extract the stable post ID from the componentkey attribute.
  // Pattern: "expanded{ID}FeedType_MAIN_FEED_RELEVANCE"
  // Returns null if the pattern doesn't match (caller must handle the fallback).
  LAI.getCacheKey = function (postElement) {
    const raw = postElement.getAttribute('componentkey') ?? '';
    const match = raw.match(/^expanded(.+?)FeedType_/);
    return match ? match[1] : null;
  };

}(window.LAI = window.LAI || {}));
