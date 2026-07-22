'use strict';

/**
 * aiResearch — single-entry Anthropic brand intelligence for the URL→Ad flow.
 *
 * Design goals (per product brief):
 *   • NO hardcoded competitor buckets, NO hardcoded audience maps.
 *     Everything is inferred from the actual page content by Claude.
 *   • ONE Claude call per URL. We dump a truncated, cleaned HTML + the URL
 *     and ask for a structured JSON payload that covers:
 *        - brand (name, summary, category, vibe, keywords)
 *        - targetAudience (who buys, why, where they hang out)
 *        - competitors (real, researched — name + url + why-similar)
 *        - competitorAds (angles/hooks known to perform in this space)
 *        - hooks (creative angles / copy structures for ads)
 *        - palette (colors pulled from the page for visual consistency)
 *   • Results are CACHED by (url, day) in the `urlToAdsScan.aiResearch`
 *     field (set on the service side). This file stays stateless — it
 *     takes scraped HTML + url, returns the payload, and the caller
 *     persists/reads it to avoid repeat calls.
 *   • Graceful degradation: if ANTHROPIC_API_KEY is missing OR the call
 *     flakes, we return a deterministic minimal payload derived from
 *     the scrape text so the user always gets a usable screen.
 *
 * NOT goals:
 *   • Live web search / SERP for competitors — Claude has enough world
 *     knowledge about consumer brands across most major regions to answer
 *     this from the page context alone, and we save cost/latency.
 */

  const { validateCompetitorList } = require('./intelligence/competitorValidator');
  const { rootDomain }             = require('./resolver/utils/normalizeDomain');
  const probe                      = process.env.COMPETITOR_PROBE !== '0';
  
const MODEL = 'claude-haiku-4-5-20251001';
// Upper bound on HTML chars we send to Claude. Most landing pages compress
// to <20k of meaningful text — 60k is a safety ceiling so a wall-of-divs
// page doesn't blow our context budget.
const MAX_HTML_CHARS = 60_000;

let _anthropic;
function getAnthropic() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!_anthropic) {
    const Anthropic = require('@anthropic-ai/sdk');
    _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _anthropic;
}

// ─── HTML → text ───────────────────────────────────────────────────────────
// We hand Claude BOTH cleaned visible text AND selected structural tags so
// it can reason about hierarchy (H1 vs random body copy) without us parsing
// DOM. This keeps the prompt small while preserving the signal.
function condenseHtml(html) {
  if (!html || typeof html !== 'string') return '';
  let s = html;
  // Kill noisy blocks first.
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  s = s.replace(/<svg[\s\S]*?<\/svg>/gi, ' ');
  // Keep structural markers, strip everything else.
  s = s.replace(/<(h[1-4]|title|meta)[^>]*>/gi, (m) => `\n[${m.match(/<(\w+)/i)[1].toUpperCase()}] `);
  s = s.replace(/<\/(h[1-4]|title)>/gi, '\n');
  s = s.replace(/<(p|li|button|a)[^>]*>/gi, '\n');
  s = s.replace(/<\/(p|li|button|a)>/gi, ' ');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
       .replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  s = s.replace(/[ \t]+/g, ' ').replace(/\n[ \t]*\n+/g, '\n').trim();
  if (s.length > MAX_HTML_CHARS) s = s.slice(0, MAX_HTML_CHARS) + '\n… [truncated]';
  return s;
}

// ─── System prompt ─────────────────────────────────────────────────────────
function systemPrompt() {
  return `You are a senior brand strategist and performance marketer who specializes in researching websites for ad creative briefs for global brands. Default audience is worldwide; if the page itself signals a specific region (Gulf / UAE / India / UK / US / Europe / etc.), tighten your inferences for that region — but never invent regional context that isn't on the page.

For the given URL + a condensed snapshot of the page, you return a single JSON object with everything an ad team needs to run a first campaign — no placeholders, no generic buckets, nothing invented. If the page is thin, you still return real inferences from what's present; if you genuinely cannot infer a field, return it as an empty string or empty array (never make up competitor names).

Your output MUST be valid JSON matching this schema exactly, and nothing else — no markdown, no commentary, no code fences:

{
  "brand": {
    "name": "string — the actual brand name",
    "oneLiner": "string — 10-14 word punchy positioning",
    "summary": "string — 2-3 sentence what-they-do paragraph",
    "category": "string — specific category like 'boutique gym', 'luxury oud perfume house', 'D2C skincare'. Avoid single-word 'gym' / 'fashion'.",
    "subcategory": "string",
    "vibe": "string — e.g. 'premium-minimal', 'editorial-playful', 'urgent-direct-response'",
    "keywords": ["5-8 product / lifestyle keywords"],
    "valueProps": ["3-5 specific value propositions grounded in the page"],
    "tone": "string — e.g. 'confident, warm, premium' (add a regional qualifier only if the page makes the region obvious)",
    "palette": ["#hex", "#hex", "#hex"]
  },
  "targetAudience": {
    "primary": "string — 1-2 sentences describing the BEST buyer (demo, psychographics, context of use)",
    "secondary": "string — the adjacent audience worth testing",
    "jobsToBeDone": ["3-4 jobs-to-be-done the product solves"],
    "painPoints": ["3-4 specific pain points this audience feels today"],
    "buyingTriggers": ["3 moments that push them to buy"],
    "digitalWateringHoles": ["3-5 specific platforms/communities, e.g. 'Instagram food creators', 'TikTok skincare reviewers', 'Reddit r/SkincareAddiction'. If a region is clearly signaled by the page (language, currency, addresses, regulatory references), anchor at least one watering hole to that region. Otherwise default to globally-recognizable communities (e.g. 'r/SkincareAddiction', 'TikTok #CarTok', 'LinkedIn fintech operators')."]
  },
  "competitors": [
    {
      "name": "string — REAL, verifiable brand that this business competes with",
      "url": "string — homepage URL, https:// prefix",
      "tagline": "string — 1 line on why they matter",
      "why": "string — 1 line on what makes them a competitor here",
      "differentiator": "string — where the subject brand could beat them",
      "instagramHandle": "string — exact IG handle without @, e.g. 'lifepharmacyme'. Empty string if not 90%+ certain.",
      "facebookPageHandle": "string — exact FB page handle, e.g. 'lifepharmacyme'. Empty string if not 90%+ certain.",
      "tiktokHandle": "string — exact TikTok handle without @. Empty string if not 90%+ certain."
    }
  ],
  "competitorAds": [
    {
      "angle": "string — the creative angle competitors in this space use",
      "hook": "string — sample 6-10 word hook line",
      "format": "string — e.g. 'UGC testimonial 15s', 'hero product still', 'before/after carousel'",
      "whyItWorks": "string — 1 sentence"
    }
  ],
  "hooks": [
    {
      "label": "string — 2-5 words for the UI card, e.g. Hero launch, Social proof, Urgency CTA",
      "headline": "string — 6-10 words, scroll-stopping, specific to this brand",
      "body": "string — 20-35 words, continues the hook with substance",
      "cta": "string — 2-4 words",
      "vibe": "string — cinematic | editorial | urgent | playful | confident-minimal",
      "aspectRatio": "1:1 | 9:16 | 4:5 | 16:9",
      "modelHint": "flux_pro | nano_banana_pro | seedream_5_0 | gpt_image_2 | seedance_2_0_fast"
    }
  ]
}

Hard rules:
- Return 4-5 real competitors. If a region is clearly signaled by the page (language, currency, addresses, regulatory references), anchor at least one watering hole to that region. Otherwise default to globally-recognizable (e.g. 'r/SkincareAddiction', 'TikTok #CarTok', 'LinkedIn fintech operators'). Never use placeholder names like "Competitor A".
- Return 3-4 competitor ad angles that are actually used in this category today.
- Return 5 hooks that are specific to THIS brand's language, not templated. Each hook must include a unique short label for UI cards.
- palette: pick colors you can see mentioned/implied in the page (fonts, CTAs, hex codes in inline styles) or infer tasteful matches to the described vibe.
- For competitor handles (instagramHandle, facebookPageHandle, tiktokHandle): only include if you are 90%+ certain. An empty string is ALWAYS better than a guess. A wrong handle wastes a real Apify call and returns a stranger's profile.
- Output ONLY the JSON object. Start with { and end with }.

- CRITICAL: Do NOT list brands the subject business sells, distributes, 
  resells, partners with, or is an authorized dealer for. Those are 
  SUPPLIERS, not competitors. If the page says "authorized distributor of 
  X, Y, Z" or "we supply A, B, C", then X/Y/Z/A/B/C are explicitly 
  FORBIDDEN as competitors.
- A competitor is another business the subject's CUSTOMERS would buy from 
  INSTEAD. For a distributor/reseller, competitors are OTHER 
  distributors/resellers serving the same buyers in the same region — not 
  the manufacturers whose products they carry.`;
}

// ─── Deterministic fallback (no LLM) ───────────────────────────────────────
// Matches the schema; keeps the page functional when ANTHROPIC_API_KEY is
// missing. Explicitly avoids claiming fake competitor brands.
function fallbackPayload(scrape) {
  const brand = scrape?.brandName || scrape?.siteName || 'your brand';
  const oneLiner = (scrape?.description || scrape?.headlines?.[0] || '').slice(0, 140);
  return {
    brand: {
      name: brand,
      oneLiner: oneLiner || `${brand} — discover what sets them apart`,
      summary: oneLiner || `${brand} is a brand we'll enrich once the AI research layer is enabled.`,
      category: 'general',
      subcategory: '',
      vibe: 'confident-minimal',
      keywords: (scrape?.headlines || []).slice(0, 6),
      valueProps: (scrape?.paragraphs || []).slice(0, 3),
      tone: 'confident, direct',
      palette: ['#0f1217', '#a3e635', '#f5f5f5'],
    },
    targetAudience: {
      primary: 'Enable AI research to identify the primary buyer for this brand.',
      secondary: '',
      jobsToBeDone: [],
      painPoints: [],
      buyingTriggers: [],
      digitalWateringHoles: [],
    },
    competitors: [], // intentionally empty — do not fabricate
    competitorAds: [],
    hooks: [
      {
        label: 'Hero intro',
        headline: `Meet ${brand}.`,
        body: oneLiner || `${brand} is made for people who don't want to compromise.`,
        cta: 'Discover',
        vibe: 'cinematic',
        aspectRatio: '1:1',
        modelHint: 'flux_pro',
      },
    ],
    _source: 'fallback',
  };
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * researchBrand — Anthropic one-shot. Returns a structured brand intel
 * payload suitable for persisting verbatim on a UrlToAdsScan.
 *
 * @param {object} args
 * @param {string} args.url            – canonical URL the user scanned.
 * @param {string} args.html           – raw HTML returned by urlScraper.
 * @param {object} args.scrape         – the rest of the scrape result
 *                                        (brandName, headlines, etc).
 *                                        Used both as context for Claude
 *                                        and as a deterministic fallback.
 * @param {object} [args.cachedResult] – previously-returned payload; when
 *                                        provided we short-circuit and
 *                                        return it. Cache policy lives in
 *                                        urlToAdsService (TTL check etc).
 * @returns {Promise<object>} structured payload (schema above).
 */
async function researchBrand({ url, html, scrape, cachedResult } = {}) {
  if (cachedResult && cachedResult.brand?.name) {
    return { ...cachedResult, _source: cachedResult._source || 'cache' };
  }

  const client = getAnthropic();
  if (!client) return fallbackPayload(scrape);

  const condensed = condenseHtml(html || '');
  // If we genuinely got nothing off the page we can't do much.
  if (condensed.length < 60 && !scrape?.headlines?.length) {
    return fallbackPayload(scrape);
  }

  const userBody =
    `URL: ${url || ''}\n` +
    `Scraper-derived brand guess: ${scrape?.brandName || ''}\n` +
    `Scraper-derived category guess: ${scrape?.category || 'general'}\n` +
    (scrape?.description ? `Meta description: ${scrape.description}\n` : '') +
    (scrape?.headlines?.length ? `Headlines on page: ${scrape.headlines.slice(0, 6).join(' | ')}\n` : '') +
    `\n--- CONDENSED PAGE SNAPSHOT ---\n${condensed}\n--- END SNAPSHOT ---`;

  const callClaude = async (stricter = false) => {
    const messages = [{
      role: 'user',
      content: stricter
        ? userBody + '\n\nReturn ONLY the raw JSON object. Start with { end with }. No prose.'
        : userBody,
    }];
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 3500,
      system: systemPrompt(),
      messages,
    });
    const text = resp.content?.[0]?.text || '';
    const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(cleaned);
  };

  let parsed;
  try {
    parsed = await callClaude(false);
  } catch (err) {
    console.warn('[aiResearch] first parse failed:', err.message);
    try {
      parsed = await callClaude(true);
    } catch (err2) {
      console.warn('[aiResearch] retry failed, using fallback:', err2.message);
      return fallbackPayload(scrape);
    }
  }

  // Shape sanity — ensure arrays exist so the frontend never NPEs.
  parsed.brand            = parsed.brand            || {};
  parsed.brand.keywords   = Array.isArray(parsed.brand.keywords)   ? parsed.brand.keywords   : [];
  parsed.brand.valueProps = Array.isArray(parsed.brand.valueProps) ? parsed.brand.valueProps : [];
  parsed.brand.palette    = Array.isArray(parsed.brand.palette)    ? parsed.brand.palette    : [];
  parsed.targetAudience   = parsed.targetAudience || {};
  parsed.targetAudience.jobsToBeDone         = Array.isArray(parsed.targetAudience.jobsToBeDone)         ? parsed.targetAudience.jobsToBeDone         : [];
  parsed.targetAudience.painPoints           = Array.isArray(parsed.targetAudience.painPoints)           ? parsed.targetAudience.painPoints           : [];
  parsed.targetAudience.buyingTriggers       = Array.isArray(parsed.targetAudience.buyingTriggers)       ? parsed.targetAudience.buyingTriggers       : [];
  parsed.targetAudience.digitalWateringHoles = Array.isArray(parsed.targetAudience.digitalWateringHoles) ? parsed.targetAudience.digitalWateringHoles : [];
  parsed.competitors    = Array.isArray(parsed.competitors)    ? parsed.competitors    : [];
  parsed.competitorAds  = Array.isArray(parsed.competitorAds)  ? parsed.competitorAds  : [];
  parsed.hooks          = Array.isArray(parsed.hooks)          ? parsed.hooks          : [];

  // Post-LLM competitor validation. Drops descriptive placeholders ("Various
  // local sites"), bad URLs, the user's own brand, and 4xx domains. We do
  // this here — at the seam where LLM output lands — so every downstream
  // consumer (Apify, pattern engine, brand memory) gets clean data.
  try {

    const ownDomain                  = rootDomain(url);
    // HEAD probes hit the network — gate on env so unit tests stay hermetic.
   
    const { valid, dropped } = await validateCompetitorList(parsed.competitors, {
      ownDomain,
      probe,
    });
    if (dropped.length) {
      console.info('[aiResearch] dropped %d invalid competitors:', dropped.length,
        dropped.slice(0, 5).map((d) => `${d.name || d.url}→${d.reason}`).join('; '));
    }
    parsed.competitors = valid;
    parsed._competitorsDropped = dropped.slice(0, 10); // small audit trail
  } catch (vErr) {
    console.warn('[aiResearch] competitor validation failed (continuing):', vErr.message);
  }

  parsed._source = 'anthropic';
  parsed._model = MODEL;
  parsed._at = new Date().toISOString();
  return parsed;
}

module.exports = { researchBrand, _condenseHtml: condenseHtml, _fallbackPayload: fallbackPayload };
