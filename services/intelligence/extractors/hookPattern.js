'use strict';

/**
 * HookPatternExtractor — Layer 3 signal: what rhetorical device is the
 * competitor leaning on?
 *
 * Input: the mergedData payload from the orchestrator (keyed by collector
 * name). We pull headlines / captions / ad bodies from every source the
 * run surfaced — more sources supporting the same pattern = higher
 * `confidence` in the output Signal.
 *
 * Output: zero or one Signal objects of kind `hook_pattern`. Zero means
 * there's insufficient data to draw a conclusion — we refuse to guess
 * when the evidence is below `MIN_HEADLINES` because a hallucinated
 * positioning statement is worse than no statement at all.
 */

const HOOK_CATEGORIES = {
  curiosity: {
    patterns: [/^why\s+/i, /^the\s+truth\b/i, /secret/i, /nobody tells you/i, /what if\b/i],
    weight: 0.8,
    opposite: 'authority',
  },
  scarcity: {
    patterns: [/only\s+\d+/i, /limited\s+time/i, /last\s+\d+/i, /ends\s+(?:today|tonight|soon)/i, /while supplies last/i],
    weight: 0.9,
    opposite: 'abundance',
  },
  social: {
    patterns: [/\b\d{1,3},?\d{3,}\+?\b/, /trusted by/i, /join\s+\d+/i, /used by/i, /loved by/i],
    weight: 0.75,
    opposite: 'exclusivity',
  },
  authority: {
    patterns: [/backed by/i, /featured in/i, /approved by/i, /endorsed by/i, /rated #1/i, /award[- ]winning/i],
    weight: 0.75,
    opposite: 'contrarian',
  },
  benefit: {
    patterns: [/in\s+\d+\s+(?:days?|weeks?|months?|minutes?)/i, /without\b/i, /finally\b/i, /get\s+(?:more|better|faster)/i],
    weight: 0.8,
    opposite: 'process',
  },
  contrarian: {
    patterns: [/stop\s+\w+ing/i, /you(?:'ve)?\s+been\s+(?:wrong|doing it wrong)/i, /unlike\b/i, /tired of\b/i],
    weight: 0.9,
    opposite: 'consensus',
  },
  urgency: {
    patterns: [/today only/i, /act now/i, /don(?:'t)? miss/i, /right now/i, /before it's too late/i],
    weight: 0.85,
    opposite: 'calm',
  },
  reciprocity: {
    patterns: [/free\s+(?:\w+\s+){0,3}(?:ebook|guide|download|trial|consultation|quote|template)/i, /get a free\b/i, /no credit card/i],
    weight: 0.7,
    opposite: 'premium',
  },
};

const EXTRACTOR_VERSION = '1.0.0';
const MIN_HEADLINES = 3;

function getAnthropic() {
  try {
    if (!process.env.ANTHROPIC_API_KEY) return null;
    const Anthropic = require('@anthropic-ai/sdk');
    return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  } catch (_e) {
    return null;
  }
}

/**
 * @param {object} mergedData — keyed by collector name
 * @param {object} opts
 *   useLlm — default true; set false to skip Claude calls (tests / offline)
 * @returns {Promise<Signal|null>}
 */
async function extractHookPatterns(mergedData, opts = {}) {
  const useLlm = opts.useLlm !== false;

  const headlines = collectHeadlines(mergedData);
  if (headlines.length < MIN_HEADLINES) return null;

  const hits = {};
  for (const [category, { patterns, weight, opposite }] of Object.entries(HOOK_CATEGORIES)) {
    const matches = headlines.filter((h) => patterns.some((p) => p.test(h)));
    const percentage = matches.length / headlines.length;
    hits[category] = {
      matches: matches.slice(0, 8),
      count: matches.length,
      percentage,
      weightedScore: percentage * weight,
      opposite,
    };
  }

  const sorted = Object.entries(hits).sort((a, b) => b[1].weightedScore - a[1].weightedScore);
  const [dominantKey, dominant] = sorted[0];

  // Insufficient signal — lots of unique headlines but none match any pattern
  // meaningfully. Rather than present a noisy "50% other" signal, bail.
  if (!dominant || dominant.count === 0) return null;

  const confidence = confidenceFor(headlines.length, dominant.percentage);
  const sourceTypes = Object.keys(mergedData).filter((k) => !!mergedData[k]);

  let llm = null;
  if (useLlm) {
    llm = await askLlmForInsight(dominantKey, dominant).catch(() => null);
  }

  const opposite = dominant.opposite || 'contrarian';
  const estimatedImpact = dominant.count > 10 ? 'high' : dominant.count >= 5 ? 'medium' : 'low';

  return {
    kind: 'hook_pattern',
    confidence,
    sourceTypes,
    supportingEvidence: dominant.matches.slice(0, 6),
    summary: `${capitalize(dominantKey)} hooks dominate (${Math.round(
      dominant.percentage * 100,
    )}% of ${headlines.length} messages analysed)`,
    detail:
      llm?.positioningInsight ||
      defaultPositioningInsight(dominantKey, dominant.percentage),
    actionable: {
      recommendation: llm?.recommendation || `Counter with ${opposite} hooks — where they shout "scarcity / authority", you whisper "consistency / proof".`,
      exampleAd: llm?.counterHook || defaultCounterHook(dominantKey),
      estimatedImpact,
    },
    extractedAt: new Date(),
    extractor: 'hookPatternExtractor',
    extractorVersion: EXTRACTOR_VERSION,
    _raw: {
      headlineCount: headlines.length,
      hitsPerCategory: Object.fromEntries(
        Object.entries(hits).map(([k, v]) => [
          k,
          { count: v.count, percentage: Number(v.percentage.toFixed(3)) },
        ]),
      ),
    },
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function collectHeadlines(mergedData) {
  const all = [];

  const fb = mergedData?.public_fb_page;
  if (fb?.posts) for (const p of fb.posts) if (p.text) all.push(p.text);
  if (fb?.pageName) all.push(fb.pageName);
  if (fb?.description) all.push(fb.description);

  const serp = mergedData?.google_serp;
  if (serp?.ppcAds) for (const a of serp.ppcAds) {
    if (a.headline) all.push(a.headline);
    if (a.description) all.push(a.description);
  }
  if (serp?.organicTitles) all.push(...serp.organicTitles);
  if (serp?.peopleAlsoAsk) all.push(...serp.peopleAlsoAsk);

  const landing = mergedData?.landing_page_crawler;
  if (landing?.headlinesUsed) all.push(...landing.headlinesUsed);
  if (landing?.ctaPatterns) all.push(...landing.ctaPatterns);

  const ads = mergedData?.meta_ad_library;
  if (ads?.ads) for (const a of ads.ads) {
    if (a.headline) all.push(a.headline);
    if (a.body) all.push(a.body);
  }

  const tiktok = mergedData?.tiktok_creative_center;
  if (tiktok?.profile?.recentVideos) {
    for (const v of tiktok.profile.recentVideos) if (v.caption) all.push(v.caption);
  }

  // Dedupe & strip low-signal strings.
  const seen = new Set();
  return all
    .map((s) => String(s || '').replace(/\s+/g, ' ').trim())
    .filter((s) => {
      if (!s || s.length < 8 || s.length > 500) return false;
      const key = s.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function confidenceFor(sampleSize, topPercentage) {
  // Smooth 0→1. 3 samples → 0.2 ceiling. 30+ samples → approaches topPercentage.
  const sizeFactor = 1 - Math.exp(-sampleSize / 10);
  return Number((Math.min(1, topPercentage * sizeFactor * 1.25)).toFixed(3));
}

function capitalize(s) {
  if (!s) return '';
  return s[0].toUpperCase() + s.slice(1);
}

function defaultPositioningInsight(category, percentage) {
  const pct = Math.round(percentage * 100);
  const map = {
    curiosity: `They lean on curiosity hooks (~${pct}%), signalling they assume the audience is skeptical and need to be baited into paying attention.`,
    scarcity: `They lean on scarcity (~${pct}%), signalling they're optimising for short-cycle conversion, often at the cost of long-term brand trust.`,
    social: `They lean on social proof (~${pct}%), signalling the category is commoditised and they're competing on herd behaviour rather than differentiation.`,
    authority: `They lean on authority signals (~${pct}%), signalling they're earlier in the trust-building funnel than most competitors.`,
    benefit: `They lean on outcome/benefit framing (~${pct}%), signalling a mature marketing org that knows their primary value prop.`,
    contrarian: `They lean on contrarian hooks (~${pct}%), signalling they're positioning as the disruptor in a well-established category.`,
    urgency: `They lean on urgency (~${pct}%), signalling heavy discounting culture and likely margin pressure.`,
    reciprocity: `They lean on free/reciprocity offers (~${pct}%), signalling a long-cycle B2B or high-ticket sell.`,
  };
  return map[category] || `They lean primarily on ${category} hooks (~${pct}%).`;
}

function defaultCounterHook(category) {
  const map = {
    curiosity: 'Lead with a proof-point headline — a specific number customers can verify (e.g. "200+ Gulf brands ship weekly with us").',
    scarcity: 'Lead with a trust-over-time headline — "Here for the long haul. No limited-time hype."',
    social: 'Lead with a named-case-study headline instead of counts — "How Al Futtaim doubled CTR with this approach".',
    authority: 'Lead with a peer-voice headline instead of credentials — quote the buyer, not the award.',
    benefit: 'Lead with the *cost of not acting* — loss aversion beats gain framing in their market.',
    contrarian: 'Out-contrarian them with a specific, quotable claim — not "stop doing X", but "here is what X really costs you".',
    urgency: 'Lead with a calm, credible headline — "Take your time. We still work next week too."',
    reciprocity: 'Lead with paid-value proof — "This isn\'t free. Here\'s what it saves you."',
  };
  return map[category] || 'Lead with a concrete, number-anchored proof point the competitor can\'t match.';
}

async function askLlmForInsight(categoryKey, categoryHit) {
  const client = getAnthropic();
  if (!client) return null;
  const prompt = `You are an ad-strategy analyst. A competitor brand uses ${categoryKey} hooks in ${Math.round(
    categoryHit.percentage * 100,
  )}% of their messaging.

Sample headlines (verbatim):
${categoryHit.matches.slice(0, 6).map((m) => `- "${m.replace(/"/g, "'")}"`).join('\n')}

Return STRICT JSON (no prose, no markdown):
{
  "positioningInsight": "1-2 sentences on what this reveals about their strategy",
  "recommendation": "1 sentence counter-strategy for a challenger brand",
  "counterHook": "A single concrete headline a challenger could run tomorrow (<=90 chars)"
}
`;
  const model = process.env.ANTHROPIC_MODEL_LITE || 'claude-haiku-4-5-20251001';
  const resp = await client.messages.create({
    model,
    max_tokens: 400,
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

module.exports = {
  extractHookPatterns,
  EXTRACTOR_VERSION,
  _internals: { HOOK_CATEGORIES, collectHeadlines, confidenceFor },
};
