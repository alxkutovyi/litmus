// Background service worker.
// Handles GPTZero API calls on behalf of content scripts.
// Content scripts cannot hold API keys safely; the background is the right
// place for outbound fetch to api.gptzero.me.
//
// Message protocol:
//   Request:  { type: 'classify', text: string }
//   Response: { label, score, confidenceCategory, engine: 'gptzero' }  (success)
//           | { error: 'no-key' | 'auth' | 'rate-limit' | 'network' }  (failure)

const APIKEY_KEY       = 'litmus:gptzeroApiKey';
const GPTZERO_URL      = 'https://api.gptzero.me/v2/predict/text';
const USAGE_STATS_KEY  = 'litmus:usageStats';

// ── Storage migration ──────────────────────────────────────────────────────────
// Migration 1: namespace authorIds as "person:<slug>" or "company:<slug>".
// Runs once at service-worker startup; gated on migrationVersion to prevent
// running twice.

async function runMigrations() {
  // Check both the old bare key and the new litmus: prefixed key so the runner
  // works correctly before AND after Migration 6 moves the version counter.
  const vResult = await chrome.storage.local.get(['migrationVersion', 'litmus:migrationVersion']);
  let version   = vResult['litmus:migrationVersion'] ?? vResult.migrationVersion ?? 0;

  // ── Migration 1: namespace authorIds as "person:<slug>" or "company:<slug>" ──
  if (version < 1) {
    const data        = await chrome.storage.local.get(['authorStats', 'blacklist', 'whitelist']);
    const authorStats = data.authorStats ?? {};
    const blacklist   = data.blacklist   ?? [];
    const whitelist   = data.whitelist   ?? [];

    const newStats = {};
    let statsCount = 0;
    for (const [key, record] of Object.entries(authorStats)) {
      if (key.startsWith('person:') || key.startsWith('company:')) {
        newStats[key] = record; // already namespaced
      } else {
        const type   = record.authorType === 'company' ? 'company' : 'person';
        const newKey = `${type}:${key}`;
        newStats[newKey] = { ...record, authorId: newKey };
        statsCount++;
      }
    }

    const namespaceId = id =>
      (id.startsWith('person:') || id.startsWith('company:')) ? id : `person:${id}`;

    const newBlacklist = blacklist.map(e => ({ ...e, authorId: namespaceId(e.authorId) }));
    const newWhitelist = whitelist.map(e => ({ ...e, authorId: namespaceId(e.authorId) }));

    await chrome.storage.local.set({
      authorStats:      newStats,
      blacklist:        newBlacklist,
      whitelist:        newWhitelist,
      migrationVersion: 1,
    });

    console.log(`[LAI] Migration 1 complete: namespaced ${statsCount} authorStats entries, ${blacklist.length} blacklist entries, ${whitelist.length} whitelist entries.`);
    version = 1;
  }

  // ── Migration 2: clear blacklist entries that were auto-added by the old ──────
  // action-dispatcher (which incorrectly called Blacklist.add() on threshold-
  // cross). Those entries look like manual hides but were never chosen by the
  // user. Clearing them lets auto-hidden logic take over cleanly.
  if (version < 2) {
    await chrome.storage.local.set({ blacklist: [], migrationVersion: 2 });
    console.log('[LAI] Migration 2: cleared previously auto-added blacklist entries. Manually re-blacklist any authors you want permanently hidden.');
    version = 2;
  }

  // ── Shared name cleaner (used by Migrations 3 and 4) ─────────────────────
  function cleanName(name) {
    if (!name) return name;
    let n = name;
    n = n.replace(/\s*[A-Z][a-z]+ Profile\s*/g, ' ');  // "Premium/Verified/… Profile"
    n = n.replace(/\s*\d+(?:st|nd|rd|th)\+?\s*/g, ' '); // connection-degree badges
    n = n.replace(/\s*View .+?[''\u2019]s?\s+profile\s*/gi, ' '); // aria-label text
    n = n.replace(/[\u00b7\u2022\u2013\u2014|]/g, ' ');  // middots, bullets, pipes
    n = n.replace(/\s+/g, ' ').trim();
    const tokens = n.split(' ');
    if (tokens.length >= 2 && tokens.length % 2 === 0) {
      const half   = tokens.length / 2;
      const first  = tokens.slice(0, half).join(' ');
      const second = tokens.slice(half).join(' ');
      if (first === second) n = first;
    }
    return n || null;
  }

  // ── Migration 3: clean contaminated author names ───────────────────────────
  // Extractor used textContent which included aria-hidden badge spans
  // (Premium Profile, 2nd, etc.), producing names like
  // "Adam Garcia Premium Profile 2ndAdam Garcia". Strip those artifacts and
  // collapse exact-duplicate names.
  if (version < 3) {
    const data = await chrome.storage.local.get(['authorStats', 'blacklist', 'whitelist']);

    const newStats = {};
    for (const [key, record] of Object.entries(data.authorStats ?? {})) {
      newStats[key] = { ...record, name: cleanName(record.name) };
    }
    const newBlacklist = (data.blacklist ?? []).map(e => ({ ...e, name: cleanName(e.name) }));
    const newWhitelist = (data.whitelist ?? []).map(e => ({ ...e, name: cleanName(e.name) }));

    await chrome.storage.local.set({
      authorStats:      newStats,
      blacklist:        newBlacklist,
      whitelist:        newWhitelist,
      migrationVersion: 3,
    });
    console.log('[LAI] Migration 3: cleaned author names.');
    version = 3;
  }

  // ── Migration 4: re-clean names with generalized badge regex ──────────────
  // Migration 3 only stripped "Premium Profile". Migration 4 extends that to
  // any "{Capitalized} Profile" pattern (e.g. "Verified Profile") and adds
  // middot/bullet/pipe stripping and token-based deduplication.
  if (version < 4) {
    const data = await chrome.storage.local.get(['authorStats', 'blacklist', 'whitelist']);

    const newStats = {};
    for (const [key, record] of Object.entries(data.authorStats ?? {})) {
      newStats[key] = { ...record, name: cleanName(record.name) };
    }
    const newBlacklist = (data.blacklist ?? []).map(e => ({ ...e, name: cleanName(e.name) }));
    const newWhitelist = (data.whitelist ?? []).map(e => ({ ...e, name: cleanName(e.name) }));

    await chrome.storage.local.set({
      authorStats:      newStats,
      blacklist:        newBlacklist,
      whitelist:        newWhitelist,
      migrationVersion: 4,
    });
    console.log('[LAI] Migration 4: cleaned author names with generalized badge regex.');
    version = 4;
  }

  // ── Migration 6: rename all storage keys to litmus: prefix ────────────────
  // Consolidates the extension's storage namespace. After this migration all
  // reads/writes in the codebase use litmus:-prefixed keys.
  if (version < 6) {
    const oldKeys = [
      'authorStats', 'blacklist', 'whitelist',
      'minPosts', 'aiThreshold',
      'skipPromotedPosts', 'skipSuggestedPosts', 'skipCompanyPosts', 'skipRecommendedFor',
      'gptzeroApiKey', 'gptzeroUsage', 'gptzeroUsageLifetime',
      'session:scanned', 'stats:cache', 'devlog:entries',
      'tableMinPostsFilter', 'devMode', 'monthlyWordLimit',
    ];
    const data = await chrome.storage.local.get(oldKeys);
    const writes = {};
    for (const key of oldKeys) {
      if (data[key] !== undefined) writes[`litmus:${key}`] = data[key];
    }
    if (Object.keys(writes).length) {
      await chrome.storage.local.set(writes);
      await chrome.storage.local.remove(oldKeys);
    }
    await chrome.storage.local.set({ 'litmus:migrationVersion': 6 });
    await chrome.storage.local.remove('migrationVersion');
    console.log('[Litmus] Migration 6: renamed storage keys with litmus: prefix.');
    version = 6;
  }

  // ── Migration 7: clear dev log (old entries stored full post text) ────────
  // Dev log format changed: text and reasons fields removed to prevent storage
  // quota exhaustion. Wipe existing entries so no old bloated entries remain.
  if (version < 7) {
    await chrome.storage.local.remove('litmus:devlog:entries');
    await chrome.storage.local.set({ 'litmus:migrationVersion': 7 });
    console.log('[Litmus] Migration 7: cleared dev log (old format with text bodies).');
    version = 7;
  }

  // ── Migration 8: dev log — single-array → per-entry keys ─────────────────
  // Old: 'litmus:devlog:entries' → [ entry, ... ]
  // New: 'litmus:devlog:<ts>'   → entry  (one key per entry)
  // Per-entry keys allow O(1) writes and make per-entry eviction trivial.
  if (version < 8) {
    const data    = await chrome.storage.local.get('litmus:devlog:entries');
    const entries = data['litmus:devlog:entries'];
    if (Array.isArray(entries) && entries.length > 0) {
      const writes = {};
      const seen   = new Set();
      for (const entry of entries) {
        let ts = entry.ts ?? Date.now();
        // Guard against duplicate timestamps.
        while (seen.has(ts)) ts++;
        seen.add(ts);
        writes[`litmus:devlog:${ts}`] = { ...entry, ts };
      }
      await chrome.storage.local.set(writes);
    }
    await chrome.storage.local.remove('litmus:devlog:entries');
    await chrome.storage.local.set({ 'litmus:migrationVersion': 8 });
    console.log(`[Litmus] Migration 8: dev log migrated to per-entry keys (${Array.isArray(entries) ? entries.length : 0} entries).`);
    version = 8;
  }

  // ── Migration 9: author stats — single-object → per-author keys ──────────
  // Old: 'litmus:authorStats'          → { [authorId]: record, ... }
  // New: 'litmus:authorStats:<authorId>' → record
  // Per-author keys allow O(1) writes and enable author-level eviction.
  if (version < 9) {
    const data  = await chrome.storage.local.get('litmus:authorStats');
    const stats = data['litmus:authorStats'];
    let migratedCount = 0;
    if (stats && typeof stats === 'object' && !Array.isArray(stats)) {
      const writes = {};
      for (const [authorId, record] of Object.entries(stats)) {
        writes[`litmus:authorStats:${authorId}`] = record;
        migratedCount++;
      }
      if (Object.keys(writes).length) await chrome.storage.local.set(writes);
    }
    await chrome.storage.local.remove('litmus:authorStats');
    await chrome.storage.local.set({ 'litmus:migrationVersion': 9 });
    console.log(`[Litmus] Migration 9: author stats migrated to per-author keys (${migratedCount} authors).`);
    version = 9;
  }
}

runMigrations().catch(err => console.error('[Litmus] Migration failed:', err));

// ── GPTZero usage-stats fetch ─────────────────────────────────────────────────
// Calls the /v3/usage-stats endpoint and caches the result.
// On any error returns { error } without overwriting the cached stats.

async function fetchUsageStats(apiKey) {
  let resp;
  try {
    resp = await fetch('https://api.gptzero.me/v3/usage-stats', {
      headers: { 'x-api-key': apiKey },
    });
  } catch {
    return { error: 'network' };
  }

  if (resp.status === 401) return { error: 'auth' };
  if (resp.status === 429) return { error: 'rate-limit' };
  if (!resp.ok)            return { error: 'network' };

  let body;
  try { body = await resp.json(); } catch { return { error: 'network' }; }

  const d = body?.data;
  if (!d || typeof d.words_used === 'undefined') return { error: 'malformed' };

  const stats = {
    wordsLeft:  d.words_left  ?? null,
    wordsUsed:  d.words_used  ?? 0,
    cycleStart: d.cycle_start ?? null,
    cycleEnd:   d.cycle_end   ?? null,
    plan:       d.plan        ?? null,
    fetchedAt:  Date.now(),
  };

  await chrome.storage.local.set({ [USAGE_STATS_KEY]: stats });
  return stats;
}

// Counter: refresh usage stats every 25 successful classifications.
let _classifyCount = 0;

// ── GPTZero classify fetch (with single retry) ────────────────────────────────

async function fetchGPTZero(text, apiKey) {
  const url  = GPTZERO_URL;
  const init = {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body:    JSON.stringify({ document: text, multilingual: false }),
  };

  let resp;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      resp = await fetch(url, init);
    } catch {
      continue; // network failure — try again
    }

    if (resp.status === 401) return { error: 'auth' };
    if (resp.status === 429) return { error: 'rate-limit' };
    if (resp.ok) break;
    // 5xx — loop for one more attempt
  }

  if (!resp?.ok) return { error: 'network' };

  let data;
  try { data = await resp.json(); } catch { return { error: 'network' }; }

  const doc = data?.documents?.[0];
  if (!doc) return { error: 'network' };

  const classification   = doc.document_classification ?? 'HUMAN_ONLY';
  const probs            = doc.class_probabilities ?? {};
  const confidenceCategory = doc.confidence_category ?? 'low';

  let label, score;
  if (classification === 'AI_ONLY') {
    label = 'ai';    score = probs.ai    ?? 0;
  } else if (classification === 'MIXED') {
    label = 'mixed'; score = probs.mixed ?? 0;
  } else {
    label = 'human'; score = probs.human ?? 0;
  }

  return { label, score, confidenceCategory, engine: 'gptzero' };
}

// ── Message handler ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  if (message.type === 'classify') {
    (async () => {
      let apiKey;
      try {
        const result = await chrome.storage.local.get(APIKEY_KEY);
        apiKey = result[APIKEY_KEY];
      } catch {
        sendResponse({ error: 'network' });
        return;
      }

      if (!apiKey) { sendResponse({ error: 'no-key' }); return; }

      const result = await fetchGPTZero(message.text, apiKey);
      sendResponse(result);

      // Opportunistically refresh usage stats every 25 successful calls.
      if (!result.error) {
        _classifyCount++;
        if (_classifyCount % 25 === 0) {
          fetchUsageStats(apiKey).catch(() => {});
        }
      }
    })();
    return true;
  }

  if (message.type === 'fetchUsageStats') {
    (async () => {
      const result = await chrome.storage.local.get(APIKEY_KEY);
      const apiKey = result[APIKEY_KEY];
      if (!apiKey) { sendResponse({ error: 'no-key' }); return; }
      const stats = await fetchUsageStats(apiKey);
      sendResponse(stats);
    })();
    return true;
  }

  return false;
});

// ── Dev log diagnostic ────────────────────────────────────────────────────────
// Run from the service worker DevTools console to inspect the current dev log.
//
//   Usage: await LAI_devLogStatus()
//
// Prints: entry count, entries with text, label distribution, date range,
// average word count, and the first entry as a sample.

self.LAI_devLogStatus = async function () {
  const DEVLOG_PREFIX = 'litmus:devlog:';
  const all     = await chrome.storage.local.get(null);
  const entries = Object.entries(all)
    .filter(([k, v]) => k.startsWith(DEVLOG_PREFIX) && typeof v?.ts === 'number')
    .map(([, v]) => v)
    .sort((a, b) => b.ts - a.ts);

  if (entries.length === 0) {
    console.log('[Litmus devLogStatus] Dev log is empty.');
    return;
  }

  const withText  = entries.filter(e => e.text && e.text.trim().length > 0).length;
  const labelDist = { ai: 0, mixed: 0, human: 0, other: 0 };
  let totalWords  = 0;
  for (const e of entries) {
    if (e.label === 'ai')         labelDist.ai++;
    else if (e.label === 'mixed') labelDist.mixed++;
    else if (e.label === 'human') labelDist.human++;
    else                          labelDist.other++;
    if (e.wordCount) totalWords += e.wordCount;
  }
  const avgWords = entries.length > 0 ? Math.round(totalWords / entries.length) : 0;

  const timestamps = entries.map(e => e.ts).filter(Boolean);
  const oldest = timestamps.length ? new Date(Math.min(...timestamps)).toISOString() : 'N/A';
  const newest = timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : 'N/A';

  console.log(`[Litmus devLogStatus]
  Entries:    ${entries.length} (${withText} have text)
  Labels:     AI=${labelDist.ai}, Mixed=${labelDist.mixed}, Human=${labelDist.human}${labelDist.other ? ', Other=' + labelDist.other : ''}
  Date range: ${oldest} → ${newest}
  Avg words:  ${avgWords}
  Sample (newest entry):`);
  console.log(entries[0]);
};

// ── Structure test ────────────────────────────────────────────────────────────
// Run from the service worker DevTools console to test whether GPTZero scores
// differ between structured text (with \n\n paragraph breaks) and a flattened
// version (all newlines replaced with spaces).
//
//   Usage: await LAI_structureTest(myPostText)
//
// Two API calls are made (words counted twice against your monthly quota).

self.LAI_structureTest = async function (text) {
  const result = await chrome.storage.local.get(APIKEY_KEY);
  const key    = result[APIKEY_KEY];
  if (!key) { console.log('[LAI] No API key configured'); return; }

  const structured = text;
  const flattened  = text.replace(/\n+/g, ' ');

  console.log('[LAI structureTest] sending structured version…');
  console.log('[LAI structureTest] sending flattened version…');
  const [r1, r2] = await Promise.all([
    fetchGPTZero(structured, key),
    fetchGPTZero(flattened,  key),
  ]);

  console.log('[LAI structureTest] structured:', r1);
  console.log('[LAI structureTest] flattened: ', r2);
  if (!r1.error && !r2.error) {
    const delta = Math.abs(r1.score - r2.score);
    console.log(`[LAI structureTest] score delta: ${(delta * 100).toFixed(1)}pp — structure is ${delta < 0.01 ? 'NOT used' : 'BEING USED'} by GPTZero`);
  }
};

// ── Storage health watchdog ───────────────────────────────────────────────────
// Runs on service-worker startup and every 30 minutes.
// Logs storage usage and proactively evicts post:* cache entries if total
// storage exceeds 8 MB (the same threshold used in cache.js).

const WATCHDOG_THRESHOLD_BYTES = 8 * 1024 * 1024; // 8 MB

// Evicts the oldest 30% of post:* cache entries.
// Mirrors the emergency-eviction logic in cache.js, used from background
// context where LAI.Cache is not available.
async function _backgroundEvictCache() {
  const all = await chrome.storage.local.get(null);
  const postPairs = Object.entries(all)
    .filter(([k]) => k.startsWith('post:'))
    .sort(([, a], [, b]) => (a?.cachedAt ?? 0) - (b?.cachedAt ?? 0));
  if (!postPairs.length) return 0;
  const evictCount = Math.max(1, Math.ceil(postPairs.length * 0.30));
  const toDelete   = postPairs.slice(0, evictCount).map(([k]) => k);
  await chrome.storage.local.remove(toDelete);
  return toDelete.length;
}

async function storageHealthCheck() {
  let totalBytes;
  try {
    totalBytes = await chrome.storage.local.getBytesInUse(null);
  } catch {
    return; // getBytesInUse unavailable (unlikely but guard it)
  }

  const totalKB = Math.round(totalBytes / 1024);
  const limitKB = Math.round(WATCHDOG_THRESHOLD_BYTES / 1024);

  const all = await chrome.storage.local.get(null);
  const prefixCounts = {
    'post:':                 0,
    'litmus:devlog:':        0,
    'litmus:authorStats:':   0,
    'litmus:blacklist':      0,
    'litmus:whitelist':      0,
    'other':                 0,
  };
  for (const key of Object.keys(all)) {
    let matched = false;
    for (const prefix of Object.keys(prefixCounts).filter(p => p !== 'other')) {
      if (key.startsWith(prefix)) { prefixCounts[prefix]++; matched = true; break; }
    }
    if (!matched) prefixCounts['other']++;
  }

  console.log(`[Litmus] Storage health: ${totalKB}KB / ${limitKB}KB threshold`, prefixCounts);

  if (totalBytes > WATCHDOG_THRESHOLD_BYTES) {
    console.warn(`[Litmus] Storage exceeds ${limitKB}KB — triggering proactive cache eviction`);
    try {
      const evicted = await _backgroundEvictCache();
      console.warn(`[Litmus] Watchdog evicted ${evicted} post:* cache entries`);
    } catch (err) {
      console.warn('[Litmus] Watchdog eviction failed:', err);
    }
  }
}

// Run on startup, then every 30 minutes.
storageHealthCheck().catch(() => {});
setInterval(() => storageHealthCheck().catch(() => {}), 30 * 60 * 1000);

// ── Storage report ────────────────────────────────────────────────────────────
// Run from the service worker DevTools console to inspect storage usage.
//
//   Usage: await LAI_storageReport()
//
// Prints total bytes used, per-prefix entry counts, and the 5 largest keys.

self.LAI_storageReport = async function () {
  const totalBytes = await chrome.storage.local.getBytesInUse(null);
  const all        = await chrome.storage.local.get(null);

  const groups = {
    'post:':               [],
    'litmus:devlog:':      [],
    'litmus:authorStats:': [],
    'litmus:blacklist':    [],
    'litmus:whitelist':    [],
    'litmus: (other)':     [],
    'other':               [],
  };

  for (const key of Object.keys(all)) {
    if      (key.startsWith('post:'))               groups['post:'].push(key);
    else if (key.startsWith('litmus:devlog:'))       groups['litmus:devlog:'].push(key);
    else if (key.startsWith('litmus:authorStats:'))  groups['litmus:authorStats:'].push(key);
    else if (key.startsWith('litmus:blacklist'))     groups['litmus:blacklist'].push(key);
    else if (key.startsWith('litmus:whitelist'))     groups['litmus:whitelist'].push(key);
    else if (key.startsWith('litmus:'))              groups['litmus: (other)'].push(key);
    else                                             groups['other'].push(key);
  }

  // Estimate individual key sizes via JSON serialisation length.
  const enc      = new TextEncoder();
  const keySizes = Object.entries(all).map(([k, v]) => ({
    key:   k,
    bytes: enc.encode(k).length + enc.encode(JSON.stringify(v)).length,
  })).sort((a, b) => b.bytes - a.bytes);

  const totalKB = Math.round(totalBytes / 1024);
  console.log(`[Litmus] Storage Report — ${totalKB}KB total (~10240KB Chrome default limit)`);
  console.table(Object.fromEntries(
    Object.entries(groups).map(([prefix, keys]) => [prefix, keys.length])
  ));
  console.log('Top 5 largest keys (estimated):');
  for (const { key, bytes } of keySizes.slice(0, 5)) {
    console.log(`  ${String(Math.round(bytes / 1024)).padStart(4)}KB  ${key}`);
  }
};
