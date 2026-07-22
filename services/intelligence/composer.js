'use strict';

/**
 * Composer — Layer 5 of the intelligence stack.
 *
 * Synthesizes the top-ranked ScoredInsights into a single
 * BrandBattlefieldReport that the UI renders directly. The UI no longer
 * asks questions like "which ad should I show"; it reads `counterStrategy`
 * and renders it.
 *
 * Two paths:
 *   1. LLM path (preferred when ANTHROPIC_API_KEY is present): Claude
 *      produces the positioning headline and 3 concrete ad briefs, using
 *      the scored insights as structured context.
 *   2. Heuristic fallback: we compose a decent (if generic) strategy
 *      directly from the top signals. Ensures the UI never blanks.
 */

const MODEL_LITE = process.env.ANTHROPIC_MODEL_LITE || 'claude-haiku-4-5-20251001';
const MODEL_REASONING = process.env.ANTHROPIC_MODEL_REASONING || 'claude-sonnet-4-5-20250929';

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
 * @param {object} input
 *   brandIdentity    — competitor BrandIdentity (the one being analyzed)
 *   scoredInsights   — ranked list from scoring.rankSignals
 *   collectionReport — orchestrator output (for dataHealth in the report)
 *   userBrandIdentity — optional — the user's own brand for personalisation
 * @param {object} opts
 *   useLlm — default true
 * @returns {Promise<BrandBattlefieldReport>}
 */
async function composeBattlefieldReport(input, opts = {}) {
  const {
    brandIdentity,
    scoredInsights = [],
    collectionReport,
    userBrandIdentity = null,
  } = input;

  if (!brandIdentity) throw new Error('composeBattlefieldReport: brandIdentity required');

  const heroInsights = scoredInsights
    .filter((s) => s.tier === 'hero' || s.tier === 'strong')
    .slice(0, 5);

  const useLlm = opts.useLlm !== false && !!getAnthropic();
  let counterStrategy;
  if (useLlm) {
    counterStrategy = await llmCompose({
      brandIdentity,
      userBrandIdentity,
      heroInsights,
    }).catch(() => null);
  }
  if (!counterStrategy) {
    counterStrategy = heuristicCompose({
      brandIdentity,
      userBrandIdentity,
      heroInsights,
      scoredInsights,
    });
  }

  const dataHealth = buildDataHealth(collectionReport);
  const refreshCooldownMs = 7 * 24 * 3600 * 1000;

  return {
    brandIdentity: {
      canonicalDomain: brandIdentity.canonicalDomain,
      brandName: brandIdentity.brandName,
      handles: brandIdentity.handles,
      markets: brandIdentity.markets,
    },
    heroInsights,
    counterStrategy,
    dataHealth,
    generatedAt: new Date(),
    refreshAvailableAt: new Date(Date.now() + refreshCooldownMs),
  };
}

// ─── LLM composer ─────────────────────────────────────────────────────────

async function llmCompose({ brandIdentity, userBrandIdentity, heroInsights }) {
  const client = getAnthropic();
  if (!client) return null;

  const payload = {
    competitor: {
      name: brandIdentity.brandName,
      domain: brandIdentity.canonicalDomain,
      markets: brandIdentity.markets,
    },
    user: userBrandIdentity
      ? {
          name: userBrandIdentity.brandName,
          domain: userBrandIdentity.canonicalDomain,
        }
      : null,
    insights: heroInsights.map((i) => ({
      kind: i.signal.kind,
      score: i.compositeScore,
      summary: i.signal.summary,
      detail: i.signal.detail,
      recommendation: i.signal.actionable?.recommendation,
      exampleEvidence: i.signal.supportingEvidence?.slice(0, 3),
    })),
  };

  const prompt = `You are the strategy voice of Qumak Studio — a Gulf-focused AI
advertising platform. I'm handing you a competitor dossier summarised as scored
insights. Your job is to produce a "battlefield report": a one-headline thesis,
a 1-sentence positioning statement, and 3 concrete counter-ads ready to be
generated.

Your tone: direct, specific, confident. No marketing fluff. No em-dashes for
drama. No "In today's world". Write as if briefing a founder 45 minutes before
a campaign launch.

Hard rules:
  • Headlines must be <= 80 characters
  • Each tactic needs a concrete "exampleCreative" with headline/hookLine/body/cta
  • Match the competitor's market(s) implicitly in tone/examples
  • If an insight has high actionability, use it as the *primary* tactic

Competitor dossier (JSON):
${JSON.stringify(payload, null, 2)}

Return STRICT JSON only (no prose, no markdown, start with { end with }):
{
  "title": "short title for the report",
  "headline": "serif-style headline (<=80 chars)",
  "positioningStatement": "1 sentence thesis about how to beat them",
  "tactics": [
    {
      "tactic": "what to do, 1 sentence",
      "why": "why it beats their approach, 1 sentence",
      "exampleCreative": {
        "headline": "<=80 chars",
        "hookLine": "<=120 chars",
        "body": "<=260 chars",
        "cta": "<=20 chars",
        "prompt": "a diffusion-model prompt for the visual",
        "modelId": "fal-ai/flux-pro/v1.1"
      }
    }
  ]
}
`;

  const resp = await client.messages.create({
    model: heroInsights.length >= 3 ? MODEL_REASONING : MODEL_LITE,
    max_tokens: 1400,
    messages: [{ role: 'user', content: prompt }],
  });
  const text = resp.content?.[0]?.text || '';
  const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    // Basic shape defence so UI doesn't NPE on a malformed LLM reply.
    return sanitiseStrategy(parsed);
  } catch {
    return null;
  }
}

function dedupeTactics(tactics) {
  const seen = new Set();
  const out = [];
  for (const t of tactics) {
    const t1 = String(t.tactic || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 220);
    const w1 = String(t.why || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 140);
    const key = `${t1}|${w1}`;
    if (!t1 || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

function sanitiseStrategy(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const tactics = dedupeTactics(
    (Array.isArray(obj.tactics) ? obj.tactics.slice(0, 8) : []).map((t) => ({
      tactic: String(t?.tactic || '').slice(0, 240),
      why: String(t?.why || '').slice(0, 240),
      exampleCreative: t?.exampleCreative
        ? {
            headline: String(t.exampleCreative.headline || '').slice(0, 120),
            hookLine: String(t.exampleCreative.hookLine || '').slice(0, 160),
            body: String(t.exampleCreative.body || '').slice(0, 320),
            cta: String(t.exampleCreative.cta || '').slice(0, 40),
            prompt: String(t.exampleCreative.prompt || '').slice(0, 700),
            modelId: String(t.exampleCreative.modelId || 'fal-ai/flux-pro/v1.1').slice(0, 80),
          }
        : null,
    })).filter((t) => t.tactic),
  ).slice(0, 5);
  return {
    title: String(obj.title || 'Battlefield report').slice(0, 120),
    headline: String(obj.headline || '').slice(0, 160),
    positioningStatement: String(obj.positioningStatement || '').slice(0, 280),
    tactics,
  };
}

// ─── Heuristic fallback composer ──────────────────────────────────────────

function heuristicCompose({ brandIdentity, heroInsights }) {
  const top = heroInsights[0]?.signal;
  const second = heroInsights[1]?.signal;

  const headline = top
    ? `How to beat ${brandIdentity.brandName} without copying them`
    : `Your battlefield vs. ${brandIdentity.brandName}`;

  const positioning = top
    ? `${top.summary}. ${top.actionable?.recommendation || ''}`.trim()
    : `We did not surface enough high-confidence signal to recommend a specific counter-strategy yet. Refresh in 24h when more sources are collected.`;

  const tactics = [top, second]
    .filter(Boolean)
    .map((s) => ({
      tactic: s.actionable?.recommendation || s.summary,
      why: s.detail || 'High-confidence competitive signal.',
      exampleCreative: {
        headline: s.actionable?.exampleAd || s.summary,
        hookLine: `Their ${s.kind.replace(/_/g, ' ')} pattern is exactly where you punch back.`,
        body: s.detail || '',
        cta: 'Generate this ad',
        prompt: `Ad creative for a Gulf-market challenger brand countering ${brandIdentity.brandName}. Emphasize: ${s.actionable?.recommendation || s.summary}. Tone: confident, specific, no hype.`,
        modelId: 'fal-ai/flux-pro/v1.1',
      },
    }));

  if (tactics.length < 3 && top) {
    tactics.push({
      tactic: 'Rerun the scan in 24 hours to gather more source signal.',
      why: 'Coverage is below optimal — freshness scoring will improve on refresh.',
      exampleCreative: null,
    });
  }

  return {
    title: `Battlefield: ${brandIdentity.brandName}`,
    headline,
    positioningStatement: positioning,
    tactics: dedupeTactics(tactics).slice(0, 5),
  };
}

function buildDataHealth(report) {
  if (!report) {
    return {
      sourcesHealthy: 0,
      sourcesTotal: 0,
      oldestSourceAgeHours: null,
      confidence: 0,
    };
  }
  const ages = (report.sources || [])
    .filter((s) => s.status === 'ok' && s.durationMs != null)
    .map(() => 0); // all sources in this run are "just collected"
  const coverage = report.sourcesTotal
    ? report.sourcesHealthy / report.sourcesTotal
    : 0;
  return {
    sourcesHealthy: report.sourcesHealthy || 0,
    sourcesTotal: report.sourcesTotal || 0,
    oldestSourceAgeHours: ages.length ? Math.max(...ages) : 0,
    confidence: Number(coverage.toFixed(3)),
  };
}

module.exports = {
  composeBattlefieldReport,
  _internals: { heuristicCompose, buildDataHealth, sanitiseStrategy, dedupeTactics },
};
