'use strict';

/**
 * adSpecTeardown.js — turns a competitor ad into a DRAFT ad-spec.
 *
 * Inputs come from what you ALREADY have:
 *   • scan.apifyData.competitorAds[].ads[].intelligence  (primaryAngle, etc.)
 *   • OR a fresh transcript from ffmpeg+Whisper (competitor video → audio → text)
 *
 * Output: a createDraftSpec() result, seeded with the USER's brand/avatar/
 * product and the competitor's *structure* (never their words/assets).
 *
 * The LLM call is your existing callHaiku/callLLM client, injected as a dep so
 * this module has zero hard provider dependency and is unit-testable offline.
 * If the LLM is unavailable, we fall back to a deterministic heuristic so the
 * teardown NEVER blocks the funnel (same fail-safe pattern as shotPromptEngine).
 */

const {
  createDraftSpec, fingerprintSource, defaultBeatsFor,
  AD_STRUCTURES, HOOK_TYPES, TRIGGERS,
} = require('./adSpec');

// ── The classifier prompt (this is the core IP — keep it server-side) ───────

function classifierMessages({ transcript, competitorName, vision }) {
  const sys = [
    'You are an expert direct-response ad strategist.',
    'You receive a competitor video ad: its transcript and (optionally) visual notes.',
    'Your job is to extract the REUSABLE STRUCTURE, not the content.',
    'Identify the ad framework, the per-beat roles with director intent, the hook type, and the psychological triggers.',
    'Return STRICT JSON only, no markdown, no preamble. Never quote the transcript verbatim — describe the FUNCTION of each beat in your own words.',
    'Schema:',
    '{"structure":"<one of: ' + AD_STRUCTURES.join('|') + '>",',
    ' "hookType":"<one of: ' + HOOK_TYPES.join('|') + '>",',
    ' "triggers":["<subset of: ' + TRIGGERS.join('|') + '>"],',
    ' "beats":[{"role":"hook|problem|agitation|solution|demo|proof|benefit|reveal|result|cta","intent":"<why this beat exists, your words>"}],',
    ' "pacing":"fast|medium|cinematic"}',
  ].join(' ');

  const user = [
    competitorName ? `Competitor: ${competitorName}.` : '',
    vision ? `Visual notes: ${vision}.` : '',
    'Transcript (for structure analysis only — do not reproduce):',
    String(transcript || '').slice(0, 4000),
  ].filter(Boolean).join('\n');

  return [
    { role: 'system', content: sys },
    { role: 'user', content: user },
  ];
}

// ── Heuristic fallback when no LLM / no transcript ──────────────────────────

function heuristicClassify({ transcript = '', intelligence = {} }) {
  const t = transcript.toLowerCase();
  let structure = 'hook_problem_solution';
  let hookType = 'curiosity_gap';

  if (/\?/.test(transcript.slice(0, 120))) hookType = 'question';
  if (/(struggle|tired of|sick of|problem|stop)/.test(t)) { structure = 'problem_agitate_solve'; hookType = 'pain'; }
  if (/(review|honest|i tried|i bought)/.test(t)) structure = 'ugc_review';
  if (/(before|after|transform|results)/.test(t)) structure = 'before_after';

  const triggers = [];
  if (/(now|today|limited|hurry|last)/.test(t)) triggers.push('urgency', 'FOMO');
  if (/(everyone|thousands|join)/.test(t)) triggers.push('social_proof');
  if (intelligence?.primaryAngle) triggers.push('value');

  return {
    structure,
    hookType,
    triggers: [...new Set(triggers)].filter((x) => TRIGGERS.includes(x)),
    beats: defaultBeatsFor(structure),
    pacing: 'medium',
  };
}

function coerceClassification(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    const cleaned = raw.replace(/```json|```/g, '').trim();
    try { obj = JSON.parse(cleaned); } catch { return null; }
  }
  if (!obj || !AD_STRUCTURES.includes(obj.structure)) return null;
  if (!Array.isArray(obj.beats) || obj.beats.length < 2) return null;
  return obj;
}

// ── Public: build a draft spec from a competitor ad ─────────────────────────

/**
 * teardownToSpec
 * @param {object} args
 * @param {object} args.scan        — the UrlToAdsScan doc (for brand seed)
 * @param {string} args.transcript  — Whisper output (optional if intelligence given)
 * @param {string} args.competitorName
 * @param {object} args.intelligence — scan.apifyData.competitorAds[].ads[].intelligence (optional)
 * @param {string} args.vision      — vision-LLM frame notes (optional)
 * @param {object} args.overrides   — { structure?, aspectRatio?, avatar?, product? }
 * @param {object} deps             — { callLLM(messages):Promise<string> }
 * @returns draft adSpec
 */
async function teardownToSpec(args, deps = {}) {
  const {
    scan, transcript = '', competitorName = null,
    intelligence = {}, vision = '', overrides = {},
  } = args;

  let classification = null;
  if (deps.callLLM && (transcript || vision)) {
    try {
      const raw = await deps.callLLM(classifierMessages({ transcript, competitorName, vision }));
      classification = coerceClassification(raw);
    } catch (err) {
      console.warn('[adSpecTeardown] LLM classify failed, using heuristic:', err?.message);
    }
  }
  if (!classification) classification = heuristicClassify({ transcript, intelligence });

  // Seed brand block from the scan you already persist.
  const palette = (scan?.brandPalette?.swatches || [])
    .map((s) => s?.hex).filter(Boolean).slice(0, 6);
  const productUrl =
    overrides.product?.url ||
    scan?.brand?.images?.[0] ||
    (Array.isArray(scan?.sourceImageUrls) ? scan.sourceImageUrls[0] : null) ||
    null;

  // Turn classified beats into editable beats with empty userCopy — the
  // regeneration step (regenerateCopy) fills brand-voice lines next.
  const beats = classification.beats.map((b) => ({
    role: b.role,
    intent: b.intent || '',
    hookType: b.role === 'hook' ? (classification.hookType || 'curiosity_gap') : null,
    overlay: b.role === 'hook' ? 'headline' : (b.role === 'cta' ? 'cta' : null),
    userCopy: '',
  }));

  return createDraftSpec({
    scanId: String(scan?._id || ''),
    structure: overrides.structure || classification.structure,
    aspectRatio: overrides.aspectRatio || '9:16',
    beats,
    triggers: classification.triggers,
    brand: {
      name: scan?.confirmedBrand?.name || scan?.brand?.name,
      category: scan?.confirmedBrand?.category || scan?.brand?.category,
      palette: (scan?.confirmedBrand?.palette?.length ? scan.confirmedBrand.palette : palette),
      logoUrl: scan?.brand?.logoUrl || null,
    },
    avatar: overrides.avatar || null,
    product: productUrl ? { url: productUrl } : null,
    sourceFingerprint: fingerprintSource({
      competitor: competitorName,
      transcript,
      structure: classification.structure,
    }),
  });
}

// ── Regeneration: fill each beat with the USER's brand-voice copy ───────────

function regenMessages({ spec }) {
  const sys = [
    'You are a direct-response copywriter writing a short-form video ad script.',
    'You are given an ad STRUCTURE (beats with roles and director intent) and a brand.',
    'Write ONE punchy line per beat in the brand\'s voice. Match the role and intent.',
    'Return STRICT JSON only: {"lines":[{"id":"<beat id>","copy":"<line>"}], "headline":"<global headline>", "cta":"<cta>"}.',
    'No markdown. Keep each line under 14 words. This is the user\'s own original copy, not a competitor\'s.',
  ].join(' ');

  const beats = spec.beats.map((b) => ({
    id: b.id, role: b.role, hookType: b.hookType, intent: b.intent,
  }));
  const user = JSON.stringify({
    brand: spec.brand, structure: spec.structure, triggers: spec.triggers, beats,
  });
  return [{ role: 'system', content: sys }, { role: 'user', content: user }];
}

/**
 * regenerateCopy — fills userCopy/headline/cta on a draft spec. Mutates a COPY
 * and returns it. Falls back to intent-as-placeholder so the editor is never empty.
 */
async function regenerateCopy(spec, deps = {}) {
  const next = JSON.parse(JSON.stringify(spec));
  let parsed = null;

  if (deps.callLLM) {
    try {
      const raw = await deps.callLLM(regenMessages({ spec }));
      const cleaned = String(raw || '').replace(/```json|```/g, '').trim();
      parsed = JSON.parse(cleaned);
    } catch (err) {
      console.warn('[adSpecTeardown] regen copy failed, using placeholders:', err?.message);
    }
  }

  const byId = {};
  (parsed?.lines || []).forEach((l) => { byId[l.id] = l.copy; });

  next.beats = next.beats.map((b) => ({
    ...b,
    userCopy: byId[b.id] || b.userCopy || b.intent || '',
  }));
  next.headline = parsed?.headline || next.headline || next.brand?.name || '';
  next.cta = parsed?.cta || next.cta || 'Learn more';
  next.updatedAt = new Date().toISOString();
  return next;
}

module.exports = {
  teardownToSpec,
  regenerateCopy,
  classifierMessages,
  regenMessages,
  heuristicClassify,
  coerceClassification,
};