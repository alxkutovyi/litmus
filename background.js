// Background service worker.
// Handles GPTZero API calls on behalf of content scripts.
// Content scripts cannot hold API keys safely; the background is the right
// place for outbound fetch to api.gptzero.me.
//
// Message protocol:
//   Request:  { type: 'classify', text: string }
//   Response: { label, score, confidenceCategory, engine: 'gptzero' }  (success)
//           | { error: 'no-key' | 'auth' | 'rate-limit' | 'network' }  (failure)

const APIKEY_KEY  = 'litmus:gptzeroApiKey';
const USAGE_KEY   = 'litmus:gptzeroUsage';
const GPTZERO_URL = 'https://api.gptzero.me/v2/predict/text';

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
}

runMigrations().catch(err => console.error('[Litmus] Migration failed:', err));

// ── Usage counter ─────────────────────────────────────────────────────────────

function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

const LIFETIME_KEY = 'litmus:gptzeroUsageLifetime';

async function incrementUsage(words) {
  try {
    const result  = await chrome.storage.local.get([USAGE_KEY, LIFETIME_KEY]);
    const stored  = result[USAGE_KEY];
    const month   = currentMonth();
    const current = (!stored || stored.month !== month)
      ? { month, wordsSent: 0 }
      : { ...stored };
    current.wordsSent += words;
    const lifetime = (result[LIFETIME_KEY] ?? 0) + words;
    await chrome.storage.local.set({ [USAGE_KEY]: current, [LIFETIME_KEY]: lifetime });
  } catch { /* non-critical — counter drift is acceptable */ }
}

// ── GPTZero fetch (with single retry) ─────────────────────────────────────────

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

  // Increment monthly word counter on every successful response.
  const words = text.split(/\s+/).filter(Boolean).length;
  await incrementUsage(words);

  return { label, score, confidenceCategory, engine: 'gptzero' };
}

// ── Message handler ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== 'classify') return false;

  (async () => {
    let apiKey;
    try {
      const result = await chrome.storage.local.get(APIKEY_KEY);
      apiKey = result[APIKEY_KEY];
    } catch {
      sendResponse({ error: 'network' });
      return;
    }

    if (!apiKey) {
      sendResponse({ error: 'no-key' });
      return;
    }

    const result = await fetchGPTZero(message.text, apiKey);
    sendResponse(result);
  })();

  return true; // keep message channel open for async sendResponse
});

// ── Dev utility ───────────────────────────────────────────────────────────────
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
