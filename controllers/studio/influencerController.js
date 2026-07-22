'use strict';

/**
 * influencerController — HTTP surface for the AI Influencer Builder
 * (Phase 6). Thin adapter over influencerService; responsibilities:
 *
 *   • Map Express req/res → service calls.
 *   • Shape validation / not-found / insufficient-credits errors into
 *     the same JSON envelope the rest of Studio uses.
 *   • Set the session cookie when the service created a new session
 *     (anonymous "just try it out" flow).
 *
 * Routes (mounted in _routes.js):
 *
 *   LEGACY (kept for backward compat with the one-off "make a face" flow):
 *     POST  /studio/influencer/generate
 *
 *   PHASE 6 persona-backed endpoints:
 *     POST  /studio/influencer/persona                  — create + render hero
 *     GET   /studio/influencer/personas                 — list library
 *     GET   /studio/influencer/persona/:id              — read + scenes
 *     POST  /studio/influencer/persona/:id/scene        — generate a scene
 *     POST  /studio/influencer/persona/:id/finalize     — stamp hero URL
 *     DELETE /studio/influencer/persona/:id             — archive
 */

const studioController   = require('./studioController');
const influencerService  = require('../../services/influencerService');
const { getStudioSessionId } = require('../../middelwares/studioIdentity');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getSessionId(req) {
  return getStudioSessionId(req);
}

function ownerFromReq(req) {
  return {
    userId: req.user?._id || null,
    sessionId: getSessionId(req),
  };
}

function setSessionCookieIfNew(res, result) {
  if (result?.isNewSession && result?.sessionId) {
    res.cookie('qumak_session', result.sessionId, {
      httpOnly: true,
      maxAge: 30 * 24 * 60 * 60 * 1000,
      sameSite: 'strict',
    });
  }
}

function handlePersonaError(res, err) {
  // Zod validation
  if (err?.issues && Array.isArray(err.issues)) {
    const msg = err.issues.map((i) => {
      const path = Array.isArray(i.path) && i.path.length ? i.path.join('.') : 'input';
      return `${path}: ${i.message}`;
    }).join('; ');
    return res.status(400).json({
      success: false, error: 'validation_error', message: msg, issues: err.issues,
    });
  }
  if (err?.code === 'persona_not_found') {
    return res.status(404).json({ success: false, error: err.code, message: 'Persona not found.' });
  }
  if (err?.code === 'persona_hero_not_ready') {
    return res.status(409).json({ success: false, error: err.code, message: err.message });
  }
  if (err?.code === 'no_hero_job') {
    return res.status(409).json({ success: false, error: err.code, message: err.message });
  }
  if (err?.code === 'forbidden') {
    return res.status(403).json({ success: false, error: 'forbidden', message: 'You do not have access to this persona.' });
  }
  if (err?.code === 'insufficient_credits') {
    return res.status(402).json({
      success: false,
      error: err.code,
      message: `Need ${err.required} credits — you have ${err.balance}.`,
      required: err.required,
      balance:  err.balance,
      topupUrl: '/pricing',
    });
  }
  if (err?.code === 'requested_model_unavailable') {
    return res.status(400).json({
      success: false, error: err.code, message: err.message,
      requestedModelId: err.requestedModelId, availableModels: err.availableModels,
    });
  }
  if (err?.code === 'missing_required_field') {
    return res.status(400).json({
      success: false, error: err.code, message: err.message,
      missing: err.missing, modelId: err.modelId,
    });
  }
  if (err?.code === 'unreachable_asset_url') {
    return res.status(400).json({
      success: false, error: err.code, message: err.message,
      fieldName: err.fieldName || null, url: err.url || null,
    });
  }
  console.error('[influencerController] unhandled error:', err);
  return res.status(500).json({
    success: false, error: 'influencer_internal_error', message: err?.message || 'Influencer request failed.',
  });
}

// ─── Legacy one-off generate ────────────────────────────────────────────────
//
// Pre-persona path — just renders an image from attrs without persisting a
// Persona. Still useful for "I just want a face" flows; keeps the UI
// compatible while we migrate callers to the persona endpoints.

async function generate(req, res) {
  const attrs = req.body?.attributes || {};
  const aspectRatio = req.body?.aspectRatio || '4:5';
  const modelId = req.body?.modelId || 'flux_pro';

  const prompt = influencerService.buildPromptFromAttrs(attrs, attrs.userPrompt);

  req.body = {
    ...req.body,
    mode: 'normal',
    prompt,
    description: prompt,
    aspectRatio,
    modelId,
    extras: {
      ...(req.body?.extras || {}),
      tool: req.body?.tool || 'ai_influencer',
      builderAttributes: attrs,
    },
  };

  return studioController.createImageGeneration(req, res);
}

// ─── Persona CRUD ────────────────────────────────────────────────────────────

async function createPersona(req, res) {
  try {
    const result = await influencerService.createPersona({ req, inputs: req.body || {} });
    setSessionCookieIfNew(res, result);

    return res.status(201).json({
      success: true,
      persona: serializePersona(result.persona),
      jobId:   result.jobId,
      sessionId: result.sessionId,
      creditsCost: result.creditsCost || 0,
      message: result.jobId
        ? `Hero render queued — ${result.creditsCost || 0} credits.`
        : 'Persona created from imported reference.',
    });
  } catch (err) {
    return handlePersonaError(res, err);
  }
}

async function listPersonas(req, res) {
  try {
    const owner = ownerFromReq(req);
    const limit = Math.min(100, parseInt(req.query.limit, 10) || 50);
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const personas = await influencerService.listPersonas(owner, { limit, offset });
    return res.status(200).json({
      success: true,
      personas: personas.map(serializePersona),
      count: personas.length,
    });
  } catch (err) {
    return handlePersonaError(res, err);
  }
}

async function getPersona(req, res) {
  try {
    const owner = ownerFromReq(req);
    const persona = await influencerService.getPersona(req.params.id, owner);
    if (!persona) {
      return res.status(404).json({ success: false, error: 'not_found', message: 'Persona not found.' });
    }
    const scenes = await influencerService.listScenes(req.params.id, owner, { limit: 20 });
    return res.status(200).json({
      success: true,
      persona: serializePersona(persona),
      scenes: scenes.map(serializeSceneJob),
    });
  } catch (err) {
    return handlePersonaError(res, err);
  }
}

async function finalizeHero(req, res) {
  try {
    const owner = ownerFromReq(req);
    const persona = await influencerService.finalizeHero(req.params.id, owner);
    if (!persona) {
      return res.status(404).json({ success: false, error: 'not_found', message: 'Persona not found.' });
    }
    return res.status(200).json({ success: true, persona: serializePersona(persona) });
  } catch (err) {
    return handlePersonaError(res, err);
  }
}

async function archivePersona(req, res) {
  try {
    const owner = ownerFromReq(req);
    const persona = await influencerService.archivePersona(req.params.id, owner);
    if (!persona) {
      return res.status(404).json({ success: false, error: 'not_found', message: 'Persona not found.' });
    }
    return res.status(200).json({ success: true, persona: serializePersona(persona) });
  } catch (err) {
    return handlePersonaError(res, err);
  }
}

async function generateScene(req, res) {
  try {
    const result = await influencerService.generateScene({
      req,
      personaId: req.params.id,
      inputs: req.body || {},
    });
    return res.status(201).json({
      success: true,
      ...result,
      message: result.kind === 'ad_set'
        ? `Scene set queued — ${result.numVariants} variants.`
        : `Scene queued — ${result.creditsCost} credits.`,
    });
  } catch (err) {
    return handlePersonaError(res, err);
  }
}

// ─── Serializers ─────────────────────────────────────────────────────────────
// Keep the wire format stable and defensive — consumers shouldn't see ids
// as ObjectIds, nor see raw Mongoose internals.

function serializePersona(p) {
  if (!p) return null;
  return {
    id:          (p._id || p.id)?.toString(),
    name:        p.name,
    kind:        p.kind,
    status:      p.status,
    attributes:  p.attributes || {},
    userPrompt:  p.userPrompt || '',
    heroImageUrl:     p.heroImageUrl || null,
    heroThumbnailUrl: p.heroThumbnailUrl || null,
    heroJobId:        p.heroJobId?.toString() || null,
    heroAssetId:      p.heroAssetId?.toString() || null,
    seedModelId:      p.seedModelId || null,
    sceneCount:       p.sceneCount || 0,
    tags:             p.tags || [],
    createdAt:        p.createdAt,
    updatedAt:        p.updatedAt,
    lastUsedAt:       p.lastUsedAt,
  };
}

function serializeSceneJob(j) {
  if (!j) return null;
  const out = j.output || {};
  return {
    jobId:     j._id?.toString() || j.id,
    status:    j.status,
    progress:  j.progress || 0,
    kind:      j.kind,
    prompt:    j.promptPipeline?.finalPrompt || j.userInputs?.prompt || '',
    imageUrl:  out.storedImageUrl || out.watermarkedUrl || out.cleanUrl || out.rawImageUrl || null,
    videoUrl:  out.storedVideoUrl || out.watermarkedUrl || out.rawVideoUrl || null,
    thumbnailUrl: out.thumbnailUrl || null,
    modelId:   j.modelId,
    createdAt: j.createdAt,
    assetId:   j.assetId?.toString() || null,
  };
}

module.exports = {
  // Legacy
  generate,
  // Persona CRUD
  createPersona,
  listPersonas,
  getPersona,
  finalizeHero,
  archivePersona,
  generateScene,
  // Exported for tests
  _helpers: { serializePersona, serializeSceneJob },
  // Legacy export: older tests + a handful of call-sites pass a single
  // object where `userPrompt` is embedded alongside the attribute fields.
  // The new service signature splits them (attrs, userPrompt). Adapt here
  // so both shapes keep working without forcing every caller to migrate.
  buildPrompt: (combined = {}) => {
    const { userPrompt, ...attrs } = combined || {};
    return influencerService.buildPromptFromAttrs(attrs, userPrompt || '');
  },
};
