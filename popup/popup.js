// Popup script.

const CACHE_PREFIX      = 'post:';
const VERSION           = '0.2.6';
const APIKEY_KEY        = 'litmus:gptzeroApiKey';
const USAGE_STATS_KEY   = 'litmus:usageStats';
const CACHE_STATS_KEY   = 'litmus:stats:cache';
const AUTHOR_STATS_PREFIX = 'litmus:authorStats:';
const DEVLOG_PREFIX       = 'litmus:devlog:';
const DEV_MODE_KEY      = 'litmus:devMode';
const MIN_POSTS_KEY      = 'litmus:minPosts';
const AI_THRESHOLD_KEY   = 'litmus:aiThreshold';
const SKIP_PROMOTED_KEY    = 'litmus:skipPromotedPosts';
const SKIP_SUGGESTED_KEY   = 'litmus:skipSuggestedPosts';
const SKIP_COMPANIES_KEY   = 'litmus:skipCompanyPosts';
const SKIP_RECOMMENDED_KEY = 'litmus:skipRecommendedFor';

const DEFAULT_MIN_POSTS      = 5;
const DEFAULT_AI_THRESHOLD   = 80;   // stored as integer percent (e.g. 80 = 80%)
// Must stay in sync with MAX_POSTS_PER_AUTHOR in author-stats.js.
const MAX_MIN_POSTS          = 20;

// ── Shared helpers ────────────────────────────────────────────────────────────

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function tsString() {
  const d = new Date(), pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}` +
         `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function escHtml(s) {
  return (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Custom modal — replaces window.confirm().
function showModal(message, confirmLabel = 'Confirm') {
  return new Promise(resolve => {
    document.getElementById('modal-message').textContent = message;
    document.getElementById('modal-confirm').textContent = confirmLabel;
    const overlay = document.getElementById('modal-overlay');
    overlay.classList.add('visible');
    const done = result => { overlay.classList.remove('visible'); resolve(result); };
    document.getElementById('modal-confirm').onclick = () => done(true);
    document.getElementById('modal-cancel').onclick  = () => done(false);
  });
}

function setKeyStatus(msg, cls = '') {
  const el = document.getElementById('apikey-status');
  el.textContent    = msg;
  el.className      = 'key-status' + (cls ? ' ' + cls : '');
  el.style.display  = msg ? '' : 'none';
}

// Filter out stale bad names (aria-label leaks, URL slugs).
function sanitizeName(name) {
  if (!name) return null;
  if (/^view .+['']\s*s?\s+profile$/i.test(name)) return null;
  if (/^[a-z0-9]+(-[a-z0-9]+)+$/.test(name))       return null;
  return name;
}

// ── Stats strip ───────────────────────────────────────────────────────────────

async function loadStats() {
  const all = await chrome.storage.local.get(null);
  let total = 0, ai = 0, mixed = 0, human = 0;
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith(CACHE_PREFIX)) continue;
    total++;
    const label = value?.detected?.label;
    if (label === 'ai')         ai++;
    else if (label === 'mixed') mixed++;
    else if (label === 'human') human++;
  }
  document.getElementById('stat-total').textContent       = total;
  document.getElementById('stat-ai-pct').textContent      = total > 0 ? Math.round(ai / total * 100) + '% AI' : '';
  document.getElementById('stat-ai-count').textContent    = ai;
  document.getElementById('stat-mixed-count').textContent = mixed;
  document.getElementById('stat-human-count').textContent = human;
  document.getElementById('stat-seg-ai').style.flex    = String(ai    || 0);
  document.getElementById('stat-seg-mixed').style.flex = String(mixed || 0);
  document.getElementById('stat-seg-human').style.flex = String(human || 0);
}

// ── API Status section (merged key + usage) ───────────────────────────────────

function showKeyNoState() {
  document.getElementById('apikey-nokey').style.display  = '';
  document.getElementById('apikey-saved').style.display  = 'none';
  document.getElementById('apikey-input').value = '';
}

function showKeySavedState(key) {
  document.getElementById('apikey-nokey').style.display  = 'none';
  document.getElementById('apikey-saved').style.display  = '';
  document.getElementById('apikey-masked').textContent   = '••••••••' + key.slice(-4);
}

function _formatCycleDate(unixSeconds) {
  return new Date(unixSeconds * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function _hitRateText(cs) {
  const total = (cs?.hits ?? 0) + (cs?.misses ?? 0);
  return total > 0 ? `${Math.round(cs.hits / total * 100)}% cache hit` : null;
}

function renderUsageStats(stats, hitRate) {
  const usageRight  = document.getElementById('api-usage-right');
  const usageBar    = document.getElementById('usage-bar');
  const barWrap     = document.getElementById('usage-bar-wrap');
  const helper      = document.getElementById('usage-helper');
  const hitText     = hitRate ?? null;

  if (!stats || stats.error) {
    if (barWrap) barWrap.style.display = 'none';
    if (stats?.error === 'no-key') {
      usageRight.textContent = 'API key required';
      usageRight.style.color = '#C44545';
      if (helper) helper.textContent = 'Set a key below to start classifying.';
    } else {
      usageRight.textContent = 'Usage unavailable';
      usageRight.style.color = '#A1A1A6';
      if (helper) helper.textContent =
        'Could not reach GPTZero.' + (hitText ? ' · ' + hitText : '');
    }
    return;
  }

  const { wordsLeft, wordsUsed, cycleEnd, plan } = stats;
  usageRight.style.color = '#1D1D1F';

  if (wordsLeft === null || wordsLeft === undefined) {
    // Enterprise / metered — no fixed cap
    if (barWrap) barWrap.style.display = 'none';
    usageRight.textContent = `${(wordsUsed ?? 0).toLocaleString()} used`;
    const planPart = plan ? `${plan} plan · metered billing` : 'Metered billing';
    if (helper) helper.textContent = [planPart, hitText].filter(Boolean).join(' · ');
  } else {
    // Standard plan with a quota
    if (barWrap) barWrap.style.display = '';
    const total  = (wordsUsed ?? 0) + wordsLeft;
    usageRight.textContent = `${(wordsUsed ?? 0).toLocaleString()} / ${total.toLocaleString()}`;
    if (usageBar) usageBar.style.width = (total > 0 ? Math.min(100, Math.round((wordsUsed ?? 0) / total * 100)) : 0) + '%';

    const now = Date.now() / 1000;
    let cyclePart;
    if (cycleEnd && cycleEnd < now) {
      cyclePart = 'Cycle ended — renew at gptzero.me';
    } else if (cycleEnd) {
      cyclePart = `resets ${_formatCycleDate(cycleEnd)}`;
    }
    const planPart = plan ? `${plan} plan` : null;
    if (helper) helper.textContent = [planPart, cyclePart, hitText].filter(Boolean).join(' · ');
  }
}

async function loadApiStatusSection() {
  const result  = await chrome.storage.local.get([APIKEY_KEY, USAGE_STATS_KEY, CACHE_STATS_KEY]);
  const key     = result[APIKEY_KEY];
  const cached  = result[USAGE_STATS_KEY];
  const hitRate = _hitRateText(result[CACHE_STATS_KEY]);

  if (!key) {
    showKeyNoState();
    renderUsageStats({ error: 'no-key' }, null);
    return;
  }

  showKeySavedState(key);

  // Render cached data immediately to avoid blank state.
  if (cached) {
    renderUsageStats(cached, hitRate);
  } else {
    document.getElementById('api-usage-right').textContent = '…';
    document.getElementById('api-usage-right').style.color = '#A1A1A6';
    const helper = document.getElementById('usage-helper');
    if (helper) helper.textContent = '';
  }

  // Fetch fresh data; re-render on success, keep cached display on error.
  chrome.runtime.sendMessage({ type: 'fetchUsageStats' }, resp => {
    if (chrome.runtime.lastError) return;
    if (resp && !resp.error) {
      renderUsageStats(resp, hitRate);
    } else if (!cached) {
      renderUsageStats(resp ?? { error: 'network' }, hitRate);
    }
  });
}

async function validateAndSaveKey(key) {
  setKeyStatus('Validating…');
  let outcome;
  try {
    const resp = await fetch('https://api.gptzero.me/v2/predict/text', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key },
      body:    JSON.stringify({ document: 'test', multilingual: false }),
    });
    outcome = resp.ok ? 'valid' : 'invalid';
  } catch {
    outcome = 'network_error';
  }

  if (outcome === 'invalid') { setKeyStatus('✕ Invalid key', 'err'); return; }

  await chrome.storage.local.set({ [APIKEY_KEY]: key });
  await loadApiStatusSection();

  if (outcome === 'valid') {
    setKeyStatus('✓ Key valid', 'ok');
  } else {
    setKeyStatus("⚠ Couldn't validate — saved");
  }
}

document.getElementById('btn-apikey-save').addEventListener('click', async () => {
  const key = document.getElementById('apikey-input').value.trim();
  if (!key) { setKeyStatus('Enter a key first.', 'err'); return; }
  const btn = document.getElementById('btn-apikey-save');
  btn.disabled = true;
  await validateAndSaveKey(key);
  btn.disabled = false;
});

document.getElementById('btn-apikey-replace').addEventListener('click', () => {
  showKeyNoState(); setKeyStatus('');
  document.getElementById('apikey-input').focus();
});

document.getElementById('btn-apikey-clear').addEventListener('click', async () => {
  const ok = await showModal('Remove the saved GPTZero API key?', 'Remove');
  if (!ok) return;
  await chrome.storage.local.remove(APIKEY_KEY);
  showKeyNoState(); setKeyStatus('');
});

// ── Number input digit filter ─────────────────────────────────────────────────
// Strips non-digit characters while typing; clamp happens on blur.
function digitFilter(e) {
  const prev = e.target.value;
  const next = prev.replace(/\D/g, '');
  if (next !== prev) e.target.value = next;
}

// ── Settings — detection thresholds ──────────────────────────────────────────

async function loadThresholds() {
  const result = await chrome.storage.local.get([MIN_POSTS_KEY, AI_THRESHOLD_KEY]);
  document.getElementById('input-min-posts').value     = result[MIN_POSTS_KEY]     ?? DEFAULT_MIN_POSTS;
  document.getElementById('input-ai-threshold').value  = result[AI_THRESHOLD_KEY]  ?? DEFAULT_AI_THRESHOLD;
}

document.getElementById('input-min-posts').addEventListener('blur', async e => {
  let val = parseInt(e.target.value, 10);
  if (isNaN(val) || val < 1)        { val = 1;            e.target.value = val; }
  else if (val > MAX_MIN_POSTS)      { val = MAX_MIN_POSTS; e.target.value = val; }
  e.target.classList.remove('err');
  await chrome.storage.local.set({ [MIN_POSTS_KEY]: val });
});

document.getElementById('input-ai-threshold').addEventListener('blur', async e => {
  let val = parseInt(e.target.value, 10);
  if (isNaN(val) || val < 1)  { val = 1;   e.target.value = val; }
  else if (val > 100)          { val = 100; e.target.value = val; }
  e.target.classList.remove('err');
  await chrome.storage.local.set({ [AI_THRESHOLD_KEY]: val });
});

// ── Developer mode + Dev Tools ────────────────────────────────────────────────

function setDevToolsVisible(on) {
  document.getElementById('dev-tools-section').style.display = on ? '' : 'none';
}

async function loadDevMode() {
  const result = await chrome.storage.local.get(DEV_MODE_KEY);
  const on     = result[DEV_MODE_KEY] ?? false;
  document.getElementById('toggle-dev-mode').checked = on;
  setDevToolsVisible(on);
  if (on) loadDevTools();
}

async function loadDevTools() {
  const result      = await chrome.storage.local.get(null);
  const devlogCount = Object.entries(result)
    .filter(([k, v]) => k.startsWith(DEVLOG_PREFIX) && typeof v?.ts === 'number').length;
  const cacheSize   = Object.keys(result).filter(k => k.startsWith(CACHE_PREFIX)).length;
  const cs          = result[CACHE_STATS_KEY] ?? { hits: 0, misses: 0 };
  const total       = cs.hits + cs.misses;
  const hitRate     = total > 0 ? Math.round(cs.hits / total * 100) : null;
  document.getElementById('devlog-count').textContent      = devlogCount;
  document.getElementById('cache-stats-line').textContent  = hitRate != null
    ? `Cache: ${cacheSize.toLocaleString()} entries · ${hitRate}% hit rate`
    : `Cache: ${cacheSize.toLocaleString()} entries`;
}

document.getElementById('toggle-dev-mode').addEventListener('change', async e => {
  const on = e.target.checked;
  await chrome.storage.local.set({ [DEV_MODE_KEY]: on });
  setDevToolsVisible(on);
  if (on) loadDevTools();
});

async function loadSkipPromoted() {
  const result = await chrome.storage.local.get(SKIP_PROMOTED_KEY);
  document.getElementById('toggle-skip-promoted').checked = !!result[SKIP_PROMOTED_KEY];
}

document.getElementById('toggle-skip-promoted').addEventListener('change', async e => {
  await chrome.storage.local.set({ [SKIP_PROMOTED_KEY]: e.target.checked });
});

async function loadSkipSuggested() {
  const result = await chrome.storage.local.get(SKIP_SUGGESTED_KEY);
  document.getElementById('toggle-skip-suggested').checked = !!result[SKIP_SUGGESTED_KEY];
}

document.getElementById('toggle-skip-suggested').addEventListener('change', async e => {
  await chrome.storage.local.set({ [SKIP_SUGGESTED_KEY]: e.target.checked });
});

async function loadSkipCompanies() {
  const result = await chrome.storage.local.get(SKIP_COMPANIES_KEY);
  document.getElementById('toggle-skip-companies').checked = !!result[SKIP_COMPANIES_KEY];
}

document.getElementById('toggle-skip-companies').addEventListener('change', async e => {
  await chrome.storage.local.set({ [SKIP_COMPANIES_KEY]: e.target.checked });
});

async function loadSkipRecommendedFor() {
  const result = await chrome.storage.local.get(SKIP_RECOMMENDED_KEY);
  document.getElementById('toggle-skip-recommended').checked = !!result[SKIP_RECOMMENDED_KEY];
}

document.getElementById('toggle-skip-recommended').addEventListener('change', async e => {
  await chrome.storage.local.set({ [SKIP_RECOMMENDED_KEY]: e.target.checked });
});

document.getElementById('btn-export-devlog').addEventListener('click', async () => {
  const result  = await chrome.storage.local.get(null);
  const entries = Object.entries(result)
    .filter(([k, v]) => k.startsWith(DEVLOG_PREFIX) && typeof v?.ts === 'number')
    .map(([, v]) => v)
    .sort((a, b) => b.ts - a.ts);
  const json = JSON.stringify(entries, null, 2);
  downloadBlob(new Blob([json], { type: 'application/json' }), `lai-devlog-${tsString()}.json`);
});

document.getElementById('btn-clear-log').addEventListener('click', async () => {
  const ok = await showModal('Clear the dev log? This cannot be undone.', 'Clear');
  if (!ok) return;
  const all  = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter(k => k.startsWith(DEVLOG_PREFIX));
  if (keys.length) await chrome.storage.local.remove(keys);
  document.getElementById('devlog-count').textContent = '0';
});

document.getElementById('btn-clear-cache').addEventListener('click', async () => {
  const ok = await showModal('Clear all cached post results?', 'Clear');
  if (!ok) return;
  const all  = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter(k => k.startsWith(CACHE_PREFIX));
  await chrome.storage.local.remove(keys);
  await loadStats();
  await loadDevTools();
});

// ── Reset controls ────────────────────────────────────────────────────────────

document.getElementById('btn-reset-author-stats').addEventListener('click', async () => {
  const ok = await showModal(
    'This will delete all author tracking data. Posts already classified will be re-tracked when seen again. Continue?',
    'Reset'
  );
  if (!ok) return;
  const all  = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter(k => k.startsWith(AUTHOR_STATS_PREFIX));
  if (keys.length) await chrome.storage.local.remove(keys);
  await loadDevTools();
});

document.getElementById('btn-reset-everything').addEventListener('click', async () => {
  const ok = await showModal(
    'This will delete cache, author stats, dev log, and word counts. API key and settings will be kept. Continue?',
    'Reset everything'
  );
  if (!ok) return;
  const all      = await chrome.storage.local.get(null);
  const preserve = new Set([
    APIKEY_KEY, DEV_MODE_KEY,
    MIN_POSTS_KEY, AI_THRESHOLD_KEY,
    SKIP_PROMOTED_KEY, SKIP_SUGGESTED_KEY, SKIP_COMPANIES_KEY, SKIP_RECOMMENDED_KEY,
  ]);
  const toRemove = Object.keys(all).filter(k => !preserve.has(k));
  await chrome.storage.local.remove(toRemove);
  await loadStats();
  await loadApiStatusSection();
  await loadDevTools();
});

// ── Footer navigation ─────────────────────────────────────────────────────────

document.getElementById('btn-open-stats').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('stats/stats.html') });
});

// ── Init ──────────────────────────────────────────────────────────────────────

// Wire digit filters on all text-mode number inputs.
['input-min-posts', 'input-ai-threshold'].forEach(id => {
  document.getElementById(id)?.addEventListener('input', digitFilter);
});

loadStats();
loadApiStatusSection();
loadDevMode();
loadThresholds();
loadSkipPromoted();
loadSkipSuggested();
loadSkipCompanies();
loadSkipRecommendedFor();
