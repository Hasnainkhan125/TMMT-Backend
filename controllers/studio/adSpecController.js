'use strict';

/**
 * adSpecController.js — HTTP surface for the editable ad-spec.
 *
 * Mounts under the existing studio router. Reuses your scan ownership +
 * error-shape conventions (handleErr-style). The spec is persisted ON the
 * scan document (see the schema patch in adSpec.SCHEMA.md) under `adSpecs[]`,
 * so it deep-links and survives reopen exactly like your `ads[]`.
 *
 *   POST /studio/url-to-ads/scan/:id/spec/teardown   — competitor → draft spec
 *   POST /studio/url-to-ads/scan/:id/spec            — draft from own brand
 *   PUT  /studio/url-to-ads/scan/:id/spec/:specId    — save user edits
 *   POST /studio/url-to-ads/scan/:id/spec/:specId/regenerate-copy
 *   POST /studio/url-to-ads/scan/:id/spec/:specId/confirm   — validate + render
 */

const UrlToAdsScan = require('../../model/schema/urlToAdsScan');
const {
  createDraftSpec, specFromScan, validateSpec, isConfirmable, adSpecToRecipeOpts,
} = require('../../services/adSpec/adSpec');
const { teardownToSpec, regenerateCopy } = require('../../services/adSpec/adSpecTeardown');
const { renderVideoAd } = require('../../services/renderVideoAd');

// Inject your real LLM client here (the same callHaiku used in shotPromptEngine).
// Kept as a thin local so this file has no hard provider import.
let callLLM = null;
try { callLLM = require('../../services/llm/callHaiku').callHaiku; } catch { /* optional */ }
const deps = callLLM ? { callLLM } : {};

// ── ownership helper (mirror your service's getScan rules) ──────────────────
async function ownedScan(req, id) {
  const scan = await UrlToAdsScan.findById(id);
  if (!scan) { const e = new Error('Scan not found.'); e.code = 'not_found'; throw e; }
  const owns =
    (req.user?._id && String(scan.userId) === String(req.user._id)) ||
    (scan.sessionId && scan.sessionId === (req.cookies?.qumak_session || req.headers['x-session-id']));
  if (!owns && scan.userId) { const e = new Error('forbidden'); e.code = 'forbidden'; throw e; }
  return scan;
}

function findSpec(scan, specId) {
  return (scan.adSpecs || []).find((s) => s.specId === specId) || null;
}

function fail(res, err) {
  const map = {
    not_found: 404, forbidden: 403, scan_not_ready: 409,
    spec_not_found: 404, spec_invalid: 422, insufficient_credits: 402,
  };
  const status = map[err?.code] || 500;
  if (status === 500) console.error('[adSpecController]', err);
  return res.status(status).json({ success: false, error: err?.code || 'server_error', message: err?.message || 'Something went wrong.' });
}

// ── handlers ────────────────────────────────────────────────────────────────

// competitor ad → draft spec (+ auto copy regen so the editor opens filled)
async function teardown(req, res) {
  try {
    const scan = await ownedScan(req, req.params.id);
    const { transcript, competitorName, intelligence, vision, structure, aspectRatio, avatar, product } = req.body || {};

    let spec = await teardownToSpec({
      scan, transcript, competitorName, intelligence, vision,
      overrides: { structure, aspectRatio, avatar, product },
    }, deps);
    spec = await regenerateCopy(spec, deps);

    scan.adSpecs = [...(scan.adSpecs || []), spec];
    await scan.save();
    return res.json({ success: true, spec });
  } catch (err) { return fail(res, err); }
}

// draft from the user's own brand (no competitor)
async function createFromScan(req, res) {
  try {
    const scan = await ownedScan(req, req.params.id);
    const { structure, aspectRatio } = req.body || {};
    const spec = specFromScan(scan, { structure, aspectRatio });
    scan.adSpecs = [...(scan.adSpecs || []), spec];
    await scan.save();
    return res.json({ success: true, spec });
  } catch (err) { return fail(res, err); }
}

// save edits — the user is the source of truth; we trust the posted spec body
// but re-stamp server-controlled fields and record which keys changed.
async function update(req, res) {
  try {
    const scan = await ownedScan(req, req.params.id);
    const existing = findSpec(scan, req.params.specId);
    if (!existing) { const e = new Error('Spec not found.'); e.code = 'spec_not_found'; throw e; }

    const incoming = req.body?.spec || {};
    const merged = {
      ...existing,
      ...incoming,
      specId: existing.specId,           // immutable
      scanId: existing.scanId,           // immutable
      status: 'draft',                   // editing always returns to draft
      sourceFingerprint: existing.sourceFingerprint, // never client-writable
      updatedAt: new Date().toISOString(),
      edits: { ...(existing.edits || {}), ...(incoming.edits || {}) },
    };

    scan.adSpecs = (scan.adSpecs || []).map((s) => (s.specId === merged.specId ? merged : s));
    scan.markModified('adSpecs');
    await scan.save();
    return res.json({ success: true, spec: merged, errors: validateSpec(merged) });
  } catch (err) { return fail(res, err); }
}

async function regenCopy(req, res) {
  try {
    const scan = await ownedScan(req, req.params.id);
    const existing = findSpec(scan, req.params.specId);
    if (!existing) { const e = new Error('Spec not found.'); e.code = 'spec_not_found'; throw e; }
    const next = await regenerateCopy(existing, deps);
    scan.adSpecs = (scan.adSpecs || []).map((s) => (s.specId === next.specId ? next : s));
    scan.markModified('adSpecs');
    await scan.save();
    return res.json({ success: true, spec: next });
  } catch (err) { return fail(res, err); }
}

// the gate: validate, then lower into your existing renderVideoAd pipeline
async function confirm(req, res) {
  try {
    const scan = await ownedScan(req, req.params.id);
    const spec = findSpec(scan, req.params.specId);
    if (!spec) { const e = new Error('Spec not found.'); e.code = 'spec_not_found'; throw e; }

    const errors = validateSpec(spec);
    if (errors.length) {
      return res.status(422).json({ success: false, error: 'spec_invalid', message: 'Fix the spec before generating.', errors });
    }

    const opts = adSpecToRecipeOpts(spec);

    // Drive your existing, working renderer. No engine rewrite required.
    const { adRow, recipe } = await renderVideoAd({
      scan, req,
      templateKey: opts.templateKey,
      headline: opts.headline,
      cta: opts.cta,
      productImageUrl: opts.productImageUrl,
      aspectRatio: opts.aspectRatio,
      shotCount: opts.shotCount,
      durationSec: opts.durationSec,
      avatarBrief: opts.avatarBrief,
      audio: opts.audio,
      startImageUrl: opts.startImageUrl,
      textOverlay: true,
      brandName: opts.brandName,         // from spec.brand.name, takes precedence over scan.brand.name
      __specBeats: opts.__specBeats,   // per-beat director data → per-shot prompts + images
    });

    // mark the spec rendered + link the adRow it produced
    spec.status = 'rendering';
    spec.renderedAdSetId = adRow.adSetId || null;
    spec.updatedAt = new Date().toISOString();
    scan.adSpecs = (scan.adSpecs || []).map((s) => (s.specId === spec.specId ? spec : s));
    scan.markModified('adSpecs');
    await scan.save();

    return res.json({ success: true, spec, adRow, adSetId: adRow.adSetId });
  } catch (err) { return fail(res, err); }
}


module.exports = { teardown, createFromScan, update, regenCopy, confirm };