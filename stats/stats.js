// Stats page script.
// Single unified table with VIEW filter (All / Visible / Auto-hidden / Blacklisted / Whitelisted).

const AUTHOR_STATS_PREFIX = 'litmus:authorStats:';
const BLACKLIST_KEY       = 'litmus:blacklist';
const WHITELIST_KEY       = 'litmus:whitelist';
const USAGE_KEY           = 'litmus:gptzeroUsage';
const CACHE_PREFIX        = 'post:';
const MIN_POSTS_KEY       = 'litmus:minPosts';
const AI_THRESHOLD_KEY    = 'litmus:aiThreshold';
const TABLE_MIN_POSTS_KEY = 'litmus:tableMinPostsFilter';

const DEFAULT_MIN_POSTS    = 5;
const DEFAULT_AI_THRESHOLD = 80;

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtNum(n) {
  if (n == null || isNaN(n)) return '—';
  return Number(n).toLocaleString();
}

function fmtPct(ratio) {
  if (ratio == null) return '—';
  return Math.round(ratio * 100) + '%';
}

function fmtRelTime(ts) {
  if (!ts) return '—';
  const diffMs = Date.now() - ts;
  const diffM  = Math.floor(diffMs / 60_000);
  const diffH  = Math.floor(diffMs / 3_600_000);
  const diffD  = Math.floor(diffMs / 86_400_000);
  if (diffM < 1)  return 'just now';
  if (diffM < 60) return `${diffM}m ago`;
  if (diffH < 24) return `${diffH}h ago`;
  if (diffD < 30) return `${diffD}d ago`;
  const d = new Date(ts);
  const month = d.toLocaleDateString('en-US', { month: 'short' });
  const day   = d.getDate();
  if (d.getFullYear() === new Date().getFullYear()) return `${month} ${day}`;
  return `${month} ${day}, ${d.getFullYear()}`;
}

function escHtml(s) {
  return (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function sanitizeName(name) {
  if (!name) return null;
  if (/^view .+['']\s*s?\s+profile$/i.test(name)) return null;
  if (/^[a-z0-9]+(-[a-z0-9]+)+$/.test(name))       return null;
  return name;
}

// ── State ─────────────────────────────────────────────────────────────────────

let allRows        = [];
let autoHiddenRows = [];

let blacklistSet  = new Set();
let whitelistSet  = new Set();
let autoHiddenSet = new Set();

let savedMinPosts = DEFAULT_MIN_POSTS;
let savedAiPct    = DEFAULT_AI_THRESHOLD;

let viewFilter = 'all';  // 'all' | 'visible' | 'auto-hidden' | 'blacklisted' | 'whitelisted'

// Sort
let sortCol = 'ai';
let sortAsc = false;

// ── Bar tooltip ───────────────────────────────────────────────────────────────

const barTooltipEl = document.getElementById('litmus-bar-tooltip');

const BAR_LABEL_COLORS = {
  ai: '#C44545', mixed: '#B8893E', uncertain: '#C7C7CC', human: '#5A8A5A',
};
const BAR_LABEL_NAMES = { ai: 'AI', mixed: 'mixed', uncertain: 'uncertain', human: 'human' };

function positionBarTooltip(e) {
  const tw = barTooltipEl.offsetWidth  || 140;
  const th = barTooltipEl.offsetHeight || 56;
  let left = e.clientX + 12;
  let top  = e.clientY - th - 8;
  if (left + tw > window.innerWidth - 8) left = e.clientX - tw - 12;
  if (top < 8) top = e.clientY + 16;
  barTooltipEl.style.left = left + 'px';
  barTooltipEl.style.top  = top  + 'px';
}

function showBarTooltip(e, r) {
  if (!r.total) return;
  const lines = ['ai', 'mixed', 'uncertain', 'human']
    .filter(k => (r[k] ?? 0) > 0)
    .map(k => {
      const count = r[k];
      const pct   = Math.round(count / r.total * 100);
      const color = BAR_LABEL_COLORS[k];
      return `<span style="display:inline-block;width:8px;height:8px;border-radius:1px;background:${color};margin-right:5px;vertical-align:middle;flex-shrink:0;"></span>${count} ${BAR_LABEL_NAMES[k]} · ${pct}%`;
    });
  barTooltipEl.innerHTML = lines.join('<br>');
  barTooltipEl.style.visibility = 'visible';
  positionBarTooltip(e);
}

// ── Auto-hidden predicate ─────────────────────────────────────────────────────

function isAutoHidden(r) {
  return !blacklistSet.has(r.authorId)
    && !whitelistSet.has(r.authorId)
    && r.total >= savedMinPosts
    && r.total > 0
    && (r.ai / r.total * 100) >= savedAiPct;
}

// ── VIEW filter ───────────────────────────────────────────────────────────────

function getViewRows() {
  if (viewFilter === 'visible')     return allRows.filter(r => !blacklistSet.has(r.authorId) && !autoHiddenSet.has(r.authorId));
  if (viewFilter === 'auto-hidden') return allRows.filter(r => autoHiddenSet.has(r.authorId));
  if (viewFilter === 'blacklisted') return allRows.filter(r => blacklistSet.has(r.authorId));
  if (viewFilter === 'whitelisted') return allRows.filter(r => whitelistSet.has(r.authorId));
  return allRows; // 'all'
}

document.getElementById('view-seg-ctrl').addEventListener('click', e => {
  const btn = e.target.closest('.view-seg-btn');
  if (!btn) return;
  viewFilter = btn.dataset.view;
  document.querySelectorAll('.view-seg-btn').forEach(b => b.classList.toggle('active', b === btn));
  renderAuthorsTable();
});

// ── Indicator column ──────────────────────────────────────────────────────────

function buildIndicatorCell(state) {
  const td = document.createElement('td');
  td.className = 'td-indicator';

  if (state === 'hide') {
    const bar = document.createElement('div');
    bar.className = 'row-bar row-bar-anthracite';
    td.appendChild(bar);
  } else if (state === 'whitelist') {
    const bar = document.createElement('div');
    bar.className = 'row-bar row-bar-solid-green';
    td.appendChild(bar);
  } else if (state === 'auto-hidden') {
    const bar = document.createElement('div');
    bar.className = 'row-bar row-bar-auto-hidden';
    td.appendChild(bar);
  }
  // 'none' → blank cell

  return td;
}

// ── Status toggle ─────────────────────────────────────────────────────────────

function currentStatus(authorId) {
  if (blacklistSet.has(authorId))  return 'hide';
  if (whitelistSet.has(authorId))  return 'whitelist';
  return 'auto';
}

function buildStatusToggle(row) {
  const status       = currentStatus(row.authorId); // 'auto' | 'hide' | 'whitelist'
  const isAutoHidden = status === 'auto' && autoHiddenSet.has(row.authorId);

  const wrapper = document.createElement('div');
  wrapper.className = 'litmus-status-cell';

  // Order: × (blacklist) | ○ (indicator) | ✓ (whitelist)
  const buttons = [
    {
      role: 'control',
      displayState: 'blacklisted',
      internalState: 'hide',
      title: status === 'hide' ? 'Un-blacklist' : 'Hide author',
      glyph: '×',
      active: status === 'hide',
    },
    {
      role: 'indicator',
      displayState: 'visible',
      title: isAutoHidden
        ? 'Auto-hidden by rule'
        : status === 'hide'
          ? 'Manually hidden'
          : status === 'whitelist'
            ? 'Manually exempted'
            : 'Default visible',
      glyph: '○',
      active: isAutoHidden,
      autoHidden: isAutoHidden,
    },
    {
      role: 'control',
      displayState: 'whitelisted',
      internalState: 'whitelist',
      title: status === 'whitelist' ? 'Un-whitelist' : 'Whitelist (never auto-hide)',
      glyph: '✓',
      active: status === 'whitelist',
    },
  ];

  for (const b of buttons) {
    const btn = document.createElement('button');
    btn.className      = 'litmus-status-btn';
    btn.dataset.role   = b.role;
    btn.dataset.state  = b.displayState;
    btn.dataset.active = String(b.active);
    if (b.autoHidden) btn.dataset.autoHidden = 'true';
    btn.title          = b.title;
    btn.textContent    = b.glyph;

    if (b.role === 'indicator') {
      btn.tabIndex = -1;
    } else {
      btn.addEventListener('click', () => {
        const newState = b.active ? 'auto' : b.internalState;
        setAuthorStatus(row.authorId, newState, row);
      });
    }
    wrapper.appendChild(btn);
  }
  return wrapper;
}

async function setAuthorStatus(authorId, newState, row) {
  try {
    const result    = await chrome.storage.local.get([BLACKLIST_KEY, WHITELIST_KEY]);
    let blacklist   = result[BLACKLIST_KEY] ?? [];
    let whitelist   = result[WHITELIST_KEY] ?? [];

    blacklist = blacklist.filter(e => e.authorId !== authorId);
    whitelist = whitelist.filter(e => e.authorId !== authorId);

    if (newState === 'hide') {
      blacklist.push({
        authorId,
        name:         row.name,
        profileUrl:   row.profileUrl,
        hiddenAt:     Date.now(),
        aiRateAtHide: row.total > 0 ? row.ai / row.total : null,
        postsAtHide:  { ai: row.ai, total: row.total },
      });
    } else if (newState === 'whitelist') {
      whitelist.push({
        authorId,
        name:          row.name,
        profileUrl:    row.profileUrl,
        whitelistedAt: Date.now(),
      });
    }

    try {
      await chrome.storage.local.set({ [BLACKLIST_KEY]: blacklist, [WHITELIST_KEY]: whitelist });
    } catch (writeErr) {
      if (/quota|QUOTA_BYTES/i.test(writeErr.message)) {
        console.warn('[Litmus] setAuthorStatus: quota error — blacklist write dropped');
        return; // silently drop; blacklist is small so this should not happen in practice
      }
      throw writeErr;
    }
    await loadAll();
  } catch (err) {
    console.error('[Litmus] setAuthorStatus failed:', err);
    alert(`Could not update status: ${err.message}`);
  }
}

// ── Author cell ───────────────────────────────────────────────────────────────

function buildAuthorCell(name, profileUrl) {
  const td = document.createElement('td');
  td.className = 'td-author-cell';
  const nameDiv = document.createElement('div');
  nameDiv.className = name ? 'td-author-name' : 'td-author-name unknown';
  nameDiv.textContent = name ?? '(unknown)';
  nameDiv.title = name ?? '(unknown)';
  td.appendChild(nameDiv);
  if (profileUrl) {
    const a = document.createElement('a');
    a.className = 'td-author-url';
    a.href = profileUrl; a.target = '_blank'; a.rel = 'noopener';
    const shortUrl = profileUrl.replace(/^https?:\/\/(www\.)?linkedin\.com/, 'linkedin.com');
    a.textContent = shortUrl;
    a.title = shortUrl;
    td.appendChild(a);
  }
  return td;
}

// ── Unified table ─────────────────────────────────────────────────────────────

function getFilteredRows() {
  const query       = document.getElementById('filter-name').value.trim().toLowerCase();
  const minPostsRaw = document.getElementById('filter-min-posts').value.trim();
  const minPosts    = minPostsRaw !== '' ? parseInt(minPostsRaw, 10) : null;

  return getViewRows().filter(r => {
    if (minPosts != null && !isNaN(minPosts) && r.total < minPosts) return false;
    if (query && !(r.name ?? r.authorId ?? '').toLowerCase().includes(query)) return false;
    return true;
  });
}

function renderAuthorsTable() {
  const rows     = getFilteredRows();
  const baseRows = getViewRows();

  rows.sort((a, b) => {
    let av = a[sortCol] ?? -Infinity;
    let bv = b[sortCol] ?? -Infinity;
    if (typeof av === 'string') { av = av.toLowerCase(); bv = (b[sortCol] ?? '').toLowerCase(); }
    if (av < bv) return sortAsc ? -1 :  1;
    if (av > bv) return sortAsc ?  1 : -1;
    return 0;
  });

  document.querySelectorAll('#authors-table thead th[data-col]').forEach(th => {
    th.classList.remove('sort-active', 'sort-asc');
    if (th.dataset.col === sortCol) th.classList.add(sortAsc ? 'sort-asc' : 'sort-active');
  });

  document.getElementById('filter-count').textContent =
    rows.length === baseRows.length
      ? `${baseRows.length} author${baseRows.length !== 1 ? 's' : ''}`
      : `${rows.length} of ${baseRows.length} shown`;

  const tbody = document.getElementById('author-tbody');
  if (!rows.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="6">No authors match the current filters.</td></tr>';
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const r of rows) {
    const status = currentStatus(r.authorId);
    const indState = status === 'hide'       ? 'hide'
                   : status === 'whitelist'  ? 'whitelist'
                   : autoHiddenSet.has(r.authorId) ? 'auto-hidden'
                   : 'none';
    const tr = document.createElement('tr');
    if (status === 'hide') tr.classList.add('row-hide');

    tr.appendChild(buildIndicatorCell(indState));
    tr.appendChild(buildAuthorCell(r.name, r.profileUrl));

    const tdPosts = document.createElement('td');
    tdPosts.className = 'td-num right'; tdPosts.textContent = r.total;
    tr.appendChild(tdPosts);

    const tdAi = document.createElement('td');
    tdAi.className = 'right';
    const aiRate  = r.total > 0 ? r.ai / r.total : null;
    const cellAi  = document.createElement('div');
    cellAi.className = 'litmus-cell-ai';
    const bar = document.createElement('div');
    bar.className = 'litmus-class-bar';
    if (r.total > 0) {
      const segments = [
        { key: 'ai',        cls: 'litmus-class-bar-ai' },
        { key: 'mixed',     cls: 'litmus-class-bar-mixed' },
        { key: 'uncertain', cls: 'litmus-class-bar-uncertain' },
        { key: 'human',     cls: 'litmus-class-bar-human' },
      ];
      for (const seg of segments) {
        const count = r[seg.key] ?? 0;
        if (count === 0) continue;
        const segEl = document.createElement('div');
        segEl.className = seg.cls;
        segEl.style.width = (count / r.total * 100) + '%';
        bar.appendChild(segEl);
      }
      bar.addEventListener('mouseenter', e => showBarTooltip(e, r));
      bar.addEventListener('mousemove',  e => positionBarTooltip(e));
      bar.addEventListener('mouseleave', () => { barTooltipEl.style.visibility = 'hidden'; });
    }
    const pct = document.createElement('div');
    pct.className = 'litmus-ai-pct';
    pct.textContent = aiRate != null ? Math.round(aiRate * 100) + '%' : '—';
    cellAi.appendChild(bar);
    cellAi.appendChild(pct);
    tdAi.appendChild(cellAi);
    tr.appendChild(tdAi);

    const tdLast = document.createElement('td');
    tdLast.className = 'td-secondary right'; tdLast.textContent = fmtRelTime(r.lastSeen);
    tr.appendChild(tdLast);

    const tdStatus = document.createElement('td');
    tdStatus.className = 'status';
    tdStatus.appendChild(buildStatusToggle(r));
    tr.appendChild(tdStatus);

    fragment.appendChild(tr);
  }

  tbody.innerHTML = '';
  tbody.appendChild(fragment);
}

// ── Threshold strip ───────────────────────────────────────────────────────────

let _thresholdDebounce = null;

function computeThresholdDiff(newMinP, newMinA) {
  const autoAuthors = allRows.filter(r =>
    !blacklistSet.has(r.authorId) && !whitelistSet.has(r.authorId)
  );

  function meetsThreshold(r, minP, aiP) {
    return r.total >= minP && r.total > 0 && (r.ai / r.total * 100) >= aiP;
  }

  const currentHidden = autoAuthors.filter(r => meetsThreshold(r, savedMinPosts, savedAiPct));
  const wouldHide     = autoAuthors.filter(r =>
    !meetsThreshold(r, savedMinPosts, savedAiPct) && meetsThreshold(r, newMinP, newMinA)
  ).length;
  const wouldUnhide   = currentHidden.filter(r => !meetsThreshold(r, newMinP, newMinA)).length;

  return { wouldHide, wouldUnhide, currentCount: currentHidden.length };
}

function updateThresholdPreview() {
  const minPostsEl = document.getElementById('threshold-min-posts');
  const minAiEl    = document.getElementById('threshold-min-ai');
  const applyBtn   = document.getElementById('threshold-apply');
  const resetBtn   = document.getElementById('threshold-reset');
  const deltaEl    = document.getElementById('preview-delta');
  const currentEl  = document.getElementById('preview-currently');

  const minP = parseInt(minPostsEl.value, 10);
  const minA = parseInt(minAiEl.value, 10);

  const validP = !isNaN(minP) && minP >= 1;
  const validA = !isNaN(minA) && minA >= 1 && minA <= 100;

  minPostsEl.classList.toggle('invalid', !validP);
  minAiEl.classList.toggle('invalid',    !validA);

  const inputsMatchSaved = validP && validA && minP === savedMinPosts && minA === savedAiPct;
  resetBtn.disabled = inputsMatchSaved;

  if (validP && validA) {
    const { wouldHide, wouldUnhide, currentCount } = computeThresholdDiff(minP, minA);

    // Delta preview (CASE A / B / C)
    if (inputsMatchSaved) {
      // CASE A: inputs match saved — show nothing
      deltaEl.innerHTML = '';
    } else if (wouldHide === 0 && wouldUnhide === 0) {
      // CASE B: values differ but outcome unchanged
      deltaEl.innerHTML = '<span style="color:#6E6E73;">No change</span>';
    } else {
      // CASE C: actual changes — show only non-zero parts
      const parts = [];
      if (wouldHide > 0) {
        parts.push(`<span style="color:#C44545;">+${wouldHide}</span><span style="color:#6E6E73;"> would hide</span>`);
      }
      if (wouldUnhide > 0) {
        parts.push(`<span style="color:#5A8A5A;">−${wouldUnhide}</span><span style="color:#6E6E73;"> would un-hide</span>`);
      }
      deltaEl.innerHTML = parts.join('<span style="color:#A1A1A6;"> · </span>');
    }

    // "currently N hidden" — only when N > 0
    if (currentCount === 0) {
      currentEl.innerHTML = '';
    } else {
      const sep = deltaEl.innerHTML ? '<span style="color:#A1A1A6;"> · </span>' : '';
      currentEl.innerHTML = `${sep}<span style="color:#6E6E73;">currently </span><span style="color:#1D1D1F;font-weight:500;">${currentCount}</span><span style="color:#6E6E73;"> hidden</span>`;
    }

    applyBtn.disabled = inputsMatchSaved;
  } else {
    deltaEl.innerHTML   = '';
    currentEl.innerHTML = '';
    applyBtn.disabled   = true;
  }
}

function setupThresholdListeners() {
  const minPostsEl = document.getElementById('threshold-min-posts');
  const minAiEl    = document.getElementById('threshold-min-ai');

  const digitFilter = e => { e.target.value = e.target.value.replace(/\D/g, ''); };
  minPostsEl.addEventListener('input', e => { digitFilter(e); clearTimeout(_thresholdDebounce); _thresholdDebounce = setTimeout(updateThresholdPreview, 100); });
  minAiEl.addEventListener('input',    e => { digitFilter(e); clearTimeout(_thresholdDebounce); _thresholdDebounce = setTimeout(updateThresholdPreview, 100); });

  minPostsEl.addEventListener('blur', () => {
    const v = parseInt(minPostsEl.value, 10);
    if (isNaN(v) || v < 1) minPostsEl.value = 1;
    updateThresholdPreview();
  });
  minAiEl.addEventListener('blur', () => {
    const v = parseInt(minAiEl.value, 10);
    if (isNaN(v) || v < 1)  minAiEl.value = 1;
    else if (v > 100)        minAiEl.value = 100;
    updateThresholdPreview();
  });

  document.getElementById('threshold-reset').addEventListener('click', () => {
    minPostsEl.value = savedMinPosts;
    minAiEl.value    = savedAiPct;
    minPostsEl.classList.remove('invalid');
    minAiEl.classList.remove('invalid');
    updateThresholdPreview();
  });

  document.getElementById('threshold-apply').addEventListener('click', async () => {
    const minP = parseInt(minPostsEl.value, 10);
    const minA = parseInt(minAiEl.value, 10);
    if (isNaN(minP) || isNaN(minA)) return;
    await chrome.storage.local.set({ [MIN_POSTS_KEY]: minP, [AI_THRESHOLD_KEY]: minA });
    savedMinPosts = minP;
    savedAiPct    = minA;
    await loadAll();
  });
}

function syncThresholdStrip() {
  document.getElementById('threshold-min-posts').value = savedMinPosts;
  document.getElementById('threshold-min-ai').value    = savedAiPct;
  updateThresholdPreview();
}

// ── Sort handlers ─────────────────────────────────────────────────────────────

document.querySelectorAll('#authors-table thead th[data-col]').forEach(th => {
  th.addEventListener('click', () => {
    const col = th.dataset.col;
    if (sortCol === col) sortAsc = !sortAsc;
    else { sortCol = col; sortAsc = col === 'name'; }
    renderAuthorsTable();
  });
});

// ── Filter inputs ─────────────────────────────────────────────────────────────

document.getElementById('filter-name').addEventListener('input', renderAuthorsTable);

document.getElementById('filter-min-posts').addEventListener('input', e => {
  e.target.value = e.target.value.replace(/\D/g, '');
  renderAuthorsTable();
  chrome.storage.local.set({ [TABLE_MIN_POSTS_KEY]: e.target.value });
});

// ── Load data ─────────────────────────────────────────────────────────────────

async function loadAll() {
  const result = await chrome.storage.local.get(null);

  savedMinPosts = result[MIN_POSTS_KEY]    ?? DEFAULT_MIN_POSTS;
  savedAiPct    = result[AI_THRESHOLD_KEY] ?? DEFAULT_AI_THRESHOLD;

  // Author stats are stored as per-key entries; collect them by prefix.
  const authorStats = {};
  for (const [k, v] of Object.entries(result)) {
    if (k.startsWith(AUTHOR_STATS_PREFIX) && v?.authorId) {
      authorStats[v.authorId] = v;
    }
  }
  const blacklist   = result[BLACKLIST_KEY]     ?? [];
  const whitelist   = result[WHITELIST_KEY]     ?? [];
  const usageMonth  = result[USAGE_KEY];
  const wordsMonth  = (usageMonth?.month === currentMonth()) ? (usageMonth?.wordsSent ?? 0) : 0;
  const cacheEntries = Object.keys(result).filter(k => k.startsWith(CACHE_PREFIX));

  // Sets for O(1) lookups
  blacklistSet = new Set(blacklist.map(e => e.authorId));
  whitelistSet = new Set(whitelist.map(e => e.authorId));

  // Build author rows
  allRows = Object.values(authorStats).map(record => {
    const posts = record.posts ?? [];
    const total = posts.length;
    const ai    = posts.filter(p => p.label === 'ai').length;
    const mixed = posts.filter(p => p.label === 'mixed').length;
    const human = posts.filter(p => p.label === 'human').length;
    const uncertain = total - ai - mixed - human; // covers 'uncertain' + any unknown labels
    return {
      authorId:   record.authorId,
      name:       sanitizeName(record.name) ?? null,
      profileUrl: record.profileUrl ?? null,
      total, ai, mixed, uncertain, human,
      lastSeen:   record.lastSeen ?? 0,
    };
  });

  // Auto-hidden: auto-state + meets threshold
  autoHiddenRows = allRows.filter(isAutoHidden);
  autoHiddenSet  = new Set(autoHiddenRows.map(r => r.authorId));

  // VIEW button counts
  const visibleCount = allRows.filter(r => !blacklistSet.has(r.authorId) && !autoHiddenSet.has(r.authorId)).length;
  document.getElementById('vc-all').textContent         = allRows.length > 0         ? ` ${allRows.length}`          : '';
  document.getElementById('vc-visible').textContent     = visibleCount > 0           ? ` ${visibleCount}`             : '';
  document.getElementById('vc-auto-hidden').textContent = autoHiddenRows.length > 0  ? ` ${autoHiddenRows.length}`   : '';
  document.getElementById('vc-blacklisted').textContent = blacklist.length > 0       ? ` ${blacklist.length}`        : '';
  document.getElementById('vc-whitelisted').textContent = whitelist.length > 0       ? ` ${whitelist.length}`        : '';

  // Stats line
  document.getElementById('sum-posts').textContent   = fmtNum(cacheEntries.length);
  document.getElementById('sum-authors').textContent = fmtNum(Object.keys(authorStats).length);
  document.getElementById('sum-blacklisted').textContent = fmtNum(blacklist.length);
  document.getElementById('sum-words-month').textContent = fmtNum(wordsMonth);

  // Auto-hidden: red only when count > 0 (avoid drawing eye to a colored zero).
  const autoHiddenEl = document.getElementById('sum-auto-hidden');
  autoHiddenEl.textContent = fmtNum(autoHiddenRows.length);
  autoHiddenEl.className   = 'litmus-stat-num' + (autoHiddenRows.length > 0 ? ' litmus-stat-red' : '');

  // Whitelisted: green only when count > 0.
  const whitelistedEl = document.getElementById('sum-whitelisted');
  whitelistedEl.textContent = fmtNum(whitelist.length);
  whitelistedEl.className   = 'litmus-stat-num' + (whitelist.length > 0 ? ' litmus-stat-green' : '');

  // Restore persisted min-posts filter value
  const savedFilter = result[TABLE_MIN_POSTS_KEY];
  if (savedFilter != null) {
    const el = document.getElementById('filter-min-posts');
    if (el && el.value === '') el.value = savedFilter;
  }

  renderAuthorsTable();
  syncThresholdStrip();
}

// ── Reset stats modal ─────────────────────────────────────────────────────────

const overlay      = document.getElementById('modal-overlay');
const modalMsg     = document.getElementById('modal-msg');
let   pendingReset = null;

document.getElementById('btn-reset-stats').addEventListener('click', () => {
  modalMsg.textContent = 'This will permanently delete all author statistics and cached classifications. This cannot be undone.';
  pendingReset = async () => {
    const res         = await chrome.storage.local.get(null);
    const keysToRemove = Object.keys(res).filter(
      k => k.startsWith(CACHE_PREFIX) || k.startsWith(AUTHOR_STATS_PREFIX)
    );
    await chrome.storage.local.remove(keysToRemove);
    location.reload();
  };
  overlay.classList.add('visible');
});

document.getElementById('modal-cancel').addEventListener('click', () => {
  overlay.classList.remove('visible'); pendingReset = null;
});

document.getElementById('modal-confirm').addEventListener('click', async () => {
  overlay.classList.remove('visible');
  if (pendingReset) { await pendingReset(); pendingReset = null; }
});

overlay.addEventListener('click', e => {
  if (e.target === overlay) { overlay.classList.remove('visible'); pendingReset = null; }
});

// ── Open popup ────────────────────────────────────────────────────────────────

document.getElementById('btn-open-popup').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('popup/popup.html') });
});

// ── Init ──────────────────────────────────────────────────────────────────────

setupThresholdListeners();
loadAll();
