'use strict';

/**
 * detectWhatsAppCommerce — sniffs WhatsApp-commerce signals from a scrape.
 *
 * Why this exists (and lives in /scraper instead of /urlToAds):
 *
 * Gulf SMBs sell through WhatsApp at a rate the rest of the world doesn't
 * appreciate. A perfume shop in Karama, a bridal atelier in Jeddah, an
 * electronics dealer in Salmiya — they put a wa.me link in the header and
 * the storefront IS the chat. Most ad-copy generators ignore this; they
 * write "Shop now" buttons for sites where the actual buying motion is
 * "DM us for prices". That mismatch torches CTR for half our addressable
 * market.
 *
 * This detector is a deliberately small surface: it takes whatever the
 * urlScraper produced (HTML + extracted CTAs + extracted social handles)
 * and returns a confidence-graded report about whether WhatsApp is the
 * primary commerce channel. The downstream copy generator then writes
 * variants that match the WA-first buying motion.
 *
 * Detection rules (kept simple — pure regex/string passes, no parser):
 *   1. Any href to wa.me, api.whatsapp.com/send, chat.whatsapp.com, wa.link
 *   2. International phone numbers (+971/+966/+91/+965/+974/+973/+968 etc.)
 *      sitting within ~50 chars of a "WhatsApp" / "WA" mention
 *   3. CTA keywords like "DM for prices", "WhatsApp catalog",
 *      "Order via WhatsApp", "Reply HELLO", "View catalog on WhatsApp"
 *   4. Catalogue presence — wa.me URLs with /c/ path or "catalog/catalogue"
 *      appearing within ~80 chars of a WhatsApp reference
 *
 * Confidence ladder:
 *   high   — waLinks ≥ 1 AND a CTA matches AND a phone number is present
 *   medium — exactly two of those three signals
 *   low    — exactly one signal
 *   (no detection at all → detected: false)
 *
 * Forgiving by design: passing in a half-built scrape, an empty object, or
 * `null` returns a clean `detected: false` object. This is invoked inside
 * the hot scan path; it must never throw.
 */

// E.164-ish phone matcher tuned for Gulf + India + UK + global fallback.
// We don't try to validate carrier codes — too many false negatives. We just
// require a leading + and 7–15 digits, optionally interspersed with spaces,
// dashes, parentheses (so "+971 50 123 4567" matches).
const PHONE_E164_RE = /\+\d{1,3}[\s\-().]{0,2}\d{1,4}[\s\-().]{0,2}\d{2,4}[\s\-().]{0,2}\d{2,4}[\s\-().]{0,2}\d{0,4}/g;

// WhatsApp CTA copy patterns. These are the phrases real merchants put on
// hero sections, sticky bars, and product cards. The list is intentionally
// regional — UAE/KSA/India phrasing dominates because that's where the
// detection signal pays off most.
const CTA_PATTERNS = [
  // "DM us for prices", "Message me for details", "Chat us for catalog"
  // Longer alternatives first so regex prefers "prices" over "price".
  /\b(?:DM|message|chat|ping|text)\s+(?:us|me)\s+(?:for|about|to)\s+(?:catalogue|catalog|pricing|prices|price|details|orders|order|booking|inquiry|enquiry|info)/i,
  // "Reply HELLO on WhatsApp", "Reply START to begin"
  /\bReply\s+(?:HELLO|HI|HEY|START|MENU|YES|ORDER|CATALOG|CATALOGUE)\b[^.!?\n]{0,40}\bWhats[\s-]*App\b/i,
  // "WhatsApp catalog", "View catalog on WhatsApp", "Catalog on WhatsApp"
  /\b(?:View\s+)?(?:our\s+)?(?:full\s+)?catalog(?:ue)?\s+(?:on|via|through)\s+Whats[\s-]*App\b/i,
  /\bWhats[\s-]*App\s+catalog(?:ue)?\b/i,
  // "Order via WhatsApp", "Order on WhatsApp", "Buy via WhatsApp"
  /\b(?:order|buy|shop|purchase|book|reserve|enquire|inquire)\s+(?:via|on|through|by)\s+Whats[\s-]*App\b/i,
  // "WhatsApp Business", "WA Business"
  /\bWhats[\s-]*App\s+Business\b/i,
  // "Click to chat", "Tap to WhatsApp", "Chat on WhatsApp"
  /\b(?:click|tap|press)\s+to\s+(?:chat|whats[\s-]*app|message)\b/i,
  /\bChat\s+(?:on|via|with)\s+Whats[\s-]*App\b/i,
  // "Send WhatsApp", "Send us a WhatsApp"
  /\bSend\s+(?:us\s+a\s+)?Whats[\s-]*App\b/i,
];

// Catalog-presence patterns — detected separately from CTA so we can light
// up the "live catalog on WA" sales beat in the copy generator.
const CATALOG_TEXT_RE = /catalog(?:ue)?/i;

// Keep a small window-search helper: returns true if `keyword` appears
// within `windowSize` characters of any "WhatsApp" / "WA" mention.
function nearWhatsApp(haystack, keyword, windowSize) {
  if (!haystack || !keyword) return false;
  const wa = /Whats[\s-]*App|wa\.me|wa\.link|api\.whatsapp\.com|chat\.whatsapp\.com|\bWA\b/gi;
  let m;
  while ((m = wa.exec(haystack)) !== null) {
    const start = Math.max(0, m.index - windowSize);
    const end = Math.min(haystack.length, m.index + m[0].length + windowSize);
    const slice = haystack.slice(start, end);
    const lower = slice.toLowerCase();
    const target = String(keyword).toLowerCase();
    if (lower.includes(target)) return true;
    if (m.index === wa.lastIndex) wa.lastIndex++;
  }
  return false;
}

function dedupe(arr) {
  return Array.from(new Set(arr.filter(Boolean)));
}

function pickCorpus(scrape) {
  // Build a single text corpus from all the fields that might mention
  // WhatsApp. Order matters only for stability of CTA snippets — we slice
  // a few hundred chars when surfacing matches. HTML goes last so visible
  // copy wins ties in CTA extraction.
  const parts = [];
  if (Array.isArray(scrape?.ctas)) parts.push(scrape.ctas.join(' \n '));
  if (Array.isArray(scrape?.headlines)) parts.push(scrape.headlines.join(' \n '));
  if (Array.isArray(scrape?.paragraphs)) parts.push(scrape.paragraphs.join(' \n '));
  if (typeof scrape?.description === 'string') parts.push(scrape.description);
  if (typeof scrape?.title === 'string') parts.push(scrape.title);
  if (typeof scrape?.rawHtml === 'string') parts.push(scrape.rawHtml);
  return parts.filter(Boolean).join('\n');
}

function extractWaLinks(corpus) {
  if (!corpus) return [];
  const urls = [];
  // wa.me/<digits>, optionally followed by /c/<id> for the catalog path
  const waMeRe = /https?:\/\/wa\.me\/[A-Za-z0-9+/?=&._%-]+/gi;
  // api.whatsapp.com/send?phone=... / api.whatsapp.com/send/?phone=...
  const apiRe = /https?:\/\/api\.whatsapp\.com\/(?:send|message)[^"'\s<>)]*/gi;
  // chat.whatsapp.com/<groupcode>
  const chatRe = /https?:\/\/chat\.whatsapp\.com\/[A-Za-z0-9]+/gi;
  // wa.link/<token>
  const waLinkRe = /https?:\/\/wa\.link\/[A-Za-z0-9]+/gi;

  for (const re of [waMeRe, apiRe, chatRe, waLinkRe]) {
    let m;
    while ((m = re.exec(corpus)) !== null) {
      const url = m[0]
        // Strip trailing punctuation that crept in from inline prose.
        .replace(/[.,;:!?)\]"'<>]+$/, '');
      urls.push(url);
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }
  return dedupe(urls).slice(0, 20);
}

function extractWaNumbers(corpus, waLinks) {
  if (!corpus) return [];
  const numbers = [];

  // 1) Phones already embedded in wa.me / api.whatsapp.com URLs
  for (const url of waLinks) {
    const m = url.match(/wa\.me\/(\+?\d[\d\s().-]{6,18})/i);
    if (m && m[1]) {
      const e164 = `+${m[1].replace(/[^\d]/g, '')}`;
      if (e164.length >= 8 && e164.length <= 17) numbers.push(e164);
      continue;
    }
    const apiM = url.match(/[?&]phone=(\+?\d[\d\s().-]{6,18})/i);
    if (apiM && apiM[1]) {
      const e164 = `+${apiM[1].replace(/[^\d]/g, '')}`;
      if (e164.length >= 8 && e164.length <= 17) numbers.push(e164);
    }
  }

  // 2) Free-text +CC numbers that sit near a "WhatsApp"/"WA" mention.
  let m;
  PHONE_E164_RE.lastIndex = 0;
  while ((m = PHONE_E164_RE.exec(corpus)) !== null) {
    const raw = m[0];
    const e164 = `+${raw.replace(/[^\d]/g, '')}`;
    if (e164.length < 8 || e164.length > 17) continue;
    if (nearWhatsApp(corpus, raw, 80)) numbers.push(e164);
    if (m.index === PHONE_E164_RE.lastIndex) PHONE_E164_RE.lastIndex++;
  }

  return dedupe(numbers).slice(0, 8);
}

function extractWaCtas(scrape, corpus) {
  const found = [];

  // Visible CTA strings the scraper already isolated win first — they are
  // short, button-shaped, and exactly what we want to surface to the user.
  if (Array.isArray(scrape?.ctas)) {
    for (const cta of scrape.ctas) {
      if (typeof cta !== 'string') continue;
      const trimmed = cta.replace(/\s+/g, ' ').trim();
      if (!trimmed) continue;
      const looksWhatsAppy =
        /whats[\s-]*app|\bWA\b|wa\.me|wa\.link/i.test(trimmed) ||
        CTA_PATTERNS.some((re) => re.test(trimmed));
      if (looksWhatsAppy && trimmed.length <= 120) found.push(trimmed);
    }
  }

  // Then sweep the corpus for the longer-tail patterns. Use the matched
  // phrase directly — windows are noisy and tend to bleed neighbouring
  // headlines into a single CTA string.
  const seen = new Set(found.map((s) => s.toLowerCase()));
  for (const pattern of CTA_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    let m;
    while ((m = re.exec(corpus)) !== null) {
      const phrase = m[0]
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (phrase && phrase.length <= 120) {
        const key = phrase.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          found.push(phrase);
        }
      }
      if (m.index === re.lastIndex) re.lastIndex++;
      if (found.length >= 12) break;
    }
    if (found.length >= 12) break;
  }

  // Finally, raw mentions of WA phone numbers count as "DM-style" CTA hints
  // when nothing more polished was found — keeps the panel populated for the
  // long tail of bare-phone landing pages.
  if (!found.length) {
    PHONE_E164_RE.lastIndex = 0;
    let m;
    while ((m = PHONE_E164_RE.exec(corpus)) !== null) {
      const raw = m[0];
      if (nearWhatsApp(corpus, raw, 50)) {
        found.push(`WhatsApp: ${raw}`.trim());
      }
      if (m.index === PHONE_E164_RE.lastIndex) PHONE_E164_RE.lastIndex++;
      if (found.length >= 4) break;
    }
  }

  return dedupe(found).slice(0, 10);
}

function detectCataloguePresence(corpus, waLinks) {
  if (waLinks.some((u) => /\/c\//i.test(u))) return true;
  if (!corpus) return false;
  // wa.me-adjacent catalog text
  const wa = /Whats[\s-]*App|wa\.me|wa\.link|api\.whatsapp\.com/gi;
  let m;
  while ((m = wa.exec(corpus)) !== null) {
    const start = Math.max(0, m.index - 80);
    const end = Math.min(corpus.length, m.index + m[0].length + 80);
    const slice = corpus.slice(start, end);
    if (CATALOG_TEXT_RE.test(slice)) return true;
    if (m.index === wa.lastIndex) wa.lastIndex++;
  }
  return false;
}

function rateConfidence({ waLinks, waCtas, waNumbers }) {
  // Three independent signal lanes — count how many lit up.
  let lit = 0;
  if (waLinks.length >= 1) lit += 1;
  if (waCtas.length >= 1) lit += 1;
  if (waNumbers.length >= 1) lit += 1;
  if (lit >= 3) return 'high';
  if (lit === 2) return 'medium';
  if (lit === 1) return 'low';
  return null;
}

function emptyResult() {
  return {
    detected: false,
    waLinks: [],
    waNumbers: [],
    waCtas: [],
    cataloguePresence: false,
    confidence: 'low',
  };
}

/**
 * @param {object} scrape  result of services/urlScraper.js scrapeUrl()
 * @returns {{
 *   detected: boolean,
 *   waLinks: string[],
 *   waNumbers: string[],
 *   waCtas: string[],
 *   cataloguePresence: boolean,
 *   confidence: 'low' | 'medium' | 'high',
 * }}
 */
function detectWhatsAppCommerce(scrape) {
  try {
    if (!scrape || typeof scrape !== 'object') return emptyResult();

    const corpus = pickCorpus(scrape);

    // Seed wa links with whatever the social-handle extractor already found
    // so we don't miss handles that sit in <script> blobs the corpus dropped
    // when we strip-tagged for snippets.
    const seedWaUrl = scrape?.socialHandles?.whatsappUrl
      || (scrape?.socialHandles?.whatsappNumber
        ? `https://wa.me/${String(scrape.socialHandles.whatsappNumber).replace(/[^\d]/g, '')}`
        : null);

    const waLinks = dedupe([
      ...(seedWaUrl ? [seedWaUrl] : []),
      ...extractWaLinks(corpus),
    ]).slice(0, 20);
    const waNumbers = extractWaNumbers(corpus, waLinks);
    const waCtas = extractWaCtas(scrape, corpus);
    const cataloguePresence = detectCataloguePresence(corpus, waLinks);

    const confidence = rateConfidence({ waLinks, waCtas, waNumbers });
    if (!confidence) return emptyResult();

    return {
      detected: true,
      waLinks,
      waNumbers,
      waCtas,
      cataloguePresence,
      confidence,
    };
  } catch (_err) {
    // Detection must never throw — bail to a clean negative.
    return emptyResult();
  }
}

module.exports = {
  detectWhatsAppCommerce,
  // Exposed for unit tests
  _internal: {
    pickCorpus,
    extractWaLinks,
    extractWaNumbers,
    extractWaCtas,
    detectCataloguePresence,
    rateConfidence,
    CTA_PATTERNS,
    PHONE_E164_RE,
  },
};
