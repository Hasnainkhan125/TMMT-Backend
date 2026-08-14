// services/resolver/brandIdentityResolver.js
const BrandIdentity = require('../../model/schema/brandIdentity');
const { fetchAndRender } = require('./steps/fetchAndRender');
const { extractMetaSignals } = require('./steps/extractMetaSignals');
const { extractSocialHandles, extractSocialHandlesFromUrl } = require('./steps/extractSocialHandles');
const { extractTrackingIds, normalizeTrackingIds, deriveAdSignals } = require('./steps/extractTrackingIds');
const { extractTechStack } = require('./steps/extractTechStack');
const { extractBrandAssets } = require('./steps/extractBrandAssets');
const { extractColorPalette } = require('./steps/extractColorPalette');
const { extractFonts } = require('./steps/extractFonts');
const { enrichWithTraffic } = require('./steps/enrichWithTraffic');
const { verifyFacebookPage } = require('./verifiers/verifyFacebookPage');
const { verifyInstagramHandle } = require('./verifiers/verifyInstagramHandle');
const { disambiguateSocialHandle, classifyBusinessType } = require('./disambiguator/llmDisambiguator');
const { normalizeDomain, rootDomain, ensureHttps } = require('./utils/normalizeDomain');
const {
  cleanCandidate,
  domainToken,
  brandMatchesDomain,
  pickBestOrganizationNode,
  capitalize,
} = require('./utils/brandNameGuard');
const logger = require('../../utils/logger');

const ENRICHMENT_VERSION = 3;

/**
 * The top-level resolver. Takes a URL in, returns a fully-populated BrandIdentity.
 * 
 * Strategy:
 *   Step A — Fetch + parse (fast, synchronous)
 *   Step B — Extract all signals in parallel
 *   Step C — Verify handles (network calls in parallel)
 *   Step D — Disambiguate with LLM when needed
 *   Step E — Persist + return
 */
async function resolveBrandIdentity(inputUrl, opts = {}) {
  const url = ensureHttps(inputUrl);
  const canonical = rootDomain(url);
  if (!canonical) {
    throw Object.assign(new Error('invalid_domain'), { code: 'INVALID_DOMAIN' });
  }
  
  // ── Dedup: has this brand been resolved recently? ──────────
  const existing = await BrandIdentity.findOne({ canonicalDomain: canonical });
  if (existing && !opts.forceRefresh) {
    const age = Date.now() - (existing.resolvedAt?.getTime() || 0);
    const isFresh = age < 7 * 24 * 60 * 60 * 1000;
    if (isFresh && existing.status === 'complete' && existing.enrichmentVersion === ENRICHMENT_VERSION) {
      logger.info({ canonical }, 'Returning cached brand identity');
      existing.scanCount = (existing.scanCount || 1) + 1;
      await existing.save();
      return existing;
    }
  }
  
  // ── Initialize or update record ─────────────────────────────
  const brand = existing || new BrandIdentity({
    inputUrl: url,
    canonicalDomain: canonical,
    status: 'resolving',
  });
  brand.status = 'resolving';
  brand.inputUrl = url;
  brand.evidence = [];
  brand.errors = [];
  await brand.save();
  
  try {
    // ══════════════════════════════════════════════════════════
    // STEP A — Fetch + render
    // ══════════════════════════════════════════════════════════
    const fetchResult = await fetchAndRender(url, { 
      needsScreenshot: opts.capturaScreenshot !== false,
      timeout: 25_000,
    });
    
    const { html, renderedHtml, finalUrl, headers, networkRequests, screenshots } = fetchResult;
    
    // Track resolution time for SLO monitoring
    const renderMs = fetchResult.responseTimeMs;
    logger.info({ canonical, renderMs, method: fetchResult.method }, 'Fetched page');
    


    // ══════════════════════════════════════════════════════════
    // STEP B — Parallel extraction of all signals
    // ══════════════════════════════════════════════════════════
    const [
      metaSignals,
      trackingRaw,
      techStack,
      fonts,
      traffic,
    ] = await Promise.all([
      Promise.resolve(extractMetaSignals(html)),
      Promise.resolve(extractTrackingIds(html, networkRequests, renderedHtml)),
      Promise.resolve(extractTechStack(html, headers, renderedHtml)),
      Promise.resolve(extractFonts(renderedHtml || html)),
      enrichWithTraffic(canonical),
    ]);
    
    // Social handles need metaSignals.
    // We use the async variant so that when the user pasted a deep link
    // (e.g. /menu, /shop/abc-product) and the page didn't surface their
    // canonical FB/IG icons, we transparently fetch the homepage and
    // re-extract there. This is what makes deep-link scans surface the
    // same handles a homepage scan would. Failures are silent — the
    // sync result still gets used.
    const socialResult = await extractSocialHandlesFromUrl({
      url: finalUrl || url,
      html,
      schemaOrg: metaSignals.schemaOrg,
    }).catch((err) => {
      logger.warn({ err: err && err.message }, 'extractSocialHandlesFromUrl failed; falling back to sync');
      return null;
    });
    const socialRaw = socialResult || extractSocialHandles(html, metaSignals.schemaOrg);
    if (socialResult?._meta?.sources?.homepage) {
      brand.evidence.push({
        field: 'handles.source.homepage_fallback',
        value: 'true',
        source: 'homepage_fetch',
        confidence: 0.9,
      });
    }
    
    // Brand assets need metaSignals (for favicon/apple-touch-icon candidates)
    const brandAssets = await extractBrandAssets(html, finalUrl, metaSignals, screenshots);
    
    // Colors need brandAssets for Vibrant extraction
    const colorPalette = await extractColorPalette(html, brandAssets, metaSignals, brand.businessType);
    
    // Merge into brand
    brand.handles = mergeSocialHandles(brand.handles || {}, socialRaw);
    brand.trackingIds = normalizeTrackingIds(trackingRaw);


    if (brand.trackingIds.googleTagManager?.length > 0 
      && brand.trackingIds.googleAnalytics?.length === 0) {
    const { expandGtmContainer } = require('./steps/expandGtmContainer');
    
    for (const gtmId of brand.trackingIds.googleTagManager.slice(0, 2)) {
      const expanded = await expandGtmContainer(gtmId);
      
      // Merge any discovered IDs into our trackingIds
      if (expanded.ids.googleAnalytics4) {
        brand.trackingIds.googleAnalytics = [
          ...new Set([...brand.trackingIds.googleAnalytics, ...expanded.ids.googleAnalytics4])
        ];
      }
      if (expanded.ids.facebookPixel) {
        brand.trackingIds.facebookPixel = [
          ...new Set([...brand.trackingIds.facebookPixel, ...expanded.ids.facebookPixel])
        ];
      }
      if (expanded.ids.tiktokPixel) {
        brand.trackingIds.tiktokPixel = [
          ...new Set([...brand.trackingIds.tiktokPixel, ...expanded.ids.tiktokPixel])
        ];
      }
      if (expanded.ids.googleAdsConversion) {
        brand.trackingIds.googleAdsConversion = [
          ...new Set([...brand.trackingIds.googleAdsConversion, ...expanded.ids.googleAdsConversion])
        ];
      }
      
      brand.evidence.push({
        field: 'trackingIds.expanded_from_gtm',
        value: gtmId,
        source: 'third_party_api',
        confidence: 0.9,
      });
    }
    
    // Re-derive ad signals with expanded data
    brand.adSignals = deriveAdSignals(brand.trackingIds, networkRequests);
  }


    brand.adSignals = deriveAdSignals(brand.trackingIds, networkRequests);
    brand.techStack = techStack;
    brand.assets = {
      favicon: brandAssets.favicon,
      faviconHash: brandAssets.faviconHash,
      logo: brandAssets.logo,
      logoHash: brandAssets.logoHash,
      logoIsLightBg: brandAssets.logoIsLightBg,
      ogImage: brandAssets.ogImage,
      heroImages: brandAssets.heroImages,
      brandColors: colorPalette,
      fonts,
      // screenshots will be uploaded to S3 in a post-step
    };
    brand.trafficSignals = traffic;
    
    // Extract canonical brand name from multiple sources, guarded by domain.
    // The guard prevents Product.brand pollution (Tesla on Zigwheels) and
    // aggregator-title leakage from hijacking the brand identity.
    const picked = pickBrandName(metaSignals, canonical);
    brand.brandName = picked.name;
    brand.confidence = brand.confidence || {};
    brand.confidence.brandName = picked.confidence;
    if (!picked.matchesDomain && picked.source !== 'fallback.domain') {
      brand.evidence.push({
        field: 'brand.name.domain_mismatch',
        value: `Picked '${picked.name}' from ${picked.source} but no candidate matched domain token '${domainToken(canonical)}'`,
        source: 'domain_guard',
        confidence: picked.confidence,
      });
    }
    brand.tagline = metaSignals.og?.description?.slice(0, 200);
    brand.description = metaSignals.seo?.description || metaSignals.og?.description;
    brand.content = {
      title:      metaSignals.seo?.title,
      metaDesc:   metaSignals.seo?.description,
      headlines:  extractPageHeadlines(html),
      keywords:   metaSignals.seo?.keywords || [],
      languages:  [metaSignals.lang?.html].filter(Boolean),
    };
    
    // Markets + languages (heuristic from lang, tld, og:locale)
    brand.markets = inferMarkets(canonical, metaSignals);
    brand.languages = inferLanguages(metaSignals);
    
    // Contact info from schema.org
    brand.phone = metaSignals.schemaOrg?.organization?.telephone
               || metaSignals.schemaOrg?.localBusiness?.telephone;
    brand.email = metaSignals.schemaOrg?.organization?.email;
    brand.address = formatAddress(
      metaSignals.schemaOrg?.organization?.address 
      || metaSignals.schemaOrg?.localBusiness?.address
    );
    brand.legalName = metaSignals.schemaOrg?.organization?.legalName;
    
    brand.evidence.push({
      field: 'brand.name',
      value: brand.brandName,
      source: picked.source,
      confidence: picked.confidence,
    });
    
    // ══════════════════════════════════════════════════════════
    // STEP C — Cross-verify social handles (parallel)
    // ══════════════════════════════════════════════════════════
    const verifications = await Promise.allSettled([
      // Verify each FB URL candidate
      ...(socialRaw.facebook.urls.slice(0, 2).map(async (url) => ({
        type: 'facebook',
        url,
        result: await verifyFacebookPage(url, canonical),
      }))),
      // Verify each IG handle candidate
      ...(socialRaw.instagram.handles.slice(0, 2).map(async (handle) => ({
        type: 'instagram',
        handle,
        result: await verifyInstagramHandle(handle, canonical),
      }))),
    ]);
    
    // Process FB verifications
    const fbVerifications = verifications
      .filter(v => v.status === 'fulfilled' && v.value.type === 'facebook')
      .map(v => v.value);
    
    const bestFb = fbVerifications.sort((a, b) => b.result.confidence - a.result.confidence)[0];
    
    if (bestFb?.result.confidence > 0.5) {
      brand.handles.facebookPageUrl = bestFb.url;
      brand.handles.facebookPageName = bestFb.result.data?.pageTitle;
      brand.confidence.facebookPage = bestFb.result.confidence;
      brand.evidence.push({
        field: 'handles.facebookPage',
        value: bestFb.url,
        source: 'cross_verification',
        confidence: bestFb.result.confidence,
      });
    } else if (fbVerifications.length > 1) {
      // Multiple candidates, none confident — LLM disambiguate
      const disambig = await disambiguateSocialHandle({
        platform: 'facebook',
        candidates: fbVerifications.map(v => ({
          handle: v.url,
          url: v.url,
          evidence: v.result.evidence,
          confidence: v.result.confidence,
        })),
        brand: { name: brand.brandName, description: brand.description, canonicalDomain: canonical },
      });
      
      if (disambig.match && disambig.confidence > 0.5) {
        brand.handles.facebookPageUrl = disambig.match.url;
        brand.confidence.facebookPage = disambig.confidence;
        brand.evidence.push({
          field: 'handles.facebookPage',
          value: disambig.match.url,
          source: 'llm_inference',
          confidence: disambig.confidence,
        });
      }
    }
    
    // Process IG verifications similarly
    const igVerifications = verifications
      .filter(v => v.status === 'fulfilled' && v.value.type === 'instagram')
      .map(v => v.value);
    
    const bestIg = igVerifications.sort((a, b) => b.result.confidence - a.result.confidence)[0];
    
    if (bestIg?.result.confidence > 0.5) {
      brand.handles.instagramHandle = bestIg.handle;
      brand.handles.instagramFollowers = bestIg.result.data?.followers;
      brand.confidence.instagramHandle = bestIg.result.confidence;
    }
    // After the bestIg block
    if (!brand?.confidence?.instagramHandle && brand?.handles?.instagramHandle) {
        brand.confidence.instagramHandle = 0.4; 
        // brand.evidence.push({
        //   field: 'handles.instagramHandle',
        //   value: brand.handles.instagramHandle,
        //   source: 'cross_verification',
        //   confidence: 0.4,
        // });
    }
    
    // ══════════════════════════════════════════════════════════
    // STEP D — Business type classification (LLM)
    // ══════════════════════════════════════════════════════════
    const typeClassification = await classifyBusinessType({
      brandName: brand.brandName,
      description: brand.description,
      headlines: brand.content.headlines,
      title: brand.content.title,
      metaDescription: brand.content.metaDesc,
    });
    
    brand.businessType = typeClassification.businessType;
    brand.subtype = typeClassification.subtype;
    brand.confidence.businessType = typeClassification.confidence;
    brand.evidence.push({
      field: 'businessType',
      value: typeClassification.businessType,
      source: 'llm_inference',
      confidence: typeClassification.confidence,
    });
    
    // ══════════════════════════════════════════════════════════
    // STEP E — Compute overall confidence + persist
    // ══════════════════════════════════════════════════════════
    brand.confidence.overall = computeOverallConfidence(brand);
    brand.resolvedAt = new Date();
    brand.lastEnrichedAt = new Date();
    brand.nextEnrichAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    brand.enrichmentVersion = ENRICHMENT_VERSION;
    brand.status = 'complete';
    brand.scanCount = (brand.scanCount || 0) + 1;
    
    await brand.save();
    
    logger.info({ 
      canonical, 
      overall: brand.confidence.overall,
      hasFb: !!brand.handles.facebookPageUrl,
      hasIg: !!brand.handles.instagramHandle,
      businessType: brand.businessType,
    }, 'Brand identity resolved');
    
    return brand;
    
  } catch (err) {
    logger.error({ err, canonical }, 'Brand resolution failed');
    brand.status = 'failed';
    brand.errors.push({
      step: 'resolveBrandIdentity',
      code: err.code || 'UNKNOWN',
      message: err.message,
      at: new Date(),
    });
    await brand.save();
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════
// Helper functions
// ═══════════════════════════════════════════════════════════════

function mergeSocialHandles(existing, socialRaw) {
  const merged = { ...existing };
  
  // Facebook
  if (socialRaw.facebook.urls[0] && !merged.facebookPageUrl) {
    merged.facebookPageUrl = socialRaw.facebook.urls[0];
  }
  if (socialRaw.facebook.handles[0] && !merged.facebookPageName) {
    merged.facebookPageName = socialRaw.facebook.handles[0];
  }
  
  // Instagram
  if (socialRaw.instagram.handles[0] && !merged.instagramHandle) {
    merged.instagramHandle = socialRaw.instagram.handles[0];
  }
  
  // TikTok, YouTube, Twitter, LinkedIn, Snapchat, Pinterest, Threads
  if (socialRaw.tiktok.handles[0]) merged.tiktokHandle = socialRaw.tiktok.handles[0];
  if (socialRaw.youtube.handles[0]) merged.youtubeChannel = socialRaw.youtube.handles[0];
  if (socialRaw.twitter.handles[0]) merged.twitterHandle = socialRaw.twitter.handles[0];
  if (socialRaw.snapchat.handles[0]) merged.snapchatHandle = socialRaw.snapchat.handles[0];
  if (socialRaw.pinterest.handles[0]) merged.pinterestHandle = socialRaw.pinterest.handles[0];
  if (socialRaw.threads.handles[0]) merged.threadsHandle = socialRaw.threads.handles[0];
  
  // LinkedIn: pick company first
  const liCompany = socialRaw.linkedin.handles.find(h => h.startsWith('company/'));
  if (liCompany) merged.linkedinCompany = liCompany.replace('company/', '');
  
  // WhatsApp
  if (socialRaw.whatsapp.handles[0]) merged.whatsappBusiness = socialRaw.whatsapp.handles[0];
  
  return merged;
}

/**
 * pickBrandName — domain-guarded brand name resolution.
 *
 * Builds a ranked list of candidates (og:siteName, schema.org Organization,
 * WebSite, LocalBusiness, then title cleanups). Each candidate is scored
 * against the canonical domain root token. Candidates that don't echo the
 * domain are penalized — they're almost always Product.brand pollution or
 * aggregator chrome leaking into the page header.
 *
 * Returns { name, source, confidence, matchesDomain, candidates }.
 */
function pickBrandName(metaSignals, canonical) {
  const token = domainToken(canonical);
  const titleCandidates = cleanupTitleCandidates(metaSignals.seo?.title || '', token);

  // Walk every Organization/LocalBusiness/Corporation node, not just the first,
  // so we don't get hijacked by a Tesla product schema on a Zigwheels page.
  const orgPick = pickBestOrganizationNode(metaSignals.schemaOrg, canonical);

  const candidates = [
    { value: cleanCandidate(metaSignals.og?.siteName), source: 'og:site_name',     baseScore: 0.95 },
    { value: cleanCandidate(orgPick.node?.name),       source: orgPick.type ? `schema.${orgPick.type}` : null, baseScore: 0.88 },
    { value: cleanCandidate(metaSignals.schemaOrg?.website?.name), source: 'schema.WebSite',  baseScore: 0.82 },
    ...titleCandidates.map((t) => ({ value: t.value, source: t.source, baseScore: t.baseScore })),
    { value: cleanCandidate(metaSignals.twitter?.title?.split(/\s*[|·\-–—]\s*/)[0]), source: 'twitter:title', baseScore: 0.5 },
  ].filter((c) => c.value && c.source);

  // Score: penalize 55% if the candidate doesn't echo the domain. That keeps
  // a clean og:siteName at ~0.95 but drops a hijacking title to ~0.42, below
  // the domain-fallback floor (0.45) so we'd rather use the domain itself.
  for (const c of candidates) {
    const m = brandMatchesDomain(c.value, canonical);
    c.matchesDomain = m.matches;
    c.adjustedScore = m.matches ? c.baseScore : c.baseScore * 0.45;
  }
  candidates.sort((a, b) => b.adjustedScore - a.adjustedScore);

  const top = candidates[0];
  if (top && top.matchesDomain) {
    return {
      name: top.value,
      source: top.source,
      confidence: top.adjustedScore,
      matchesDomain: true,
      candidates,
    };
  }

  // No domain-matching candidate. If we only have non-matching candidates,
  // we'd rather surface the domain-derived name than leak Tesla onto Zigwheels.
  if (token) {
    return {
      name: capitalize(token),
      source: 'fallback.domain',
      confidence: 0.45,
      matchesDomain: true,
      candidates,
    };
  }

  // Last resort: best non-matching candidate (still better than null UI).
  if (top) {
    return {
      name: top.value,
      source: top.source,
      confidence: top.adjustedScore,
      matchesDomain: false,
      candidates,
    };
  }

  return { name: null, source: null, confidence: 0, matchesDomain: false, candidates: [] };
}

/**
 * cleanupTitleCandidates — produces every plausible brand-from-title slice.
 *
 * Old behavior assumed brand was on the LEFT of the separator. Aggregator
 * pages flip that ("Tesla cars in UAE — Zigwheels"), so we generate BOTH
 * sides and let the domain-guard choose. We also pick the side that contains
 * the domain token if any side does.
 */
function cleanupTitleCandidates(title, token) {
  if (!title) return [];
  const stripped = title
    .replace(/\s*[|·\-–—]\s*(Home|Homepage|Welcome|Official site).*/i, '')
    .trim();
  if (!stripped) return [];

  const SEP_RE = /\s*[|·\-–—]\s*/;
  const parts = stripped.split(SEP_RE).map((s) => s.trim()).filter(Boolean);

  if (parts.length === 1) {
    return [{ value: parts[0], source: 'title.full', baseScore: 0.55 }];
  }

  const first = parts[0];
  const last = parts[parts.length - 1];

  // Prefer the side containing the domain token.
  if (token) {
    const firstHas = brandMatchesDomain(first, `${token}.x`).matches;
    const lastHas  = brandMatchesDomain(last,  `${token}.x`).matches;
    if (lastHas && !firstHas) {
      return [
        { value: last,  source: 'title.right', baseScore: 0.6 },
        { value: first, source: 'title.left',  baseScore: 0.4 },
      ];
    }
  }
  return [
    { value: first, source: 'title.left',  baseScore: 0.55 },
    { value: last,  source: 'title.right', baseScore: 0.4 },
  ];
}

// function extractPageHeadlines(html) {
//   const cheerio = require('cheerio');
//   const $ = cheerio.load(html);
//   const headlines = [];
  
//   $('h1, h2').each((_, el) => {
//     const text = $(el).text().trim();
//     if (text.length > 5 && text.length < 200) {
//       headlines.push(text);
//     }
//   });
  
//   return headlines.slice(0, 20);
// }


const NAV_BOILERPLATE = new Set([
    'country/region', 'search', 'shopping cart', 'quick links', 'menu',
    'account', 'sign in', 'log in', 'login', 'register', 'subscribe',
    'newsletter', 'follow us', 'contact', 'contact us', 'about', 'about us',
    'home', 'shop', 'products', 'cart', 'checkout', 'wishlist',
    'connectivity', 'support', 'help', 'faq', 'faqs', 'privacy policy',
    'terms of service', 'terms & conditions', 'returns', 'shipping',
    'currency', 'language',
  ]);
  
  function extractPageHeadlines(html) {
    const cheerio = require('cheerio');
    const $ = cheerio.load(html);
    const headlines = [];
    const seen = new Set();
    
    $('h1, h2, h3').each((_, el) => {
      const $el = $(el);
      
      // Skip if inside footer/nav/aside/header (site chrome)
      if ($el.closest('footer, nav, aside, [role="navigation"], [role="complementary"]').length) return;
      
      // Skip screen-reader-only
      const classes = ($el.attr('class') || '').toLowerCase();
      if (/visually-hidden|sr-only|screen-?reader/.test(classes)) return;
      
      // Skip hidden elements
      const inlineStyle = $el.attr('style') || '';
      if (/display\s*:\s*none|visibility\s*:\s*hidden/.test(inlineStyle)) return;
      
      const text = $el.text().trim().replace(/\s+/g, ' ');
      const lower = text.toLowerCase();
      
      // Length filter
      if (text.length < 6 || text.length > 200) return;
      
      // Nav boilerplate filter
      if (NAV_BOILERPLATE.has(lower)) return;
      
      // Dedupe
      if (seen.has(lower)) return;
      seen.add(lower);
      
      headlines.push(text);
    });
    
    return headlines.slice(0, 20);
  }

function inferMarkets(canonical, metaSignals) {
  const markets = new Set();
  
  // TLD-based inference
  const tld = canonical.split('.').pop();
  const TLD_TO_MARKET = {
    ae: 'AE', sa: 'SA', kw: 'KW', qa: 'QA', bh: 'BH', om: 'OM',
    uk: 'GB', in: 'IN', de: 'DE', fr: 'FR', es: 'ES', it: 'IT',
    jp: 'JP', cn: 'CN', br: 'BR', au: 'AU', ca: 'CA',
  };
  if (TLD_TO_MARKET[tld]) markets.add(TLD_TO_MARKET[tld]);
  
  // og:locale
  const locale = metaSignals.og?.locale;
  if (locale) {
    const parts = locale.split('_');
    if (parts.length === 2) markets.add(parts[1].toUpperCase());
  }
  
  // Schema.org address
  const addrCountry = metaSignals.schemaOrg?.organization?.address?.addressCountry
                   || metaSignals.schemaOrg?.localBusiness?.address?.addressCountry;
  if (addrCountry) markets.add(addrCountry.toUpperCase());
  
  return Array.from(markets);
}

function inferLanguages(metaSignals) {
  const langs = new Set();
  if (metaSignals.lang?.html) {
    langs.add(metaSignals.lang.html.split('-')[0].toLowerCase());
  }
  if (metaSignals.og?.locale) {
    langs.add(metaSignals.og.locale.split('_')[0].toLowerCase());
  }
  return Array.from(langs);
}

function formatAddress(addr) {
  if (!addr) return null;
  if (typeof addr === 'string') return addr;
  const parts = [
    addr.streetAddress,
    addr.addressLocality,
    addr.addressRegion,
    addr.postalCode,
    addr.addressCountry,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : null;
}


function computeOverallConfidence(brand) {
    // Dynamic weighting — only count confidence fields that had signals to verify
    const scored = [];
    
    if (brand.brandName) 
      scored.push({ value: brand.confidence.brandName || 0, weight: 0.35 });
    
    if (brand.businessType) 
      scored.push({ value: brand.confidence.businessType || 0, weight: 0.3 });
    
    if (brand.handles?.facebookPageUrl) 
      scored.push({ value: brand.confidence.facebookPage || 0, weight: 0.2 });
    
    if (brand.handles?.instagramHandle) 
      scored.push({ value: brand.confidence.instagramHandle || 0, weight: 0.15 });
    
    // Business type classification got a boost — LLM-confident
    if (brand.assets?.logo) 
      scored.push({ value: 0.9, weight: 0.1 });  // Asset extraction succeeded
    
    const totalWeight = scored.reduce((s, x) => s + x.weight, 0);
    if (totalWeight === 0) return 0;
    
    const weighted = scored.reduce((s, x) => s + x.value * x.weight, 0);
    return Math.round((weighted / totalWeight) * 100) / 100;
  }

module.exports = {
  resolveBrandIdentity,
  ENRICHMENT_VERSION,
  // exposed for unit tests
  _pickBrandName: pickBrandName,
  _cleanupTitleCandidates: cleanupTitleCandidates,
};