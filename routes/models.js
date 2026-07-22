// 'use strict';

// /**
//  * /api/v1/models — what shows up in the Studio model picker.
//  *
//  * The frontend caches this list for the session. We deliberately strip the
//  * provider ID (`falModelId`) before sending — the client doesn't need to know
//  * which fal/replicate model we route to, and exposing it makes A/B switches
//  * leak in network tab.
//  *
//  * Filters:
//  *   ?kind=image|video      restrict to one output kind
//  *   ?plan=free|starter|pro|agency  hide gated models above the user's plan
//  */

// const express = require('express');
// const router = express.Router();
// const AiModel = require('../model/schema/aiModel');

// const PLAN_RANK = { free: 0, starter: 1, pro: 2, agency: 3 };

// router.get('/:id/manifest', async (req, res) => {
//   try {
//     const { modelId } = req.query;
//     const model = await AiModel.findOne({ id: modelId }).select('id schema').lean();
//     if (!model) {
//       return res.status(404).json({ success: false, error: 'model_not_found' });
//     }
//     return res.json({ success: true, id: model?.id, schema: model?.schema });
//   } catch (err) {
//     console.error('[routes/models] getSchema error:', err.message);
//     return res.status(500).json({ success: false, error: 'server_error' });
//   }
// });  
// router.get('/', async (req, res) => {
//   try {
//     const { kind, plan } = req.query;
    
//     const filter = { isActive: true };
//     if (kind && ['image', 'video', 'both'].includes(kind)) {
//       filter.kind = { $in: [kind, 'both'] };
//     }
    
//     const docs = await AiModel.find(filter)
//     .sort({ sortOrder: 1, label: 1 })
//     .lean();
//     console.log('docs', docs.length);
//     // Optionally hide rows above the user's plan. We do this in JS instead
//     // of Mongo so the comparison stays readable and the route can decay
//     // gracefully when `plan` is missing.
//     // const userRank = PLAN_RANK[String(plan || 'free').toLowerCase()] ?? 0;
//     // const filtered = docs.filter((m) => {
//     //   const rank = PLAN_RANK[String(m.minPlan || 'free').toLowerCase()] ?? 0;
//     //   return rank <= userRank || rank === 0;
//     // });
//     const items = docs.map((m) => ({
//       id: m?.id,
//       label: m?.label,
//       shortLabel: m?.shortLabel || m?.label,
//       description: m?.description,
//       kind: m?.kind,
//       logoUrl: m?.logoUrl,
//       badge: m?.badge,
//       minPlan: m?.minPlan,
//       isDefault: m?.isDefault,
//       supportsReferenceImage: m?.supportsReferenceImage,
//       supportsAudio: m?.supportsAudio,
//       supportedAspectRatios: m?.supportedAspectRatios,
//       supportedDurations: m?.supportedDurations,
//       // Full capability manifest — frontend uses this to render
//       // model-specific controls (end-frame slot, motion slider, …).
//       // Deliberately exclude `providerParamMap` from the wire format
//       // because it's an implementation detail of backend routing.
//       capabilities: m?.capabilities
//         ? {
//             supportsEndFrame:       !!m?.capabilities?.supportsEndFrame,
//             supportsNegativePrompt: !!m?.capabilities?.supportsNegativePrompt,
//             supportsSeed:           !!m?.capabilities?.supportsSeed,
//             supportsMotionControl:  !!m?.capabilities?.supportsMotionControl,
//             supportsMultiShot:      !!m?.capabilities?.supportsMultiShot,
//             supportedResolutions:   m?.capabilities?.supportedResolutions || [],
//             requiredFields:         m?.capabilities?.requiredFields || [],
//           }
//         : null,
//       pricing: {
//         creditsPerImage: m?.creditsPerImage,
//         creditsPerSecondVideo: m?.creditsPerSecondVideo,
//         baseCreditsForVideo: m?.baseCreditsForVideo,
//       },
//     }));
//     console.log('items', items.length);
//     return res.json({ success: true, items });
//   } catch (err) {
//     console.error('[routes/models] list error:', err.message);
//     return res.status(500).json({ success: false, error: 'server_error' });
//   }
// });

// module.exports = router;

'use strict';

/**
 * routes/models.js — UPDATED
 *
 * Adds /:id/manifest endpoint with FULL inputSlots + constraints (frontend
 * ComposerRouter reads this).
 *
 * Keeps GET / lightweight (no inputSlots) — picker only needs metadata.
 */

const express = require('express');
const router = express.Router();
const AiModel = require('../model/schema/aiModel');
const dispatcher = require('../services/models/dispatcher');

// GET /api/v1/models/:id/manifest
// Full manifest for one model — what the frontend ComposerRouter reads.
router.get('/:id/manifest', async (req, res) => {
  try {
    const manifest = await dispatcher.getManifest(req.params.id);
    if (!manifest) {
      return res.status(404).json({ success: false, error: 'model_not_found' });
    }

    // Pull pricing + plan info for the composer footer
    const meta = await AiModel.findOne({ id: req.params.id, isActive: true })
      .select('label kind minPlan creditsPerImage creditsPerSecondVideo baseCreditsForVideo supportedAspectRatios supportedDurations badge logoUrl')
      .lean();

    return res.json({
      success: true,
      id: manifest.id,
      label: meta?.label,
      kind: manifest.kind,
      minPlan: meta?.minPlan,
      badge: meta?.badge,
      logoUrl: meta?.logoUrl,
      manifest: {
        uiVariant: manifest.uiVariant,
        inputSlots: manifest.inputSlots,
        constraints: manifest.constraints,
        promptTokens: manifest.promptTokens,
        audio: manifest.audio,
      },
      pricing: {
        creditsPerImage: meta?.creditsPerImage,
        creditsPerSecondVideo: meta?.creditsPerSecondVideo,
        baseCreditsForVideo: meta?.baseCreditsForVideo,
      },
      compatibility: {
        supportedAspectRatios: meta?.supportedAspectRatios || [],
        supportedDurations: meta?.supportedDurations || [],
      },
    });
  } catch (err) {
    console.error('[routes/models] manifest error:', err.message);
    return res.status(500).json({ success: false, error: 'server_error' });
  }
});


router.get('/all', async (req, res) => {
  try {
    const models = await AiModel.find({ isActive: true })
      .select('id label kind minPlan creditsPerImage creditsPerSecondVideo baseCreditsForVideo supportedAspectRatios supportedDurations badge logoUrl')
      .lean();

    const results = await Promise.all(
      models.map(async (meta) => {
        try {
          const manifest = await dispatcher.getManifest(meta.id);
          if (!manifest) return null;

          return {
            success: true,
            id: manifest.id,
            label: meta.label,
            kind: manifest.kind,
            minPlan: meta.minPlan,
            badge: meta.badge,
            logoUrl: meta.logoUrl,
            manifest: {
              uiVariant: manifest.uiVariant,
              inputSlots: manifest.inputSlots,
              constraints: manifest.constraints,
              promptTokens: manifest.promptTokens,
              audio: manifest.audio,
            },
            pricing: {
              creditsPerImage: meta.creditsPerImage,
              creditsPerSecondVideo: meta.creditsPerSecondVideo,
              baseCreditsForVideo: meta.baseCreditsForVideo,
            },
            compatibility: {
              supportedAspectRatios: meta.supportedAspectRatios || [],
              supportedDurations: meta.supportedDurations || [],
            },
          };
        } catch (err) {
          console.error(`[routes/models] manifest error for ${meta.id}:`, err.message);
          return null;
        }
      })
    );

    return res.json({
      success: true,
      models: results.filter(Boolean), 
    });

  } catch (err) {
    console.error('[routes/models] all models error:', err.message);
    return res.status(500).json({ success: false, error: 'server_error' });
  }
});

// GET /api/v1/models — picker list
router.get('/', async (req, res) => {
  try {
    const { kind } = req.query;
    const filter = { isActive: true };
    if (kind && ['image', 'video', 'both'].includes(kind)) {
      filter.kind = { $in: [kind, 'both'] };
    }

    const docs = await AiModel.find(filter).sort({ sortOrder: 1, label: 1 }).lean();

    const items = docs.map(m => {
      const caps = m.capabilities || {};
      return {
        id: m.id,
        label: m.label,
        shortLabel: m.shortLabel || m.label,
        description: m.description,
        kind: m.kind,
        videoVariant: m.videoVariant,
        logoUrl: m.logoUrl,
        badge: m.badge,
        minPlan: m.minPlan,
        isDefault: m.isDefault,
        uiVariant: caps.uiVariant || null,
        supportsReferenceImage: m.supportsReferenceImage || false,
        supportsCharacterLock: m.supportsCharacterLock || false,
        supportsAudio: m.supportsAudio || false,
        supportedAspectRatios: m.supportedAspectRatios || [],
        supportedDurations: m.supportedDurations || [],
        capabilities: {
          uiVariant: caps.uiVariant || null,
          supportsEndFrame: caps.supportsEndFrame ?? ['i2v_with_end','ref2v_elements'].includes(caps.uiVariant),
          supportsNegativePrompt: caps.supportsNegativePrompt ?? false,
          supportsSeed: caps.supportsSeed ?? false,
          supportsMotionControl: caps.supportsMotionControl ?? false,
          supportsMultiShot: caps.supportsMultiShot ?? ['multi_shot','ref2v_elements'].includes(caps.uiVariant),
          supportedResolutions: caps.supportedResolutions || [],
          requiredFields: caps.requiredFields || [],
        },
        pricing: {
          creditsPerImage: m.creditsPerImage,
          creditsPerSecondVideo: m.creditsPerSecondVideo,
          baseCreditsForVideo: m.baseCreditsForVideo,
        },
        manifest: {
          uiVariant: caps.uiVariant || null,
          inputSlots: caps.inputSlots || [],
          constraints: caps.constraints || [],
          promptTokens: caps.promptTokens || null,
          audio: caps.audio || null,
        },
      };
    });

    return res.json({ success: true, items });
  } catch (err) {
    console.error('[routes/models] list error:', err.message);
    return res.status(500).json({ success: false, error: 'server_error' });
  }
});

module.exports = router;