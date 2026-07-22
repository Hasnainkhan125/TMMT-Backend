'use strict';

/**
 * brandNameGuard — picks the right brand name for a domain.
 *
 * Bug we're killing:
 *   Zigwheels.ae has Tesla product pages. Schema.org Product → brand → "Tesla"
 *   used to leak into pickBrandName(). Title parsing also broke because car
 *   aggregator titles put the marketplace brand on the RIGHT of the separator
 *   ("Tesla — Zigwheels"), and cleanupTitle stripped everything after the dash.
 *
 * Strategy:
 *   Every candidate brand string gets scored against the canonical domain
 *   root token. Candidates that don't echo the domain (substring or fuzzy
 *   match) get heavily penalized — those are almost always Product.brand
 *   pollution or aggregator chrome leaking into og:title.
 *
 *   When multiple Organization/LocalBusiness/Corporation nodes exist in
 *   schema.org JSON-LD, we walk all of them and prefer the one whose name
 *   echoes the domain. First-match-wins (the old behavior) is wrong on
 *   aggregator pages.
 */

const STRIP_LEGAL_RE = /\s+(?:Inc\.?|LLC\.?|Ltd\.?|Limited|GmbH|S\.A\.?|S\.A\.S\.|Pvt\.?\s*Ltd\.?|Co\.|Corp\.?|Corporation|Pte\.?\s+Ltd\.?|FZ-?LLC|FZE)\.?\b/gi;
const STRIP_TM_RE = /[®™©]/g;

function cleanCandidate(name) {
  if (!name || typeof name !== 'string') return '';
  return name
    .replace(STRIP_TM_RE, '')
    .replace(STRIP_LEGAL_RE, '')
    .replace(/^["'`\u201C\u201D\u2018\u2019]+|["'`\u201C\u201D\u2018\u2019]+$/g, '')
    .replace(/[.,;:\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function domainToken(canonical) {
  if (!canonical || typeof canonical !== 'string') return '';
  // canonical looks like "zigwheels.ae" or "shop.tesla.com"
  // we want the most-specific subdomain root: "zigwheels", "tesla"
  const parts = canonical.toLowerCase().split('.').filter(Boolean);
  if (parts.length < 2) return parts[0] || '';
  // For "shop.tesla.com" → use "tesla" (skip generic subdomains)
  const SKIP = new Set(['www', 'shop', 'store', 'app', 'm', 'mobile', 'en', 'ar', 'go']);
  let i = 0;
  while (i < parts.length - 1 && SKIP.has(parts[i])) i++;
  // parts[i] is the root brand token; parts[parts.length - 1] is TLD
  // For "zigwheels.ae", i=0, parts[0]="zigwheels" → return "zigwheels".
  return parts[i].replace(/[^a-z0-9]/g, '');
}

function normalize(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Cheap Levenshtein for short strings — bounded by min(a,b)+1 work.
function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const m = a.length, n = b.length;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/**
 * brandMatchesDomain — does this candidate brand name plausibly belong to
 * the given domain? Returns { matches: bool, score: 0..1, reason: string }.
 *
 * Strict bias: substring (either direction) is a strong yes. Edit-distance
 * within 1 char per 4 of token length catches typos / pluralization.
 */
function brandMatchesDomain(brandName, canonical) {
  const token = domainToken(canonical);
  const norm = normalize(brandName);
  if (!token || !norm) return { matches: false, score: 0, reason: 'empty' };

  if (norm.includes(token) || token.includes(norm)) {
    return { matches: true, score: 1, reason: 'substring' };
  }

  // First word of the brand vs domain token (handles "Hot Shay" vs "hotshay")
  const firstWord = (brandName || '').toLowerCase().split(/\s+/)[0]?.replace(/[^a-z0-9]/g, '') || '';
  if (firstWord && (firstWord.includes(token) || token.includes(firstWord))) {
    return { matches: true, score: 0.9, reason: 'first_word_substring' };
  }

  // Fuzzy match — short tokens get tighter tolerance to avoid false positives
  const tolerance = Math.max(1, Math.floor(token.length / 4));
  const trimmedNorm = norm.slice(0, Math.max(token.length, 4) + 2);
  const dist = editDistance(trimmedNorm, token);
  if (dist <= tolerance) {
    return { matches: true, score: 0.75, reason: `fuzzy(d=${dist})` };
  }

  return { matches: false, score: 0, reason: 'no_match' };
}

/**
 * pickBestOrganizationNode — when schema.org JSON-LD has multiple Organization
 * (or LocalBusiness, Corporation) nodes — pick the one whose name matches the
 * domain. Falls back to the first node if nothing matches.
 *
 * @param {object} schemaOrg — extractMetaSignals().schemaOrg
 * @param {string} canonical — canonicalDomain like "zigwheels.ae"
 */
function pickBestOrganizationNode(schemaOrg, canonical) {
  if (!schemaOrg) return { node: null, type: null };
  const buckets = [
    { type: 'Organization',  list: schemaOrg.byType?.Organization },
    { type: 'LocalBusiness', list: schemaOrg.byType?.LocalBusiness },
    { type: 'Corporation',   list: schemaOrg.byType?.Corporation },
    { type: 'Restaurant',    list: schemaOrg.byType?.Restaurant },
    { type: 'Store',         list: schemaOrg.byType?.Store },
    { type: 'MedicalClinic', list: schemaOrg.byType?.MedicalClinic },
  ];

  let best = null;
  let bestScore = -1;
  let bestType = null;
  for (const { type, list } of buckets) {
    if (!Array.isArray(list)) continue;
    for (const node of list) {
      const name = cleanCandidate(node?.name);
      if (!name) continue;
      const { score } = brandMatchesDomain(name, canonical);
      if (score > bestScore) {
        bestScore = score;
        best = node;
        bestType = type;
      }
    }
  }

  if (best) return { node: best, type: bestType, matchScore: bestScore };

  // No domain match — fall back to first available
  for (const { type, list } of buckets) {
    if (Array.isArray(list) && list[0]?.name) {
      return { node: list[0], type, matchScore: 0 };
    }
  }
  return { node: null, type: null, matchScore: 0 };
}

function capitalize(token) {
  if (!token) return '';
  return token[0].toUpperCase() + token.slice(1);
}

module.exports = {
  cleanCandidate,
  domainToken,
  brandMatchesDomain,
  pickBestOrganizationNode,
  capitalize,
  // exposed for tests
  _editDistance: editDistance,
  _normalize: normalize,
};
