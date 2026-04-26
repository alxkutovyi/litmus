(function (LAI) {

  // SubtleCrypto is async by design (can offload to hardware).
  // Returns a full 64-char hex string.
  async function sha256(text) {
    const buf = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(text)
    );
    return Array.from(new Uint8Array(buf))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  // Identify profile-picture <img> elements by their alt text pattern.
  // LinkedIn generates "View {Name}'s profile" or "View {Name}' profile"
  // (the latter for names ending in 's'). Observed across all 6 samples.
  function isProfileImg(img) {
    return /^View .+['']\s*s?\s+profile$/i.test(img.alt ?? '');
  }

  // LinkedIn post URL: look for a timestamp/permalink <a> that contains
  // /feed/update/urn:li:activity:  LinkedIn renders this as a relative time link.
  function extractPostUrl(postElement) {
    const a = postElement.querySelector('a[href*="/feed/update/urn:li:activity:"]');
    return a?.href ?? null;
  }

  // ── v3 structured text extraction ───────────────────────────────────────────
  //
  // Preserves paragraph rhythm and list structure — signals used by GPTZero.
  //
  // Rules:
  //   <br>              → '\n'
  //   block elements    → '\n\n' before and after inner content
  //   <li>              → '\n- ' prefix (or existing marker kept if text starts with one)
  //   text nodes        → raw text (\xa0 → space)
  //   everything else   → recurse into children
  //
  // Post-processing:
  //   1. Per-line leading/trailing whitespace stripped
  //   2. Runs of 3+ blank lines collapsed to \n\n
  //   3. Zero-width Unicode characters removed
  //   4. Overall trim
  //
  // Does NOT collapse whitespace to single spaces.
  // Does NOT strip emoji.
  //
  // Multilingual note: button-strip removes expand-toggle labels regardless of
  // UI language (\xa0 and zero-width joins are stripped above).

  const BLOCK_TAGS = new Set([
    'p', 'div', 'section', 'article', 'blockquote', 'pre',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  ]);

  function extractStructuredText(bodyEl) {
    const clone = bodyEl.cloneNode(true);
    clone.querySelectorAll('button, [role="button"]').forEach(el => el.remove());

    function walk(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        return node.textContent.replace(/\xa0/g, ' ');
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return '';

      const tag = node.tagName.toLowerCase();

      if (tag === 'br') return '\n';

      const inner = Array.from(node.childNodes).map(walk).join('');

      if (BLOCK_TAGS.has(tag)) {
        // Wrap block content with double newlines; post-processing collapses
        // consecutive separators from deeply nested blocks.
        return '\n\n' + inner + '\n\n';
      }
      if (tag === 'li') {
        return '\n- ' + inner.trim();
      }
      return inner;
    }

    let text = walk(clone);

    // Strip per-line leading/trailing whitespace.
    text = text.split('\n').map(l => l.trim()).join('\n');
    // Collapse 3+ consecutive blank lines to a single blank line.
    text = text.replace(/\n{3,}/g, '\n\n');
    // Remove zero-width Unicode (joiners, BOM, word-joiner).
    text = text.replace(/[\u200b-\u200d\ufeff\u2060]/g, '');

    return text.trim() || null;
  }

  // Strip trailing expand-button labels that leaked past the button-strip.
  // Only matches at end of string, only when preceded by "…" (U+2026) or "..."
  // (three ASCII dots), so mid-sentence "more" is safe.
  //   Safe:  "furthermore, more details"    → unchanged
  //   Safe:  "moreover the study showed…"   → unchanged
  //   Strip: "see the full post…more"        → "see the full post"
  //   Strip: "see the full post…see more"    → "see the full post"
  function trimTrailingUI(text) {
    return text
      .replace(/(?:\u2026|\.{3})\s*see\s+more\s*$/i, '')
      .replace(/(?:\u2026|\.{3})\s*more\s*$/i, '')
      .trim();
  }

  const MAX_HTML_BYTES = 50 * 1024;

  LAI.extractPost = async function (postElement) {

    // ── Text ─────────────────────────────────────────────────────────────────
    const bodyEl = postElement.querySelector(LAI.SELECTORS.POST_BODY);

    // rawText: pre-cleaning structured text, stored for debugging only, not exported.
    const rawText = bodyEl ? (extractStructuredText(bodyEl) ?? '') : '';

    // Strip trailing expand-button labels that may have leaked past the button-strip.
    const text = trimTrailingUI(rawText);

    // Truncation heuristic: if even after cleaning the text ends with "…" or
    // "...", the visible content was clipped (genuine ellipsis or collapsed post).
    // False positives are possible (posts that genuinely end with "…") — the
    // flag is informational, human review resolves ambiguity.
    const truncated = /(?:\u2026|\.{3})\s*$/.test(text);

    // ── Cache key ─────────────────────────────────────────────────────────────
    // The :v3 suffix ensures v3 entries live in separate storage slots from
    // any v1/v2 leftovers, preventing stale entries from shadowing new results.
    let cacheKey = LAI.getCacheKey(postElement);
    if (!cacheKey) {
      const hash = await sha256(text.slice(0, 200));
      cacheKey = 'hash:' + hash;
    }
    cacheKey = cacheKey + ':v3';

    // ── Secondary-curation detection ──────────────────────────────────────────
    // Covers reshares ("reposted this"), likes/celebrates/supports, and
    // "commented on this" posts — all share the same DOM structure where
    // profileImgs[0] is the curator and profileImgs[1] is the original author.
    // Pattern is English-only; non-English accounts may misattribute.
    const isSecondaryCuration = Array.from(postElement.querySelectorAll('p'))
      .some(p => /(reposted|likes|supports|celebrates|commented on) this/i.test(p.textContent));

    // ── Author ────────────────────────────────────────────────────────────────
    // LinkedIn renders two <a href="/in/slug"> links per actor:
    //   Link 1 (avatar): wraps a <figure> containing the profile image.
    //                    Its aria-label reads "View {Name}'s profile" — DO NOT
    //                    use this as the display name.
    //   Link 2 (name):   wraps <div> → <p> elements; first <p> is the display name.
    //
    // Strategy: find /in/ links that have a <p> descendant but NO <figure> child
    // (that uniquely identifies the name links and avoids the avatar links).
    // For reshares, there are two such links: index 0 = resharer, index 1 = original.

    const allInLinks = Array.from(postElement.querySelectorAll('a[href*="/in/"]'))
      .filter(a => /\/in\/[^/?#\s]+/.test(a.href));

    // Name links have <p> children; avatar links wrap <figure>.
    const nameLinks = allInLinks.filter(a => !a.querySelector('figure') && a.querySelector('p'));

    // For secondary curation (reshare, like, etc.): resharer comes first → pick second.
    const nameLinkIdx = (isSecondaryCuration && nameLinks.length >= 2) ? 1 : 0;
    const nameLink    = nameLinks[nameLinkIdx] ?? null;

    // ── Company/promoted post fallback ────────────────────────────────────────
    // Promoted posts link to /company/<slug>/ instead of /in/<slug>/.
    // If no personal name link found, look for a company link.
    let companyLink = null;
    if (!nameLink) {
      const companyLinks = Array.from(postElement.querySelectorAll('a[href*="/company/"]'))
        .filter(a => /\/company\/[^/?#\s]+/.test(a.href))
        .filter(a => !a.querySelector('figure'));
      companyLink = companyLinks[0] ?? null;
    }

    const activeAuthorLink = nameLink ?? companyLink;
    const authorType       = nameLink ? 'person' : (companyLink ? 'company' : null);

    // Profile URL: from whichever author link matched.
    const authorProfileUrl = activeAuthorLink?.href?.replace(/[?#].*$/, '') ?? null;

    // authorId: slug from /in/ (person) or /company/ (company).
    const authorIdPattern = authorType === 'company'
      ? /\/company\/([^/?#]+)/
      : /\/in\/([^/?#]+)/;
    const authorIdSlug    = authorProfileUrl?.match(authorIdPattern)?.[1] ?? null;
    // Namespace: "person:<slug>" or "company:<slug>" — prevents collisions and
    // matches the storage format established by Migration 1 in background.js.
    const authorId        = authorIdSlug && authorType ? `${authorType}:${authorIdSlug}` : null;

    // ── Author name helpers ────────────────────────────────────────────────────
    // visibleText: concatenates only non-aria-hidden children, avoiding badge
    // spans (Premium Profile, 2nd, etc.) that LinkedIn marks aria-hidden="true".
    function visibleText(el) {
      if (!el) return '';
      return Array.from(el.childNodes)
        .filter(n => {
          if (n.nodeType === Node.TEXT_NODE) return true;
          if (n.nodeType !== Node.ELEMENT_NODE) return false;
          return n.getAttribute('aria-hidden') !== 'true';
        })
        .map(n => n.textContent)
        .join('')
        .trim();
    }

    // cleanAuthorName: strip any residual badge text that slipped through
    // (different LinkedIn locales / A-B tests may not use aria-hidden), then
    // collapse duplicated names like "Adam Garcia Adam Garcia".
    function cleanAuthorName(name) {
      if (!name) return name;
      let n = name;

      // 1. Strip LinkedIn badge labels: "Premium Profile", "Verified Profile",
      //    and any future "{Capitalized} Profile" variant. Case-sensitive so
      //    lowercase "profile" in a real name is not stripped.
      n = n.replace(/\s*[A-Z][a-z]+ Profile\s*/g, ' ');

      // 2. Strip connection-degree badges (1st, 2nd, 3rd, 3rd+).
      n = n.replace(/\s*\d+(?:st|nd|rd|th)\+?\s*/g, ' ');

      // 3. Strip aria-label profile-view text.
      n = n.replace(/\s*View .+?[''\u2019]s?\s+profile\s*/gi, ' ');

      // 4. Strip middle-dots, bullets, separator chars.
      n = n.replace(/[\u00b7\u2022\u2013\u2014|]/g, ' ');

      // 5. Collapse whitespace, trim.
      n = n.replace(/\s+/g, ' ').trim();

      // 6. Token-based dedupe: "Adam Garcia Adam Garcia" → "Adam Garcia".
      const tokens = n.split(' ');
      if (tokens.length >= 2 && tokens.length % 2 === 0) {
        const half   = tokens.length / 2;
        const first  = tokens.slice(0, half).join(' ');
        const second = tokens.slice(half).join(' ');
        if (first === second) n = first;
      }

      return n || null;
    }

    // Name: first <p> for people; <p> or <span> text for companies.
    // Use visibleText() to skip aria-hidden badge spans (Premium, 2nd, etc.).
    // No aria-label fallback — those always contain "View {Name}'s profile" text.
    let author = visibleText(nameLink?.querySelector('p')) ||
                 visibleText(companyLink?.querySelector('p')) ||
                 visibleText(companyLink?.querySelector('span')) ||
                 null;
    author = cleanAuthorName(author);
    // Strip trailing middots, bullets, or whitespace that sometimes leaks in.
    if (author) author = author.replace(/[\u00b7\u2022\s·]+$/, '').trim() || null;

    // ── Media ──────────────────────────────────────────────────────────────────
    // Videos are unambiguous. For images, exclude profile pictures (matched by
    // isProfileImg) and empty-alt decorative images.
    const hasVideo         = !!postElement.querySelector('video');
    const hasNonProfileImg = Array.from(postElement.querySelectorAll('img[alt]'))
      .some(img => img.alt !== '' && !isProfileImg(img));
    const hasMedia = hasVideo || hasNonProfileImg;

    // ── Label context helper ───────────────────────────────────────────────────
    // LinkedIn renders "Promoted" and "Suggested" labels as <p componentkey="…">
    // elements that are often placed in a parent wrapper OUTSIDE the listitem
    // div that the observer fires on. We must search both inside the post element
    // AND in p/span[componentkey] siblings of the post (excluding those that
    // belong to other post wrappers).
    function getLabelElements(el) {
      const fromPost = Array.from(el.querySelectorAll('p, span'));
      const parent   = el.parentElement;
      if (!parent) return fromPost;
      const fromContext = Array.from(
        parent.querySelectorAll('p[componentkey], span[componentkey]')
      ).filter(node =>
        !el.contains(node) &&
        !node.closest('[componentkey*="FeedType_MAIN_FEED"]')
      );
      return [...fromPost, ...fromContext];
    }
    const labelEls = getLabelElements(postElement);

    // ── Promoted ───────────────────────────────────────────────────────────────
    // Structural selectors first; text fallback uses /^promoted\b/i so it also
    // matches "Promoted by <Company>" variants.
    const isPromoted = LAI.SELECTORS.PROMOTED_MARKER.some(
      sel => !!postElement.querySelector(sel)
    ) || labelEls.some(el => /^promoted\b/i.test(el.textContent?.trim()));

    // ── Suggested ──────────────────────────────────────────────────────────────
    // Algorithmic post recommendations LinkedIn labels with "Suggested".
    const isSuggested = labelEls.some(el => /^suggested$/i.test(el.textContent?.trim()));

    // ── Recommended for you ────────────────────────────────────────────────────
    // "People you may know" / follow-suggestion widgets LinkedIn labels with
    // "Recommended for you".
    const isRecommendedFor = Array.from(postElement.querySelectorAll('p, span'))
      .some(el => /^recommended for you$/i.test(el.textContent?.trim()));

    const wordCount = text ? text.split(/\s+/).filter(Boolean).length : 0;

    // ── Post URL ───────────────────────────────────────────────────────────────
    const postUrl = extractPostUrl(postElement);

    // ── Raw HTML snapshot ──────────────────────────────────────────────────────
    // Truncated to MAX_HTML_BYTES to avoid blowing chrome.storage quota.
    let rawHtml = postElement.outerHTML ?? '';
    let rawHtmlTruncated = false;
    if (new Blob([rawHtml]).size > MAX_HTML_BYTES) {
      const encoded = new TextEncoder().encode(rawHtml);
      rawHtml = new TextDecoder().decode(encoded.slice(0, MAX_HTML_BYTES));
      rawHtmlTruncated = true;
    }

    const result = {
      cacheKey,
      author,
      authorId,
      authorType,
      authorProfileUrl,
      postUrl,
      text,
      rawText,          // pre-cleaning, debug only, not exported to ZIP
      wordCount,
      truncated,
      hasMedia,
      isSecondaryCuration,
      isPromoted,
      isSuggested,
      isRecommendedFor,
      rawHtml,
      rawHtmlTruncated,
      extractedAt:      Date.now(),
      extractorVersion: '3',
    };

    if (LAI.DEV_MODE) {
      console.log(`${LAI.LOG_PREFIX} extracted:`, {
        cacheKey,
        author,
        authorId,
        authorType,
        authorProfileUrl,
        isSecondaryCuration,
        isPromoted,
        isSuggested,
        isRecommendedFor,
        wordCount,
        truncated,
      });
    }

    return result;
  };

}(window.LAI = window.LAI || {}));
