'use strict';

/**
 * demoFlowController.js — the 60-second public demo
 *
 *   POST /api/v1/studio/demo
 *     body: { instagramHandle, category?, whatsappNumber?, language? }
 *
 *   1. Resolve the IG handle → profile (best-effort, falls back to handle).
 *   2. Pick the top 5 Arabic-ready templates (`promptBlueprintAr` set) for the
 *      inferred category, plus the same 5 templates rendered in English →
 *      10 jobs total.
 *   3. Enqueue all jobs on the same BullMQ queue the studio uses.
 *   4. Return job IDs + a single `demoSessionId` the frontend can poll.
 *
 * If a `whatsappNumber` is provided, the demo schedules a delivery: as each
 * job completes, the worker is responsible for sending it. We register the
 * delivery intent in `DemoSession.deliveries` so the worker (or a periodic
 * sweeper) can pick it up.
 *
 * This endpoint is intentionally rate-limited harder than the rest of the
 * studio because it spawns 10 generations per call.
 */

const { z } = require('zod');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');
const { Queue } = require('bullmq');

const StudioJob = require('../../model/schema/studioJob');
const DemoSession = require('../../model/schema/demoSession');
const { fetchProfile, cleanHandle } = require('../../services/instagramProfileService');

// ─── Queue (reused) ─────────────────────────────────────────────────────────

let _queue = null;
function getQueue() {
  if (!_queue) {
    const connection = { url: process.env.REDIS_URL || 'redis://localhost:6379' };
    _queue = new Queue('video-generation', {
      connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 100 },
      },
    });
  }
  return _queue;
}

// ─── Rate limit: 3 demos per hour per IP ────────────────────────────────────

const demoLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'demo_rate_limited', message: 'Try again in an hour.' },
});

// ─── Schema ─────────────────────────────────────────────────────────────────

const phoneSchema = z.string().regex(/^\+[1-9]\d{7,14}$/, 'Use E.164 format e.g. +971501234567');
const bodySchema = z.object({
  instagramHandle: z.string().min(1).max(120),
  category:        z.string().max(40).optional(),
  whatsappNumber:  phoneSchema.optional(),
  language:        z.enum(['en', 'ar', 'both']).default('both'),
});

// ─── Heuristic: infer category from IG bio ──────────────────────────────────

const CATEGORY_HINTS = [
  { match: /restaurant|kitchen|food|grill|burger|shawarma|cafe|coffee|bakery|sweet|dessert/i, category: 'restaurant' },
  { match: /perfume|oud|fragrance|attar/i, category: 'perfume' },
  { match: /salon|beauty|hair|nail|lash|brow/i, category: 'beauty' },
  { match: /gym|fitness|crossfit|yoga|pilates|trainer/i, category: 'gym' },
  { match: /real estate|property|broker|villa|apartment/i, category: 'realestate' },
  { match: /fashion|abaya|kandura|boutique|clothing|wear|atelier/i, category: 'fashion' },
  { match: /clinic|dental|aesthetic|skin/i, category: 'skincare' },
  { match: /cars?|auto|garage|detailing/i, category: 'automotive' },
];

function inferCategory(profile, override) {
  if (override) return override;
  const text = `${profile.fullName || ''} ${profile.biography || ''} ${profile.category || ''}`;
  for (const h of CATEGORY_HINTS) if (h.match.test(text)) return h.category;
  return 'general';
}

// ─── Template loader ────────────────────────────────────────────────────────

async function loadTopTemplates(category, count = 5) {
  const Tpl = mongoose.model('GenerationTemplate');
  // Prefer Qumak-original Arabic-ready templates for this category, fall back
  // to any Arabic-ready template, then any active template.
  const baseQuery = {
    isActive: true,
    'i18nPrompts.ar': { $exists: true, $ne: null, $ne: '' },
  };

  let templates = await Tpl.find({ ...baseQuery, bestCategories: category })
    .sort({ 'engagement.finalScore': -1, isFeatured: -1 })
    .limit(count)
    .lean();

  if (templates.length < count) {
    const extra = await Tpl.find({ ...baseQuery, _id: { $nin: templates.map(t => t._id) } })
      .sort({ 'engagement.finalScore': -1, isFeatured: -1 })
      .limit(count - templates.length)
      .lean();
    templates = templates.concat(extra);
  }

  if (templates.length < count) {
    const extra = await Tpl.find({ isActive: true, _id: { $nin: templates.map(t => t._id) } })
      .sort({ 'engagement.finalScore': -1 })
      .limit(count - templates.length)
      .lean();
    templates = templates.concat(extra);
  }

  return templates;
}

// ─── The flow ───────────────────────────────────────────────────────────────

async function startDemo(req, res) {
  const parsed = bodySchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: 'invalid_input', issues: parsed.error.issues });
  }
  const { instagramHandle, category, whatsappNumber, language } = parsed.data;

  try {
    const handle = cleanHandle(instagramHandle);
    if (!handle) return res.status(400).json({ success: false, error: 'invalid_handle' });

    // 1. Profile lookup (best-effort).
    const profile = await fetchProfile(handle);
    const finalCategory = inferCategory(profile, category);

    // 2. Templates.
    const templates = await loadTopTemplates(finalCategory, 5);
    if (!templates.length) {
      return res.status(503).json({
        success: false,
        error: 'no_templates_seeded',
        hint: 'Run `node scripts/seed_arabic_templates.js` first.',
      });
    }

    // 3. Enqueue 5 × (AR + EN) = up to 10 jobs.
    const sessionId = req.cookies?.qumak_session
      || req.headers['x-session-id']
      || `demo_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

    const langs = language === 'both' ? ['ar', 'en'] : [language];
    const queue = getQueue();
    const heroImage = profile.recentMediaUrls?.[0] || profile.profilePicUrl || null;
    const jobs = [];

    for (const tpl of templates) {
      for (const lang of langs) {
        const isImage = tpl.outputType === 'image';
        const job = await StudioJob.create({
          userId: req.user?._id || null,
          sessionId,
          category: finalCategory,
          kind: isImage ? 'image' : 'video',
          userInputs: {
            templateId: String(tpl._id),
            brandName:  profile.fullName || handle,
            description: (profile.biography || '').slice(0, 240),
            productImageUrl: heroImage,
            language: lang,
            locale: 'gulf',
            duration: tpl.defaultDuration,
            aspectRatio: tpl.aspectRatio,
            instagramHandle: handle,
            demo: true,
          },
          tier: 'free',
          isWatermarked: true,
          status: 'queued',
          statusMessage: lang === 'ar' ? 'في قائمة الانتظار...' : 'Queued for generation...',
        });

        await queue.add(
          isImage ? 'generate-image' : 'generate',
          { jobId: job._id.toString() },
          { priority: 3 }
        );

        jobs.push({ jobId: job._id, template: tpl.name, language: lang });
      }
    }

    // 4. Persist the demo session — also where WhatsApp delivery intent lives.
    const demoDoc = await DemoSession.create({
      sessionId,
      userId: req.user?._id || null,
      instagramHandle: handle,
      profile,
      category: finalCategory,
      language,
      whatsappNumber: whatsappNumber || null,
      deliveryStatus: whatsappNumber ? 'pending' : 'none',
      jobs,
    });

    return res.json({
      success: true,
      sessionId,
      demoId: demoDoc._id,
      profile: {
        handle: profile.handle,
        fullName: profile.fullName,
        followers: profile.followers,
        category: finalCategory,
        fallback: profile.fallback,
      },
      jobsCreated: jobs.length,
      jobs: jobs.map(j => ({ jobId: j.jobId, template: j.template, language: j.language })),
      pollUrl: `/api/v1/studio/demo/${demoDoc._id}/status`,
      whatsappDelivery: whatsappNumber ? 'pending' : 'disabled',
      etaSeconds: 60,
    });
  } catch (err) {
    console.error('[demoFlow] startDemo error:', err);
    return res.status(500).json({ success: false, error: 'server_error', message: err.message });
  }
}

async function getDemoStatus(req, res) {
  try {
    const demo = await DemoSession.findById(req.params.id).lean();
    if (!demo) return res.status(404).json({ success: false, error: 'demo_not_found' });

    const jobIds = demo.jobs.map(j => j.jobId);
    const jobs = await StudioJob.find({ _id: { $in: jobIds } })
      .select('_id status progress statusMessage kind output userInputs')
      .lean();

    const byId = new Map(jobs.map(j => [String(j._id), j]));
    const detailed = demo.jobs.map((j) => {
      const sj = byId.get(String(j.jobId));
      const isImage = sj?.kind === 'image';
      const watermarked = sj?.output?.watermarkedUrl;
      const fallback = isImage ? sj?.output?.storedImageUrl : sj?.output?.storedVideoUrl;
      const url = sj?.output?.cleanUrl || watermarked || fallback || null;
      return {
        jobId:    j.jobId,
        template: j.template,
        language: j.language,
        status:   sj?.status   || 'unknown',
        progress: sj?.progress || 0,
        message:  sj?.statusMessage || null,
        url,
        thumbnail: sj?.output?.thumbnailUrl || null,
      };
    });

    const completed = detailed.filter(d => d.status === 'completed').length;
    const failed    = detailed.filter(d => d.status === 'failed').length;

    res.json({
      success: true,
      demoId: demo._id,
      handle: demo.instagramHandle,
      jobsTotal: detailed.length,
      jobsCompleted: completed,
      jobsFailed: failed,
      whatsappDelivery: demo.deliveryStatus,
      jobs: detailed,
    });
  } catch (err) {
    console.error('[demoFlow] getDemoStatus error:', err);
    res.status(500).json({ success: false, error: 'server_error', message: err.message });
  }
}

module.exports = { startDemo, getDemoStatus, demoLimiter };
