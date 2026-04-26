// Popup script.

const CACHE_PREFIX      = 'post:';
const VERSION           = '0.2.0';
const APIKEY_KEY        = 'litmus:gptzeroApiKey';
const USAGE_KEY         = 'litmus:gptzeroUsage';
const CACHE_STATS_KEY   = 'litmus:stats:cache';
const AUTHOR_STATS_KEY  = 'litmus:authorStats';
const DEVLOG_KEY        = 'litmus:devlog:entries';
const DEV_MODE_KEY      = 'litmus:devMode';
const LIFETIME_KEY      = 'litmus:gptzeroUsageLifetime';
const MONTHLY_LIMIT_KEY = 'litmus:monthlyWordLimit';
const MIN_POSTS_KEY      = 'litmus:minPosts';
const AI_THRESHOLD_KEY   = 'litmus:aiThreshold';
const SKIP_PROMOTED_KEY    = 'litmus:skipPromotedPosts';
const SKIP_SUGGESTED_KEY   = 'litmus:skipSuggestedPosts';
const SKIP_COMPANIES_KEY   = 'litmus:skipCompanyPosts';
const SKIP_RECOMMENDED_KEY = 'litmus:skipRecommendedFor';

const DEFAULT_MONTHLY_LIMIT  = 10000;
const DEFAULT_MIN_POSTS       = 5;
const DEFAULT_AI_THRESHOLD    = 80;   // stored as integer percent (e.g. 80 = 80%)

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

function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
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

async function loadApiStatusSection() {
  const result       = await chrome.storage.local.get([APIKEY_KEY, USAGE_KEY, CACHE_STATS_KEY, MONTHLY_LIMIT_KEY]);
  const key          = result[APIKEY_KEY];
  const stored       = result[USAGE_KEY];
  const month        = currentMonth();
  const words        = (stored?.month === month) ? (stored.wordsSent ?? 0) : 0;
  const monthlyLimit = result[MONTHLY_LIMIT_KEY] ?? DEFAULT_MONTHLY_LIMIT;
  const cs           = result[CACHE_STATS_KEY] ?? { hits: 0, misses: 0 };
  const cacheTotal   = cs.hits + cs.misses;
  const hitRate      = cacheTotal > 0 ? Math.round(cs.hits / cacheTotal * 100) : null;
  const barPct       = Math.min(100, Math.round(words / monthlyLimit * 100));

  const usageRight = document.getElementById('api-usage-right');

  if (key) {
    showKeySavedState(key);
    usageRight.textContent = `${words.toLocaleString()} / ${monthlyLimit.toLocaleString()}`;
    usageRight.className   = 'api-usage-right';
    document.getElementById('usage-bar').style.width = barPct + '%';
    document.getElementById('usage-helper').textContent =
      hitRate != null ? `${hitRate}% cache hit · resets monthly` : 'resets monthly';
  } else {
    showKeyNoState();
    usageRight.textContent = 'API key required';
    usageRight.className   = 'api-usage-right err';
  }
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

  if (outcome === 'valid') {
    const r       = await chrome.storage.local.get(USAGE_KEY);
    const s       = r[USAGE_KEY];
    const mo      = currentMonth();
    const current = (!s || s.month !== mo) ? { month: mo, wordsSent: 0 } : { ...s };
    current.wordsSent += 1;
    await chrome.storage.local.set({ [USAGE_KEY]: current });
    await loadApiStatusSection();
    setKeyStatus('✓ Key valid', 'ok');
  } else {
    await loadApiStatusSection();
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

// ── Number input digit filter (Change 7) ─────────────────────────────────────
// Strips non-digit characters while typing; clamp happens on blur.
function digitFilter(e) {
  const prev = e.target.value;
  const next = prev.replace(/\D/g, '');
  if (next !== prev) e.target.value = next;
}

// ── Settings — shared helpers ─────────────────────────────────────────────────

function showSettingError(elId, msg) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.textContent = msg;
  el.style.display = msg ? '' : 'none';
}

// ── Settings — monthly word limit ─────────────────────────────────────────────

async function loadMonthlyLimit() {
  const result = await chrome.storage.local.get(MONTHLY_LIMIT_KEY);
  const val    = result[MONTHLY_LIMIT_KEY] ?? DEFAULT_MONTHLY_LIMIT;
  document.getElementById('input-monthly-limit').value = val;
}

document.getElementById('input-monthly-limit').addEventListener('blur', async e => {
  let raw = parseInt(e.target.value, 10);
  const errId = 'monthly-limit-error';
  if (isNaN(raw) || raw < 1000) {
    raw = 1000; e.target.value = raw;
  } else if (raw > 10_000_000) {
    raw = 10_000_000; e.target.value = raw;
  }
  e.target.classList.remove('err');
  showSettingError(errId, '');
  await chrome.storage.local.set({ [MONTHLY_LIMIT_KEY]: raw });
  await loadApiStatusSection();
});

// ── Settings — detection thresholds ──────────────────────────────────────────

async function loadThresholds() {
  const result = await chrome.storage.local.get([MIN_POSTS_KEY, AI_THRESHOLD_KEY]);
  document.getElementById('input-min-posts').value     = result[MIN_POSTS_KEY]     ?? DEFAULT_MIN_POSTS;
  document.getElementById('input-ai-threshold').value  = result[AI_THRESHOLD_KEY]  ?? DEFAULT_AI_THRESHOLD;
}

document.getElementById('input-min-posts').addEventListener('blur', async e => {
  let val = parseInt(e.target.value, 10);
  if (isNaN(val) || val < 1)  { val = 1;   e.target.value = val; }
  else if (val > 100)          { val = 100; e.target.value = val; }
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
  const result    = await chrome.storage.local.get(null);
  const entries   = result[DEVLOG_KEY] ?? [];
  const cacheSize = Object.keys(result).filter(k => k.startsWith(CACHE_PREFIX)).length;
  const cs        = result[CACHE_STATS_KEY] ?? { hits: 0, misses: 0 };
  const total     = cs.hits + cs.misses;
  const hitRate   = total > 0 ? Math.round(cs.hits / total * 100) : null;
  document.getElementById('devlog-count').textContent      = entries.length;
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
  const result = await chrome.storage.local.get(DEVLOG_KEY);
  const json   = JSON.stringify(result[DEVLOG_KEY] ?? [], null, 2);
  downloadBlob(new Blob([json], { type: 'application/json' }), `lai-devlog-${tsString()}.json`);
});

document.getElementById('btn-clear-log').addEventListener('click', async () => {
  const ok = await showModal('Clear the dev log? This cannot be undone.', 'Clear');
  if (!ok) return;
  await chrome.storage.local.remove(DEVLOG_KEY);
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
  await chrome.storage.local.remove(AUTHOR_STATS_KEY);
  await loadDevTools();
});

document.getElementById('btn-reset-word-counter').addEventListener('click', async () => {
  const ok = await showModal('Reset both monthly and lifetime word counts to zero?', 'Reset');
  if (!ok) return;
  await chrome.storage.local.remove([USAGE_KEY, LIFETIME_KEY]);
  await loadApiStatusSection();
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
    MONTHLY_LIMIT_KEY, MIN_POSTS_KEY, AI_THRESHOLD_KEY,
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
['input-monthly-limit', 'input-min-posts', 'input-ai-threshold'].forEach(id => {
  document.getElementById(id)?.addEventListener('input', digitFilter);
});

loadStats();
loadApiStatusSection();
loadDevMode();
loadMonthlyLimit();
loadThresholds();
loadSkipPromoted();
loadSkipSuggested();
loadSkipCompanies();
loadSkipRecommendedFor();
