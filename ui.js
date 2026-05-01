(function (LAI) {

  // ── Stylesheet ──────────────────────────────────────────────────────────────
  const CSS = `
/* ── Hidden-post placeholder ── */
.lai-post-placeholder {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
  font-size: 12px;
  color: #6E6E73;
  background: #FAFAFA;
  border-top: 0.5px solid #E5E5EA;
  box-sizing: border-box;
}
.lai-placeholder-label {
  flex: 1; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.lai-placeholder-actions {
  display: flex; align-items: center; gap: 10px;
  flex-shrink: 0; margin-left: 8px;
}
.lai-placeholder-btn {
  font-family: inherit; font-size: 12px;
  background: none; border: none; outline: none;
  cursor: pointer; color: #0071E3; padding: 0;
}
.lai-placeholder-btn:hover { text-decoration: underline; }

/* ── Pill ── */
.lai-pill {
  display: inline-flex;
  align-items: center;
  padding: 1px 5px;
  border-radius: 3px;
  font: 500 11px/1.4 -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
  letter-spacing: 0.2px;
  white-space: nowrap;
  flex-shrink: 0;
  cursor: default;
  user-select: none;
}
.lai-pill[data-status="ai"]         { background: #FCEBEB; color: #791F1F; }
.lai-pill[data-status="mixed"]      { background: #FAEEDA; color: #633806; }
.lai-pill[data-status="human"]      { background: #F0F4F1; color: #3C5A4A; }
.lai-pill[data-status="pending"],
.lai-pill[data-status="error"],
.lai-pill[data-status="error-auth"],
.lai-pill[data-status="error-rate"],
.lai-pill[data-status="no-key"],
.lai-pill[data-status="uncertain"]  { background: #F5F5F7; color: #6E6E73; }
@keyframes lai-pulse {
  0%, 100% { opacity: 0.6; }
  50%       { opacity: 1.0; }
}
.lai-pill[data-status="pending"] { animation: lai-pulse 1.4s ease-in-out infinite; }

.lai-tooltip {
  position: fixed;
  z-index: 2147483647;
  background: #FFFFFF;
  border: 0.5px solid #E5E5EA;
  border-radius: 6px;
  padding: 8px 10px;
  pointer-events: none;
  box-shadow: 0 2px 8px rgba(0,0,0,0.08);
}
.lai-tooltip-l1 {
  font: 500 11px/1.4 -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
  color: #1D1D1F;
  white-space: nowrap;
}
.lai-tooltip-l2 {
  font: 400 11px/1.4 -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
  color: #6E6E73;
  margin-top: 2px;
  white-space: nowrap;
}
`;

  const BADGE_CONFIG = {
    ai:           { label: 'AI-generated'                         },
    human:        { label: 'Human-written'                        },
    mixed:        { label: 'Mixed AI/human'                       },
    uncertain:    { label: 'Uncertain'                            },
    pending:      { label: 'Analyzing…'                           },
    'no-key':     { label: 'No API key — open popup to configure' },
    'error-auth': { label: 'API key rejected — check popup'       },
    'error-rate': { label: 'Rate limited — try again later'       },
    error:        { label: 'Detection failed'                     },
  };

  // ── Pill text ────────────────────────────────────────────────────────────────

  function pillText(status, meta) {
    const score = meta?.score != null ? Math.round(meta.score * 100) : null;
    if (status === 'ai')      return score != null ? `AI ${score}%`    : 'AI';
    if (status === 'mixed')   return score != null ? `Mixed ${score}%` : 'Mixed';
    if (status === 'human')   return score != null ? `Human ${score}%` : 'Human';
    if (status === 'pending') return '…';
    return '?'; // error, error-auth, error-rate, no-key, uncertain
  }

  // ── Tooltip ─────────────────────────────────────────────────────────────────

  let activeTooltip = null;

  function showTooltip(pill) {
    hideTooltip();

    const status = pill._laiStatus;
    const meta   = pill._laiMeta;
    const config = BADGE_CONFIG[status];
    if (!config) return;

    const tt   = document.createElement('div');
    tt.className = 'lai-tooltip';

    const l1 = document.createElement('div');
    l1.className = 'lai-tooltip-l1';
    let text = config.label;
    if (meta?.score != null) text += ` · ${Math.round(meta.score * 100)}%`;
    l1.textContent = text;
    tt.appendChild(l1);

    if (meta?.confidenceCategory) {
      const l2 = document.createElement('div');
      l2.className = 'lai-tooltip-l2';
      l2.textContent = `Confidence: ${meta.confidenceCategory}`;
      tt.appendChild(l2);
    }

    // Measure before final placement.
    tt.style.visibility = 'hidden';
    tt.style.top  = '0';
    tt.style.left = '0';
    document.body.appendChild(tt);
    activeTooltip = tt;

    const br  = pill.getBoundingClientRect();
    const tr  = tt.getBoundingClientRect();
    const GAP = 6, EDGE = 8;

    // Default: below the pill, right-aligned with its right edge.
    let top  = br.bottom + GAP;
    let left = br.right  - tr.width;

    // Flip up if clips viewport bottom.
    if (top + tr.height > window.innerHeight - EDGE) top = br.top - tr.height - GAP;
    // Slide right if clips left edge.
    if (left < EDGE) left = br.left;
    // Slide left if clips right edge.
    if (left + tr.width > window.innerWidth - EDGE) left = window.innerWidth - tr.width - EDGE;

    tt.style.top        = top  + 'px';
    tt.style.left       = left + 'px';
    tt.style.visibility = '';
  }

  function hideTooltip() {
    if (activeTooltip) { activeTooltip.remove(); activeTooltip = null; }
  }

  // ── Author name container ────────────────────────────────────────────────────
  // Mirrors the author-finding logic in extractor.js so the pill lands next to
  // the correct name (original author for reshares, not the resharer).

  function findAuthorContainer(postElement) {
    // Scope link search to elements that appear before the post body — mirrors
    // the same guard in extractor.js to prevent inline-comment name links from
    // shifting nameLinkIdx and causing the pill to land on the commenter.
    const bodyEl = postElement.querySelector(LAI.SELECTORS.POST_BODY);
    const allInLinks = Array.from(postElement.querySelectorAll('a[href*="/in/"]'))
      .filter(a => /\/in\/[^/?#\s]+/.test(a.href))
      .filter(a => !bodyEl || !!(a.compareDocumentPosition(bodyEl) & Node.DOCUMENT_POSITION_FOLLOWING));
    const nameLinks = allInLinks.filter(a => !a.querySelector('figure') && a.querySelector('p'));

    const isSecondaryCuration = Array.from(postElement.querySelectorAll('p'))
      .some(p => /(reposted|likes|supports|celebrates|commented on) this/i.test(p.textContent));

    const nameLinkIdx = (isSecondaryCuration && nameLinks.length >= 2) ? 1 : 0;
    const nameLink = nameLinks[nameLinkIdx] ?? null;

    const companyLink = !nameLink
      ? Array.from(postElement.querySelectorAll('a[href*="/company/"]'))
          .filter(a => /\/company\/[^/?#\s]+/.test(a.href))
          .filter(a => !a.querySelector('figure'))[0] ?? null
      : null;

    const anchor = nameLink ?? companyLink;
    const authorNameP = anchor?.querySelector('p');
    if (!authorNameP) return null;

    return authorNameP.parentElement;
  }

  // ── Styles injection ─────────────────────────────────────────────────────────

  let styleInjected = false;

  function ensureStyles() {
    if (styleInjected) return;
    const style = document.createElement('style');
    style.dataset.laiStyles = 'true';
    style.textContent = CSS;
    (document.head ?? document.documentElement).appendChild(style);
    styleInjected = true;
  }

  // ── Hide / Unhide ────────────────────────────────────────────────────────────

  // Hides a post by collapsing its body and injecting a placeholder row.
  // The Unhide button calls Blacklist.remove() which triggers a storage
  // onChanged in content.js → unhidePost() is called from there.
  LAI.hidePost = function (postElement, authorId, name) {
    if (postElement.dataset.laiHidden) return; // already hidden
    ensureStyles();

    postElement.dataset.laiHidden = authorId;

    // Hide all direct children — covers plain text, reshares with/without
    // commentary, image-only, video, document, and poll post types.
    // Hiding at child level (not the post element itself) keeps the outer
    // wrapper in layout so LinkedIn's virtual-scroll position tracking stays intact.
    // The placeholder is appended after this loop, so it is unaffected.
    for (const child of postElement.children) {
      child.style.display = 'none';
    }

    // Inject placeholder.
    const ph = document.createElement('div');
    ph.className = 'lai-post-placeholder';
    ph.dataset.laiPlaceholder = authorId;

    const label = document.createElement('span');
    label.className = 'lai-placeholder-label';
    label.textContent = `Post hidden — ${name || authorId}`;

    const actions = document.createElement('span');
    actions.className = 'lai-placeholder-actions';

    const unhideBtn = document.createElement('button');
    unhideBtn.className = 'lai-placeholder-btn';
    unhideBtn.textContent = 'Unhide';
    unhideBtn.addEventListener('click', () => {
      LAI.Blacklist.remove(authorId).catch(() => {});
      // content.js's chrome.storage.onChanged listener will call unhidePost()
      // for all visible posts from this author once storage is updated.
    });

    actions.appendChild(unhideBtn);
    ph.appendChild(label);
    ph.appendChild(actions);
    postElement.appendChild(ph);
  };

  // Restores a hidden post. Called by content.js when blacklist storage changes.
  LAI.unhidePost = function (postElement, authorId) {
    if (postElement.dataset.laiHidden !== authorId) return;
    delete postElement.dataset.laiHidden;

    // Remove placeholder first so it isn't caught by the restore loop.
    postElement.querySelectorAll('.lai-post-placeholder').forEach(el => {
      if (el.dataset.laiPlaceholder === authorId) el.remove();
    });

    // Restore all direct children (placeholder already removed above).
    for (const child of postElement.children) {
      child.style.display = '';
    }
  };

  // Hides all currently-rendered posts from a given author.
  // Called by action-dispatcher.js when a threshold is crossed mid-session.
  LAI.hideVisiblePostsFromAuthor = function (authorId, name) {
    const elements = LAI._authorPostMap?.get(authorId);
    if (!elements) return;
    for (const el of elements) {
      if (document.contains(el)) LAI.hidePost(el, authorId, name);
    }
  };

  // ── Public API ──────────────────────────────────────────────────────────────

  LAI.injectBadge = function (postElement, status, meta) {
    if (status === 'skipped') return;
    if (!BADGE_CONFIG[status]) return;
    if (postElement.querySelector('[data-lai-pill]')) return;

    ensureStyles();

    const container = findAuthorContainer(postElement);
    if (!container) return; // gracefully degrade if author name not found

    // Make the container flex so pill sits inline next to the name.
    const computed = getComputedStyle(container);
    if (computed.display !== 'flex') {
      container.style.display    = 'flex';
      container.style.alignItems = 'center';
      container.style.gap        = '6px';
    }

    const pill = document.createElement('span');
    pill.className       = 'lai-pill';
    pill.dataset.laiPill = 'true';
    pill.dataset.status  = status;
    pill._laiStatus      = status;
    pill._laiMeta        = meta ?? null;
    pill.textContent     = pillText(status, meta);

    if (status === 'no-key') pill.title = 'No API key configured';

    pill.addEventListener('mouseenter', () => showTooltip(pill));
    pill.addEventListener('mouseleave', hideTooltip);

    container.appendChild(pill);
  };

  LAI.updateBadge = function (postElement, status, meta) {
    const pill = postElement.querySelector('[data-lai-pill]');

    if (status === 'skipped') return;
    if (!BADGE_CONFIG[status]) return;

    if (!pill) {
      LAI.injectBadge(postElement, status, meta);
      return;
    }

    // Swap existing pill in place.
    pill.dataset.status = status;
    pill._laiStatus     = status;
    pill._laiMeta       = meta ?? null;
    pill.textContent    = pillText(status, meta);
    pill.title          = status === 'no-key' ? 'No API key configured' : '';
  };

}(window.LAI = window.LAI || {}));
