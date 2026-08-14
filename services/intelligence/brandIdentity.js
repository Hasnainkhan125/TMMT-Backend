'use strict';

/**
 * brandIdentity — Layer 1 of the Competitor Intelligence Engine.
 *
 * Resolves a pasted URL into a multi-handle identity graph: canonical domain,
 * brand name, market/locale signals, and cross-platform social handles (FB,
 * IG, TikTok, YouTube, Twitter/X, LinkedIn). Every downstream collector
 * consumes this output — a missing FB page id in here cascades into missing
 * competitor ads, so the resolver runs a cross-verification step before it
 * returns a handle with high confidence.
 *
 * The resolver uses only public HTML — no headless browser, no paid APIs.
 * When the cheap signals disagree (e.g. footer links to /acme but og:url
 * points to /acme-middle-east), an LLM disambiguation step is run ONLY for
 * the conflicting fields, so the typical cost per resolve stays near zero.
 *
 * Design notes:
 *   - Returns a strictly shaped object so consumers don't need null guards.
 *   - Every non-null handle comes with an `evidence` trail for audit/retry.
 *   - `confidence` is a field-level number in [0,1]; the orchestrator uses
 *     these to decide whether to call cross-verification collectors.
 */

const cheerio = require('cheerio');
const { fetchHtml } = require('./httpFetch');

// Anthropic client is optional — when absent the resolver just skips the
// LLM disambiguation step and returns the signal-level confidence as-is.
function getAnthropic() {
  try {
    if (!process.env.ANTHROPIC_API_KEY) return null;
    const Anthropic = require('@anthropic-ai/sdk');
    return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  } catch (_e) {
    return null;
  }
}

// ─── Parsing helpers (HTML → structured signals) ────────────────────────────

function safeText(s) {
  if (typeof s !== 'string') return '';
  return s
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function pickMeta(html, names) {
  for (const name of names) {
    const re1 = new RegExp(
      `<meta[^>]+(?:property|name)\\s*=\\s*["']${name}["'][^>]*content\\s*=\\s*["']([^"']+)["']`,
      'i',
    );
    const m1 = html.match(re1);
    if (m1?.[1]) return safeText(m1[1]);
    const re2 = new RegExp(
      `<meta[^>]+content\\s*=\\s*["']([^"']+)["'][^>]*(?:property|name)\\s*=\\s*["']${name}["']`,
      'i',
    );
    const m2 = html.match(re2);
    if (m2?.[1]) return safeText(m2[1]);
  }
  return null;
}

// JSON-LD Organization schema: sameAs[] is the jackpot, typically a clean
// array of social profile URLs the brand has explicitly declared as theirs.
function parseJsonLdOrganizations(html) {
  const blocks = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const raw = m[1].trim();
    try {
      const json = JSON.parse(raw);
      const list = Array.isArray(json) ? json : json['@graph'] ? json['@graph'] : [json];
      for (const node of list) {
        const type = node && (node['@type'] || node.type);
        const types = Array.isArray(type) ? type : [type];
        if (types.some((t) => typeof t === 'string' && /Organization|LocalBusiness|Brand|WebSite/i.test(t))) {
          blocks.push(node);
        }
      }
    } catch {
      // JSON-LD blocks in the wild are frequently invalid — skip silently.
    }
  }
  return blocks;
}

function normalizeDomain(input) {
  if (!input) return '';
  try {
    const u = new URL(input.startsWith('http') ? input : `https://${input}`);
    return u.hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return String(input).replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0].toLowerCase();
  }
}

function rootDomain(host) {
  const parts = host.split('.').filter(Boolean);
  if (parts.length < 2) return host;
  // Naive eTLD strip — `nike.com.au` → `nike.com.au` keeps full root for compare.
  // Good enough for cross-link verification; move to `tldts` if we ever hit false positives.
  return parts.slice(-2).join('.');
}

function sharesRootDomain(a, b) {
  return rootDomain(normalizeDomain(a)) === rootDomain(normalizeDomain(b));
}

// ─── Handle extractors (one per platform, stable patterns) ──────────────────

function extractFacebookHandle(urls) {
  for (const u of urls) {
    const m = String(u).match(
      /facebook\.com\/(?!sharer|dialog|tr\.)([a-zA-Z0-9.\-_%]{2,})/i,
    );
    if (m) return { handle: decodeURIComponent(m[1]), url: `https://facebook.com/${m[1]}` };
  }
  return null;
}

function extractInstagramHandle(urls) {
  for (const u of urls) {
    const m = String(u).match(/instagram\.com\/([a-zA-Z0-9_.]{2,30})/i);
    if (m && !['p', 'reel', 'stories', 'explore'].includes(m[1].toLowerCase())) {
      return { handle: m[1], url: `https://instagram.com/${m[1]}` };
    }
  }
  return null;
}

function extractTikTokHandle(urls) {
  for (const u of urls) {
    const m = String(u).match(/tiktok\.com\/@([a-zA-Z0-9._-]{2,})/i);
    if (m) return { handle: m[1], url: `https://tiktok.com/@${m[1]}` };
  }
  return null;
}

function extractYouTubeHandle(urls) {
  for (const u of urls) {
    const m1 = String(u).match(/youtube\.com\/(?:@|channel\/|c\/|user\/)([a-zA-Z0-9._-]{2,})/i);
    if (m1) return { handle: m1[1], url: `https://youtube.com/${m1[0].split('/').pop()}` };
  }
  return null;
}

function extractTwitterHandle(urls) {
  for (const u of urls) {
    const m = String(u).match(/(?:twitter|x)\.com\/([a-zA-Z0-9_]{1,15})(?:[/?]|$)/i);
    if (m && !['intent', 'share', 'home'].includes(m[1].toLowerCase())) {
      return { handle: m[1], url: `https://x.com/${m[1]}` };
    }
  }
  return null;
}

function extractLinkedInCompany(urls) {
  for (const u of urls) {
    const m = String(u).match(/linkedin\.com\/(?:company|school)\/([a-zA-Z0-9\-_%]{2,})/i);
    if (m) return { handle: m[1], url: `https://linkedin.com/company/${m[1]}` };
  }
  return null;
}

// Facebook pixel IDs live in <script> blocks as numeric arguments to `fbq(init, …)`.
// They're weak evidence on their own but strong corroboration when we have a
// candidate FB page — each page has a known pixel mapping in the FB graph.
function extractFacebookPixelIds(html) {
  const ids = new Set();
  const re = /fbq\(\s*['"]init['"]\s*,\s*['"](\d{10,20})['"]/gi;
  let m;
  while ((m = re.exec(html))) ids.add(m[1]);
  const re2 = /connect\.facebook\.net\/en_US\/fbevents\.js[^"']*['"][^>]*?(?:id=|pixel_id=)(\d{10,20})/gi;
  while ((m = re2.exec(html))) ids.add(m[1]);
  return Array.from(ids);
}

// Gather every URL referenced on the page that *might* be a social profile.
// We cast a wide net here — extractors above are narrow enough that noise
// gets filtered out.
//
// Two passes:
//   1. Plain regex over the raw HTML — catches URLs in <script> blocks,
//      inline JSON-LD blobs, and bare text. Still required because some
//      sites print social URLs in JS handlers, not anchors.
//   2. Cheerio walk over every <a href> — catches protocol-relative URLs
//      (`//www.facebook.com/foo`) and Font Awesome icon-only links that
//      the raw regex misses because they don't start with `https?:`.
function collectCandidateUrls(html, baseUrl) {
  const urls = new Set();
  if (!html) return [];

  const re = /https?:\/\/[^"'\s<>)]+/g;
  let m;
  while ((m = re.exec(html))) urls.add(m[0]);

  try {
    const $ = cheerio.load(html);
    $('a[href]').each((_, el) => {
      const href = ($(el).attr('href') || '').trim();
      if (!href) return;
      let abs = null;
      if (/^https?:\/\//i.test(href)) {
        abs = href;
      } else if (href.startsWith('//')) {
        abs = `https:${href}`;
      } else if (baseUrl) {
        try { abs = new URL(href, baseUrl).toString(); } catch { /* ignore */ }
      }
      if (abs) urls.add(abs);
    });
  } catch (_e) {
    // cheerio bombed (malformed HTML) — fall back to the regex-only set
  }

  return Array.from(urls);
}

function inferBrandFromTitle(title) {
  if (!title) return '';
  const sliced = title.split(/[—\-|·•:]/)[0].trim();
  return sliced && sliced.length <= 50 ? sliced : '';
}

// Map og:locale / <html lang=".."> to market + language guesses. We default
// to Gulf + English because that's Qumak's positioning, but any explicit
// signal overrides the default.
function inferMarketsAndLanguages(html) {
  const languages = new Set();
  const markets = new Set();

  const htmlLang = html.match(/<html[^>]+lang\s*=\s*["']([^"']+)["']/i)?.[1];
  if (htmlLang) {
    const [lang, region] = htmlLang.split('-');
    if (lang) languages.add(lang.toLowerCase());
    if (region) markets.add(region.toUpperCase());
  }

  const ogLocale = pickMeta(html, ['og:locale']);
  if (ogLocale) {
    const [lang, region] = ogLocale.split(/[_-]/);
    if (lang) languages.add(lang.toLowerCase());
    if (region) markets.add(region.toUpperCase());
  }

  const ogAlternate = [...html.matchAll(/<meta[^>]+property=["']og:locale:alternate["'][^>]+content=["']([^"']+)["']/gi)].map((m) => m[1]);
  for (const alt of ogAlternate) {
    const [lang, region] = alt.split(/[_-]/);
    if (lang) languages.add(lang.toLowerCase());
    if (region) markets.add(region.toUpperCase());
  }

  if (!markets.size) {
    // Gulf default — tuned to Qumak's ICP. Changes safely if og/alternates surface.
    ['AE', 'SA', 'KW', 'QA', 'BH', 'OM'].forEach((c) => markets.add(c));
  }
  if (!languages.size) languages.add('en');

  return { markets: Array.from(markets), languages: Array.from(languages) };
}

// ─── Core resolver ────────────────────────────────────────────────────────────

/**
 * Build a BrandIdentity from a URL.
 *
 * @param {string} inputUrl — what the user pasted
 * @param {object} opts
 *   html          — precomputed HTML (skip the fetch, reuse from another scan)
 *   fetchVerify   — set false to skip cross-verification HTTP calls (test mode)
 *   llmDisambiguate — set false to skip Claude calls (test mode / offline)
 *
 * @returns {Promise<BrandIdentity>}
 */
async function resolveBrandIdentity(inputUrl, opts = {}) {
  if (!inputUrl) {
    throw Object.assign(new Error('inputUrl required'), { code: 'invalid_input' });
  }

  const canonicalDomain = normalizeDomain(inputUrl);
  let html = opts.html;
  let finalUrl = inputUrl;
  if (!html) {
    const fetched = await fetchHtml(
      inputUrl.startsWith('http') ? inputUrl : `https://${inputUrl}`,
      { maxAttempts: 3 },
    ).catch((err) => {
      // Don't kill the whole resolver on a single failed fetch — return a
      // minimal identity with just the domain so the orchestrator can still
      // try other collectors (e.g. SERP scrape on the brand name).
      return { html: '', status: 0, finalUrl: inputUrl, _fetchError: err.message };
    });
    html = fetched.html || '';
    finalUrl = fetched.finalUrl || inputUrl;
  }

  // ── Step A: cheap explicit signals ──────────────────────────────────────
  const ogSiteName = pickMeta(html, ['og:site_name', 'application-name']);
  const ogUrl = pickMeta(html, ['og:url']);
  const ogImage = pickMeta(html, ['og:image']);
  const title = safeText((html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '');
  const appleTouchIcon = html.match(/<link[^>]+rel=["']apple-touch-icon[^"']*["'][^>]+href=["']([^"']+)["']/i)?.[1] || null;

  const twitterSite = pickMeta(html, ['twitter:site']);
  const fbAppId = pickMeta(html, ['fb:app_id']);
  const fbPageIdMeta = pickMeta(html, ['fb:page_id', 'fb:pages']);

  const jsonLdOrgs = parseJsonLdOrganizations(html);
  const primaryOrg = jsonLdOrgs[0] || {};
  const sameAs = [
    ...jsonLdOrgs.flatMap((o) => (Array.isArray(o.sameAs) ? o.sameAs : o.sameAs ? [o.sameAs] : [])),
  ];
  let candidateUrls = [...collectCandidateUrls(html, finalUrl), ...sameAs, ogUrl, twitterSite ? `https://x.com/${twitterSite.replace(/^@/, '')}` : null]
    .filter(Boolean);

  // ── Homepage fallback ──────────────────────────────────────────────────
  // When the user pastes a deep link (e.g. /product/foo) the social icons
  // typically only render on the homepage header/footer. ALSO retry the
  // homepage when the deep page yielded no Facebook/Instagram signal at
  // all — some platforms (Wix, Webflow) lazy-render social icons via JS
  // on the deep page but server-render them on the home route.
  let homepageScanned = false;
  if (opts.skipHomepageFallback !== true) {
    let parsedInput = null;
    try {
      parsedInput = new URL(inputUrl.startsWith('http') ? inputUrl : `https://${inputUrl}`);
    } catch (_e) { /* malformed input — skip the fallback */ }

    if (parsedInput) {
      const isDeepLink = parsedInput.pathname && parsedInput.pathname !== '/' && parsedInput.pathname.length > 1;
      const probeFb = extractFacebookHandle(candidateUrls);
      const probeIg = extractInstagramHandle(candidateUrls);
      const missingPrimary = !probeFb && !probeIg;

      if (isDeepLink || missingPrimary) {
        const homepageUrl = `${parsedInput.protocol}//${parsedInput.host}/`;
        // Skip if the page we already fetched IS the homepage (avoid
        // double-fetching www.brand.com → www.brand.com/).
        const alreadyHomepage = (() => {
          try {
            const fp = new URL(finalUrl);
            return fp.host === parsedInput.host && (fp.pathname === '/' || fp.pathname === '');
          } catch { return false; }
        })();

        if (!alreadyHomepage) {
          const fetched = await fetchHtml(homepageUrl, { maxAttempts: 1, timeoutMs: 8000 }).catch(() => null);
          if (fetched && fetched.html) {
            homepageScanned = true;
            candidateUrls = candidateUrls.concat(
              collectCandidateUrls(fetched.html, homepageUrl)
            );
            // If the deep page had no JSON-LD Organization but the homepage
            // does, harvest its sameAs[] too — that's where the cleanest
            // social URLs typically live.
            if (jsonLdOrgs.length === 0) {
              const homeOrgs = parseJsonLdOrganizations(fetched.html);
              for (const o of homeOrgs) {
                jsonLdOrgs.push(o);
                const sa = Array.isArray(o.sameAs) ? o.sameAs : o.sameAs ? [o.sameAs] : [];
                for (const s of sa) {
                  if (s) {
                    sameAs.push(s);
                    candidateUrls.push(s);
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  const evidence = [];
  function addEvidence(field, value, source, confidence) {
    evidence.push({ field, value, source, confidence });
  }

  // Brand name — prefer Organization.name, then og:site_name, then title heuristic.
  let brandName =
    (typeof primaryOrg.name === 'string' ? primaryOrg.name.trim() : '') ||
    ogSiteName ||
    inferBrandFromTitle(title) ||
    canonicalDomain.split('.')[0];
  let brandNameConfidence = 0.6;
  if (primaryOrg.name) {
    addEvidence('brandName', primaryOrg.name, 'schema_org', 0.95);
    brandNameConfidence = 0.95;
  } else if (ogSiteName) {
    addEvidence('brandName', ogSiteName, 'meta_tags', 0.9);
    brandNameConfidence = 0.9;
  } else if (title) {
    addEvidence('brandName', brandName, 'text_match', 0.6);
  }

  // Handle extraction — run every platform extractor against the union of
  // JSON-LD sameAs + any http(s) URL seen on the page.
  const fb = extractFacebookHandle(candidateUrls);
  const ig = extractInstagramHandle(candidateUrls);
  const tiktok = extractTikTokHandle(candidateUrls);
  const youtube = extractYouTubeHandle(candidateUrls);
  const twitter = extractTwitterHandle(candidateUrls);
  const linkedin = extractLinkedInCompany(candidateUrls);

  const pixelIds = extractFacebookPixelIds(html);

  const handles = {
    facebookPageId: fbPageIdMeta || null,
    facebookPageUrl: fb?.url || null,
    facebookHandle: fb?.handle || null,
    instagramHandle: ig?.handle || null,
    instagramUrl: ig?.url || null,
    tiktokHandle: tiktok?.handle || null,
    tiktokUrl: tiktok?.url || null,
    youtubeChannel: youtube?.handle || null,
    youtubeUrl: youtube?.url || null,
    twitterHandle: twitter?.handle || null,
    twitterUrl: twitter?.url || null,
    linkedinCompany: linkedin?.handle || null,
    linkedinUrl: linkedin?.url || null,
    facebookPixelIds: pixelIds,
  };

  const fieldConfidence = {
    brandName: brandNameConfidence,
    facebookPage: fb ? (sameAs.some((s) => String(s).toLowerCase().includes('facebook.com')) ? 0.85 : 0.65) : 0,
    instagramHandle: ig ? (sameAs.some((s) => String(s).toLowerCase().includes('instagram.com')) ? 0.9 : 0.7) : 0,
    tiktokHandle: tiktok ? 0.8 : 0,
    youtubeChannel: youtube ? 0.8 : 0,
    twitterHandle: twitter ? 0.75 : 0,
    linkedinCompany: linkedin ? 0.8 : 0,
  };

  if (homepageScanned) {
    addEvidence('handles.source.homepage_fallback', 'true', 'homepage_fetch', 0.9);
  }
  if (fb) addEvidence('facebookPageUrl', fb.url, sameAs.some((s) => s.includes('facebook.com')) ? 'schema_org' : 'social_link', fieldConfidence.facebookPage);
  if (ig) addEvidence('instagramHandle', ig.handle, sameAs.some((s) => s.includes('instagram.com')) ? 'schema_org' : 'social_link', fieldConfidence.instagramHandle);
  if (tiktok) addEvidence('tiktokHandle', tiktok.handle, 'social_link', fieldConfidence.tiktokHandle);
  if (youtube) addEvidence('youtubeChannel', youtube.handle, 'social_link', fieldConfidence.youtubeChannel);
  if (twitter) addEvidence('twitterHandle', twitter.handle, 'social_link', fieldConfidence.twitterHandle);
  if (linkedin) addEvidence('linkedinCompany', linkedin.handle, 'social_link', fieldConfidence.linkedinCompany);

  // Market/locale signals — defaults tuned for Gulf audiences.
  const { markets, languages } = inferMarketsAndLanguages(html);

  // ── Step B: cross-verify FB page points back at our domain ──────────────
  // Skippable for test runs / offline mode. The verification fetch can fail
  // silently — a non-verified handle still ships in the identity, just with
  // a slightly lower confidence score that the scoring layer uses.
  let verifications = {};
  if (opts.fetchVerify !== false && handles.facebookPageUrl) {
    verifications.facebookPage = await verifyFacebookPage(handles.facebookPageUrl, canonicalDomain).catch(() => null);
    if (verifications.facebookPage?.confidence != null) {
      fieldConfidence.facebookPage = verifications.facebookPage.confidence;
      addEvidence('facebookPageUrl', handles.facebookPageUrl, 'cross_verify', verifications.facebookPage.confidence);
    }
  }
  if (opts.fetchVerify !== false && handles.instagramHandle) {
    verifications.instagram = await verifyInstagramHandle(handles.instagramHandle, canonicalDomain, brandName).catch(() => null);
    if (verifications.instagram?.confidence != null) {
      fieldConfidence.instagramHandle = Math.max(fieldConfidence.instagramHandle, verifications.instagram.confidence);
    }
  }

  // ── Step C: LLM disambiguation (only when signals conflict) ─────────────
  // Heuristic: run the LLM if any handle sits in the "medium" band (0.5–0.75).
  // Below 0.5 is noise we throw away; above 0.75 is trusted. Saves 80%+ of
  // Claude calls in practice.
  const conflictedFields = Object.entries(fieldConfidence).filter(
    ([, conf]) => conf >= 0.5 && conf < 0.75,
  );
  if (opts.llmDisambiguate !== false && conflictedFields.length && getAnthropic()) {
    const llm = await disambiguateWithLLM({
      canonicalDomain,
      brandName,
      handles,
      evidence,
      conflictedFields: conflictedFields.map(([f]) => f),
    }).catch(() => null);
    if (llm && typeof llm === 'object') {
      for (const [field, result] of Object.entries(llm)) {
        if (result && typeof result.confidence === 'number') {
          fieldConfidence[field] = Math.max(0, Math.min(1, result.confidence));
          addEvidence(field, handles[field] ?? '', 'llm_disambiguation', result.confidence);
        }
      }
    }
  }

  const nextRefreshAt = new Date(Date.now() + 7 * 24 * 3600 * 1000);

  const identity = {
    inputUrl,
    canonicalDomain,
    finalUrl,
    brandName: safeText(brandName),
    aliases: uniqueNames([brandName, ogSiteName, primaryOrg.name, inferBrandFromTitle(title)]).slice(0, 6),
    markets,
    languages,
    handles,
    knownLandingDomains: Array.from(new Set([canonicalDomain, normalizeDomain(finalUrl)])).filter(Boolean),
    redirectMap: {},
    confidence: fieldConfidence,
    evidence,
    logo: {
      favicon: appleTouchIcon || `https://${canonicalDomain}/favicon.ico`,
      ogImage: ogImage || null,
      organizationLogo:
        (typeof primaryOrg.logo === 'string' ? primaryOrg.logo : primaryOrg.logo?.url) || null,
    },
    meta: {
      ogUrl,
      ogSiteName,
      fbAppId,
      twitterSite,
      jsonLdOrgCount: jsonLdOrgs.length,
      sameAsCount: sameAs.length,
    },
    resolvedAt: new Date(),
    nextRefreshAt,
  };
  return identity;
}

// ─── Cross-verification collectors ────────────────────────────────────────────

async function verifyFacebookPage(pageUrl, canonicalDomain) {
  try {
    const { html } = await fetchHtml(pageUrl, { maxAttempts: 2, timeoutMs: 8000 });
    // FB now renders the public "About" section into a JSON blob embedded in
    // <script>. Cheapest reliable signal: look for any link on the page that
    // shares the canonical domain. If present → almost certainly our brand.
    const hasDomainLink = new RegExp(
      canonicalDomain.replace(/\./g, '\\.'),
      'i',
    ).test(html);
    if (hasDomainLink) return { confidence: 0.95, reason: 'domain_link_present' };
    // Degenerate case: page is rendered client-side. Keep medium confidence
    // since the handle came from schema_org/social_link to begin with.
    return { confidence: 0.6, reason: 'no_domain_link_in_html' };
  } catch (err) {
    if (err.code === 'blocked') return { confidence: 0.6, reason: 'fb_blocked_verify' };
    return { confidence: 0.5, reason: err.code || 'verify_failed' };
  }
}

async function verifyInstagramHandle(handle, canonicalDomain, brandName) {
  try {
    const { html } = await fetchHtml(`https://www.instagram.com/${handle}/`, {
      maxAttempts: 2,
      timeoutMs: 8000,
    });
    const bio = pickMeta(html, ['og:description']);
    const domainMatch = new RegExp(canonicalDomain.replace(/\./g, '\\.'), 'i').test(html);
    const nameMatch = brandName && new RegExp(brandName.replace(/[^a-z0-9]/gi, '.?'), 'i').test(html);
    if (domainMatch) return { confidence: 0.95, reason: 'domain_in_bio', bio };
    if (nameMatch) return { confidence: 0.85, reason: 'brand_name_match', bio };
    return { confidence: 0.65, reason: 'weak_signal', bio };
  } catch (err) {
    if (err.code === 'blocked') return { confidence: 0.65, reason: 'ig_blocked_verify' };
    return { confidence: 0.55, reason: err.code || 'verify_failed' };
  }
}

// ─── LLM disambiguation ──────────────────────────────────────────────────────

async function disambiguateWithLLM({ canonicalDomain, brandName, handles, evidence, conflictedFields }) {
  const client = getAnthropic();
  if (!client) return null;

  const prompt = `You are verifying social-handle mappings for a brand.

Canonical domain: ${canonicalDomain}
Brand name: ${brandName}

Current handle candidates:
${Object.entries(handles)
  .filter(([, v]) => typeof v === 'string' && v)
  .map(([k, v]) => `- ${k}: ${v}`)
  .join('\n')}

Evidence trail:
${evidence.slice(-10).map((e) => `- ${e.field} = "${e.value}" via ${e.source} (${(e.confidence * 100).toFixed(0)}%)`).join('\n')}

For each of these fields, return whether the candidate handle is the real handle for this brand:
${conflictedFields.join(', ')}

Reply ONLY with valid JSON matching this shape:
{${conflictedFields
  .map(
    (f) =>
      `"${f}": { "match": true, "confidence": 0.0, "reasoning": "" }`,
  )
  .join(',')}}

No prose, no markdown, start with { end with }.
`;

  const model = process.env.ANTHROPIC_MODEL_LITE || 'claude-haiku-4-5-20251001';
  const resp = await client.messages.create({
    model,
    max_tokens: 800,
    messages: [{ role: 'user', content: prompt }],
  });
  const text = resp.content?.[0]?.text || '';
  const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

// ─── Small utilities exposed for tests ──────────────────────────────────────

function uniqueNames(arr) {
  const seen = new Set();
  const out = [];
  for (const raw of arr) {
    if (!raw) continue;
    const key = safeText(raw).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(safeText(raw));
  }
  return out;
}

module.exports = {
  resolveBrandIdentity,
  verifyFacebookPage,
  verifyInstagramHandle,
  // Exported for unit tests & downstream collectors:
  _internals: {
    normalizeDomain,
    rootDomain,
    sharesRootDomain,
    parseJsonLdOrganizations,
    extractFacebookHandle,
    extractInstagramHandle,
    extractTikTokHandle,
    extractYouTubeHandle,
    extractTwitterHandle,
    extractLinkedInCompany,
    extractFacebookPixelIds,
    inferMarketsAndLanguages,
    pickMeta,
    safeText,
    collectCandidateUrls,
  },
};
