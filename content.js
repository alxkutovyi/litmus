// Entry point. All dependencies are loaded before this file via the manifest
// "js" array and expose their APIs through window.LAI.

const { LOG_PREFIX, VERSION } = window.LAI;

// Storage keys (litmus: namespace).
const _SKIP_PROMOTED_KEY    = 'litmus:skipPromotedPosts';
const _SKIP_SUGGESTED_KEY   = 'litmus:skipSuggestedPosts';
const _SKIP_COMPANY_KEY     = 'litmus:skipCompanyPosts';
const _SKIP_RECOMMENDED_KEY = 'litmus:skipRecommendedFor';
const _BLACKLIST_KEY        = 'litmus:blacklist';
const _SESSION_SCANNED_KEY  = 'litmus:session:scanned';
const _CACHE_STATS_KEY      = 'litmus:stats:cache';

console.log(`${LOG_PREFIX} v${VERSION} loaded on ${location.pathname}`);

let sessionScanned  = 0;
let sessionHits     = 0;  // cache hits since last stats flush
let sessionMisses   = 0;  // cache misses since last stats flush
const sessionCounts = { ai: 0, human: 0, mixed: 0, uncertain: 0 };

// Maps authorId → Set<Element> so action-dispatcher can retroactively hide
// posts from an author the moment their threshold is crossed mid-session.
const _authorPostMap = new Map();
window.LAI._authorPostMap = _authorPostMap;

// ── AutoHidden: unhide visible posts when an author drops out of the set ──────
window.LAI.AutoHidden.onRemoved(removedIds => {
  for (const id of removedIds) {
    const elements = _authorPostMap.get(id);
    if (!elements) continue;
    for (const el of elements) {
      if (document.contains(el)) window.LAI.unhidePost(el, id);
    }
  }
});

// ── Filter-hide helper ────────────────────────────────────────────────────────
// Show or hide all already-rendered posts matching a filter category.
// Called retroactively when the corresponding toggle changes mid-session.
// Independent of the blacklist/auto-hidden system (which uses dataset.laiHidden).

// Returns p/span elements to check for feed labels.
// Searches inside the post element AND in componentkey-bearing siblings of the
// post in its parent wrapper — because LinkedIn places "Promoted" / "Suggested"
// labels in a parent div rather than inside the listitem itself.
function _getLabelEls(post) {
  const fromPost = Array.from(post.querySelectorAll('p, span'));
  const parent   = post.parentElement;
  if (!parent) return fromPost;
  const fromContext = Array.from(
    parent.querySelectorAll('p[componentkey], span[componentkey]')
  ).filter(el =>
    !post.contains(el) &&
    !el.closest('[componentkey*="FeedType_MAIN_FEED"]')
  );
  return [...fromPost, ...fromContext];
}

function applyFilterRetroactively(category, shouldHide) {
  if (shouldHide) {
    const postSel = LAI.SELECTORS.POST_WRAPPER.join(', ');
    document.querySelectorAll(postSel).forEach(post => {
      if (post.dataset.laiFilterHidden) return; // already hidden by another filter
      const labelEls = _getLabelEls(post);
      let matches = false;
      if (category === 'promoted') {
        matches = LAI.SELECTORS.PROMOTED_MARKER.some(sel => !!post.querySelector(sel))
          || labelEls.some(el => /^promoted\b/i.test(el.textContent?.trim()));
      } else if (category === 'suggested') {
        matches = labelEls.some(el => /^suggested$/i.test(el.textContent?.trim()));
      } else if (category === 'company') {
        const hasCompanyLink = Array.from(post.querySelectorAll('a[href*="/company/"]'))
          .filter(a => /\/company\/[^/?#\s]+/.test(a.href) && !a.querySelector('figure'))
          .length > 0;
        const hasPersonLink = !!post.querySelector('a[href*="/in/"] p');
        matches = hasCompanyLink && !hasPersonLink;
      } else if (category === 'recommended') {
        matches = labelEls.some(el => /^recommended for you$/i.test(el.textContent?.trim()));
      }
      if (matches) {
        post.style.display = 'none';
        post.dataset.laiFilterHidden = category;
      }
    });
  } else {
    document.querySelectorAll(`[data-lai-filter-hidden="${category}"]`).forEach(post => {
      post.style.display = '';
      delete post.dataset.laiFilterHidden;
    });
  }
}

// ── Skip-filter setting caches ────────────────────────────────────────────────
let _skipPromotedPosts  = false;
let _skipSuggestedPosts = false;
let _skipCompanyPosts   = false;
let _skipRecommendedFor = false;

// Batch-load all four flags at once. After loading, retroactively apply any
// that are ON — this handles the race between the observer's initial DOM flush
// and the async storage read completing.
chrome.storage.local.get([
  _SKIP_PROMOTED_KEY, _SKIP_SUGGESTED_KEY, _SKIP_COMPANY_KEY, _SKIP_RECOMMENDED_KEY,
]).then(r => {
  _skipPromotedPosts  = !!r[_SKIP_PROMOTED_KEY];
  _skipSuggestedPosts = !!r[_SKIP_SUGGESTED_KEY];
  _skipCompanyPosts   = !!r[_SKIP_COMPANY_KEY];
  _skipRecommendedFor = !!r[_SKIP_RECOMMENDED_KEY];
  if (_skipPromotedPosts)  applyFilterRetroactively('promoted',    true);
  if (_skipSuggestedPosts) applyFilterRetroactively('suggested',   true);
  if (_skipCompanyPosts)   applyFilterRetroactively('company',     true);
  if (_skipRecommendedFor) applyFilterRetroactively('recommended', true);
});

// Live updates when toggles change from the popup.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !(_SKIP_PROMOTED_KEY in changes)) return;
  _skipPromotedPosts = !!changes[_SKIP_PROMOTED_KEY].newValue;
  applyFilterRetroactively('promoted', _skipPromotedPosts);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !(_SKIP_SUGGESTED_KEY in changes)) return;
  _skipSuggestedPosts = !!changes[_SKIP_SUGGESTED_KEY].newValue;
  applyFilterRetroactively('suggested', _skipSuggestedPosts);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !(_SKIP_COMPANY_KEY in changes)) return;
  _skipCompanyPosts = !!changes[_SKIP_COMPANY_KEY].newValue;
  applyFilterRetroactively('company', _skipCompanyPosts);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !(_SKIP_RECOMMENDED_KEY in changes)) return;
  _skipRecommendedFor = !!changes[_SKIP_RECOMMENDED_KEY].newValue;
  applyFilterRetroactively('recommended', _skipRecommendedFor);
});

// ── Blacklist storage listener ────────────────────────────────────────────────
// When the blacklist changes (e.g. an author is unhidden from the stats page),
// restore any of their posts that are currently visible in this tab.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !(_BLACKLIST_KEY in changes)) return;
  const newIds = new Set((changes[_BLACKLIST_KEY].newValue ?? []).map(e => e.authorId));
  const oldIds = new Set((changes[_BLACKLIST_KEY].oldValue ?? []).map(e => e.authorId));
  for (const id of oldIds) {
    if (newIds.has(id)) continue; // still hidden
    const elements = _authorPostMap.get(id);
    if (!elements) continue;
    for (const el of elements) {
      if (document.contains(el)) window.LAI.unhidePost(el, id);
    }
  }
});

window.LAI.startObserver(async postElement => {

  // ── Extract ─────────────────────────────────────────────────────────────
  let extracted;
  try {
    extracted = await window.LAI.extractPost(postElement);
  } catch (err) {
    const snippet = postElement.textContent?.slice(0, 80).replace(/\s+/g, ' ') ?? '';
    console.error(`${LOG_PREFIX} extraction error: ${err.message} | "${snippet}"`);
    return;
  }

  // ── Register in author map (for retroactive hiding) ──────────────────────
  if (extracted.authorId) {
    let postSet = _authorPostMap.get(extracted.authorId);
    if (!postSet) { postSet = new Set(); _authorPostMap.set(extracted.authorId, postSet); }
    postSet.add(postElement);
  }

  // ── Hide check (manual blacklist + auto-hidden) ──────────────────────────
  // Both are synchronous in-memory checks — no storage read on the hot path.
  if (extracted.authorId && (
    window.LAI.Blacklist.has(extracted.authorId) ||
    window.LAI.AutoHidden.has(extracted.authorId)
  )) {
    window.LAI.hidePost(postElement, extracted.authorId, extracted.author);
    return;
  }

  // ── Promoted skip (runs before company skip — more specific) ─────────────
  if (_skipPromotedPosts && extracted.isPromoted) {
    if (LAI.DEV_MODE) console.log(`${LOG_PREFIX} skipping promoted post (skip-promoted enabled)`);
    postElement.style.display = 'none';
    postElement.dataset.laiFilterHidden = 'promoted';
    return;
  }

  // ── Suggested skip ───────────────────────────────────────────────────────
  if (_skipSuggestedPosts && extracted.isSuggested) {
    if (LAI.DEV_MODE) console.log(`${LOG_PREFIX} skipping suggested post (skip-suggested enabled)`);
    postElement.style.display = 'none';
    postElement.dataset.laiFilterHidden = 'suggested';
    return;
  }

  // ── Company skip ─────────────────────────────────────────────────────────
  if (_skipCompanyPosts && extracted.authorType === 'company') {
    if (LAI.DEV_MODE) console.log(`${LOG_PREFIX} skipping company post (skip-companies enabled)`);
    postElement.style.display = 'none';
    postElement.dataset.laiFilterHidden = 'company';
    return;
  }

  // ── Recommended for you skip ─────────────────────────────────────────────
  if (_skipRecommendedFor && extracted.isRecommendedFor) {
    if (LAI.DEV_MODE) console.log(`${LOG_PREFIX} hiding recommended-for-you widget (skip-recommended enabled)`);
    postElement.style.display = 'none';
    postElement.dataset.laiFilterHidden = 'recommended';
    return;
  }

  // ── Skip posts with no text (image-only, video-only, etc.) ───────────────
  if (!extracted.text) {
    console.log(`${LOG_PREFIX} skipping: no text`);
    window.LAI.injectBadge(postElement, 'skipped');
    return;
  }

  const key = extracted.cacheKey;

  // ── Cache hit ────────────────────────────────────────────────────────────
  const existingEntry = await window.LAI.Cache.get(key);

  if (existingEntry && !existingEntry.needsReextraction) {
    const det = existingEntry.detected;

    // Cache hit only when GPTZero produced the result.
    // Entries from old stub classifier fall through to full re-classification.
    const engineMatch = det?.engine === 'gptzero';

    if (engineMatch) {
      const label = det.label ?? 'uncertain';
      console.log(`${LOG_PREFIX} cache hit: ${key} (${label})`);
      sessionHits++;
      // Backfill author stats from cached extraction data.
      // update() is idempotent (dedupes by postId), so repeated scroll-past
      // of the same post is a safe no-op after the first recording.
      const ex = existingEntry.extracted;
      if (ex?.authorId) {
        // Normalize: old cache entries may have un-namespaced slugs (pre-migration).
        const exId = ex.authorId.includes(':') ? ex.authorId : `person:${ex.authorId}`;
        window.LAI.AuthorStats.update(
          exId, ex.author, ex.authorProfileUrl, key, label, det?.score ?? null,
        ).then(() => window.LAI.ActionDispatcher.maybeHide(exId, ex.author, ex.authorProfileUrl))
         .catch(() => { /* non-critical */ });
      }
      window.LAI.injectBadge(postElement, label, det);
      return;
    }
    // Non-GPTZero entry (old stub cache): fall through to re-classification.
  }

  // ── New post or needsReextraction ─────────────────────────────────────────
  sessionMisses++;
  const isReextraction = !!existingEntry?.needsReextraction;
  if (isReextraction) {
    console.log(`${LOG_PREFIX} re-extracting stale entry: ${key}`);
  }

  // ── Detect ───────────────────────────────────────────────────────────────
  window.LAI.injectBadge(postElement, 'pending');
  console.log(`${LOG_PREFIX} classifying: ${key}`);

  let result;
  try {
    result = await chrome.runtime.sendMessage({ type: 'classify', text: extracted.text });
  } catch (err) {
    result = { error: 'network' };
    console.error(`${LOG_PREFIX} sendMessage failed: ${err.message}`);
  }
  console.log(`${LOG_PREFIX} background response:`, result);

  if (result.error) {
    const errorLabel = {
      'no-key':     'no-key',
      'auth':       'error-auth',
      'rate-limit': 'error-rate',
      'network':    'error',
    }[result.error] ?? 'error';
    window.LAI.updateBadge(postElement, errorLabel);
    console.warn(`${LOG_PREFIX} classify error: ${result.error} (${key})`);
    return; // Do not cache error states — allow retry on next scroll-past.
  }

  const detection = result;

  // ── Cache write ──────────────────────────────────────────────────────────
  // Preserve user-supplied labels when replacing a stale entry.
  console.log(`${LOG_PREFIX} cache write: ${key} engine=${detection.engine} label=${detection.label}`);
  await window.LAI.Cache.set(key, {
    extracted,
    detected: detection,
    cachedAt: Date.now(),
  });

  // ── Update badge ─────────────────────────────────────────────────────────
  const confNote = detection.confidenceCategory ? ` (${detection.confidenceCategory} confidence)` : '';
  console.log(`${LOG_PREFIX} badge: ${key} → ${detection.label}${confNote}`);
  window.LAI.updateBadge(postElement, detection.label, detection);

  // ── Author stats ──────────────────────────────────────────────────────────
  if (extracted.authorId) {
    window.LAI.AuthorStats.update(
      extracted.authorId,
      extracted.author,
      extracted.authorProfileUrl,
      key,
      detection.label,
      detection.score ?? null,
    ).then(() => window.LAI.ActionDispatcher.maybeHide(
      extracted.authorId, extracted.author, extracted.authorProfileUrl,
    )).catch(() => { /* non-critical */ });
  }

  // ── Dev log ──────────────────────────────────────────────────────────────
  if (window.LAI.DEV_MODE) {
    window.LAI.DevLog.logPost(extracted, detection);
  }

  // ── Session counter ──────────────────────────────────────────────────────
  sessionScanned += 1;
  if (Object.hasOwn(sessionCounts, detection.label)) {
    sessionCounts[detection.label] += 1;
  }
  try {
    await chrome.storage.local.set({ [_SESSION_SCANNED_KEY]: sessionScanned });
  } catch { /* non-critical */ }

  console.log(`${LOG_PREFIX} detected:`, {
    cacheKey:           key,
    author:             extracted.author,
    authorId:           extracted.authorId,
    wordCount:          extracted.wordCount,
    truncated:          extracted.truncated,
    label:              detection.label,
    score:              detection.score,
    confidenceCategory: detection.confidenceCategory,
    confidence:         detection.confidence != null ? detection.confidence.toFixed(2) : undefined,
    reasons:            detection.reasons,
    engine:             detection.engine,
    reextracted:        isReextraction,
  });

  if (sessionScanned % 10 === 0) {
    let sz = '?';
    try { sz = await window.LAI.Cache.size(); } catch { /* non-critical */ }
    console.log(`${LOG_PREFIX} Summary: ${sessionCounts.ai} ai, ${sessionCounts.human} human, ${sessionCounts.mixed} mixed, ${sessionCounts.uncertain} uncertain (${sessionScanned} total)  |  cache: ${sz}`);
    // Persist accumulated hit/miss counters to storage.
    try {
      const stored = (await chrome.storage.local.get(_CACHE_STATS_KEY))[_CACHE_STATS_KEY] ?? { hits: 0, misses: 0 };
      await chrome.storage.local.set({ [_CACHE_STATS_KEY]: {
        hits:   stored.hits   + sessionHits,
        misses: stored.misses + sessionMisses,
      }});
      sessionHits   = 0;
      sessionMisses = 0;
    } catch { /* non-critical */ }
  }
});
