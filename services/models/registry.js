// services/models/registry.js — new family registry
const FAMILIES = {
  kling_o3: {
    label: 'Kling O3',
    shortLabel: 'Kling O3',
    logoUrl: 'https://.../kling.png',
    description: 'Cinematic 720p–4K video with reference and multi-shot.',
    supportedTiers: [
      { id: '4k', label: '4K', creditsPerSec: 6, supports: ['t2v','i2v','ref2v'] },
      { id: 'pro',      label: 'Pro',      creditsPerSec: 4, supports: ['t2v','i2v','ref2v','v2v_edit','v2v_ref'] },
      { id: 'standard', label: 'Standard', creditsPerSec: 2, supports: ['t2v','i2v','ref2v','v2v_edit','v2v_ref'] },
    ],
    defaultTier: 'pro',
    slugTemplate: 'fal-ai/kling-video/o3/{tier}/{modeSlug}',
    modeSlugMap: {
      t2v:       'text-to-video',
      i2v:       'image-to-video',
      ref2v:     'reference-to-video',
      v2v_edit:  'video-to-video/edit',
      v2v_ref:   'video-to-video/reference',
    },
  },
  seedance_2_0: {
    label: 'Seedance 2.0',
    supportedTiers: [
      { id: 'fast',    label: 'Fast',    creditsPerSec: 2, supports: ['t2v','i2v','ref2v'] },
      { id: 'regular', label: 'Quality', creditsPerSec: 4, supports: ['t2v','i2v','ref2v'] },
    ],
    defaultTier: 'fast',
    slugTemplate: 'bytedance/seedance-2.0/{tierPath}{modeSlug}',
    // tierPath is "" for regular, "fast/" for fast — handled in resolveSlug
    modeSlugMap: { t2v: 'text-to-video', i2v: 'image-to-video', ref2v: 'reference-to-video' },
  },
};

function resolveSlug(family, mode, tier) {
  const fam = FAMILIES[family];
  if (!fam) throw new Error(`unknown_family:${family}`);
  const tierConf = fam.supportedTiers.find(t => t.id === tier);
  if (!tierConf) throw new Error(`unknown_tier:${family}:${tier}`);
  if (!tierConf.supports.includes(mode)) {
    throw new Error(`tier_does_not_support_mode:${family}/${tier}/${mode}`);
  }
  const modeSlug = fam.modeSlugMap[mode];
  // Family-specific path quirks (Seedance puts "fast/" inside the path)
  const tierPath = family === 'seedance_2_0'
    ? (tier === 'fast' ? 'fast/' : '')
    : tier;
  return fam.slugTemplate
    .replace('{tier}', tierPath)
    .replace('{tierPath}', tierPath)
    .replace('{modeSlug}', modeSlug);
}

module.exports = { FAMILIES, resolveSlug };