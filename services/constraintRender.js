'use strict';

/**
 * Single source of truth for Director-rail constraint → prompt clause rendering.
 * Used by promptBuilder_v2, intentEngine (universal path), and tests.
 *
 * IMPORTANT: Keep scalar option IDs in sync with
 * qumak-frontend/src/data/constraintVocab.ts (CONSTRAINT_OPTIONS).
 */

// ── Cinematic constraint vocabulary ─────────────────────────────────────────

const CONSTRAINT_VOCAB = {
  cameraAngle: {
    eye_level: 'eye-level camera angle',
    low_angle: 'low-angle hero shot framing the subject from below',
    high_angle: 'high-angle top-down view',
    dutch: 'slight Dutch tilt for cinematic tension',
    overhead: 'pure overhead flat-lay composition',
    over_shoulder: 'over-the-shoulder framing showing presenter pov',
    birds_eye: 'bird\'s-eye top-down view',
    pov: 'first-person POV framing',
    tracking: 'tracking shot following the action',
    orbit: 'smooth orbital framing around the subject',
  },
  lighting: {
    soft_natural: 'soft naturalistic window light, gentle wrap-around shadows',
    hard_studio: 'hard directional studio key light with crisp shadow edges',
    golden_hour: 'warm golden-hour rim light, long honey-coloured shadows',
    high_key: 'high-key bright airy lighting, almost no shadow',
    low_key_moody: 'low-key moody lighting, deep negative space, single rim accent',
    neon_night: 'neon night lighting, magenta and cyan rim accents',
    ramadan_lantern: 'warm Ramadan lantern glow with soft gold falloff',
    natural: 'natural ambient light, balanced and untreated',
    studio_softbox: 'studio softbox lighting, even and flattering, minimal shadow transitions',
    blue_hour: 'cool blue-hour dusk lighting with deep azure gradients',
    low_key: 'low-key moody lighting with dominant shadows',
    rim_light: 'strong rim light separating subject from background',
    backlit: 'fully backlit silhouette with a soft glow halo',
    neon: 'neon-drenched lighting in saturated magenta/cyan',
    cinematic: 'cinematic key/fill/rim three-point lighting',
  },
  shotType: {
    extreme_close: 'extreme macro close-up, pore- and texture-level detail',
    close_up: 'tight close-up framing the product face-on',
    medium: 'medium shot, product and presenter in frame',
    wide: 'wide establishing shot with environmental context',
    product_only: 'isolated product shot on clean surface',
    extreme_closeup: 'extreme macro close-up, pore- and texture-level detail',
    closeup: 'tight close-up framing the subject face-on',
    medium_wide: 'medium-wide framing, subject plus surrounding context',
    extreme_wide: 'extreme-wide framing dominated by the environment',
    aerial: 'aerial drone-style framing from high altitude',
    macro: 'macro lens detail shot with shallow depth of field',
  },
  motion: {
    static: 'locked-off camera, no motion',
    slow_push: 'slow cinematic push-in toward subject',
    slow_pull: 'slow pull-back revealing context',
    orbit: 'smooth 90-degree orbit around the subject',
    handheld: 'authentic handheld UGC motion, slight natural shake',
    dolly_left: 'smooth dolly-left tracking motion',
    parallax: 'parallax slider with foreground depth',
    slow_pan: 'slow horizontal pan revealing the scene',
    fast_pan: 'fast horizontal pan, energetic and deliberate',
    tilt: 'vertical tilt motion',
    dolly_in: 'smooth dolly-in push toward the subject',
    dolly_out: 'smooth dolly-out pullback away from the subject',
    gimbal: 'silky gimbal glide with fluid trajectory',
    whip_pan: 'sharp whip-pan transition',
    crash_zoom: 'aggressive crash-zoom toward the subject',
  },
  pace: {
    languid: 'languid premium pacing, ~1 cut every 4 seconds',
    normal: 'standard ad pacing, 2-3 cuts every 5 seconds',
    snappy: 'snappy TikTok-native pacing with quick cuts and beats',
    slow: 'measured, unhurried pacing',
    medium: 'balanced mid-tempo pacing',
    fast: 'fast, energetic cut rhythm',
    frenetic: 'frenetic high-energy pacing with cuts on every beat',
  },
  mood: {
    warm: 'warm, inviting emotional register',
    cold: 'cold, detached emotional register',
    hopeful: 'hopeful, uplifting emotional tone',
    tense: 'tense, suspenseful mood',
    playful: 'playful, light-hearted mood',
    melancholic: 'melancholic, introspective mood',
    triumphant: 'triumphant, victorious energy',
    serene: 'serene, calm, meditative mood',
    confident: 'confident, self-assured energy',
    dramatic: 'dramatic, high-stakes emotional register',
  },
  tone: {
    luxury: 'luxury tone — restrained, premium, aspirational',
    premium: 'premium tone — polished but approachable',
    playful: 'playful tone — bold colour, kinetic energy',
    bold: 'bold tone — high contrast, assertive framing',
    minimalist: 'minimalist tone — clean negative space, understated',
    editorial: 'editorial tone — magazine-grade, intentional composition',
    documentary: 'documentary tone — authentic, unstaged feel',
    raw: 'raw tone — unpolished, candid, grainy',
    futuristic: 'futuristic tone — tech-forward, clean metallic palette',
    nostalgic: 'nostalgic tone — vintage film grain, muted palette',
  },
  timeOfDay: {
    dawn: 'dawn, pre-sunrise, cool-to-warm gradient sky',
    morning: 'bright morning light, clear and energetic',
    noon: 'harsh noon overhead sun',
    afternoon: 'warm afternoon light with long soft shadows',
    golden_hour: 'golden hour, warm honey light, long shadows',
    dusk: 'dusk, last remnants of colour in the sky',
    blue_hour: 'blue hour, deep azure ambient light',
    night: 'night scene, deep shadow with selective illumination',
    midnight: 'midnight scene, near-total darkness with rim highlights',
  },
  environment: {
    studio: 'controlled studio environment, clean backdrop',
    outdoor: 'outdoor environment, natural surroundings',
    indoor: 'interior environment, architectural context',
    urban: 'urban streetscape environment',
    nature: 'natural landscape environment',
    minimal: 'minimal abstract environment, deliberate negative space',
    lifestyle: 'authentic lifestyle environment, real-world context',
    desert: 'desert landscape, warm sand tones',
    marina: 'Dubai Marina setting, waterfront architecture',
    souk: 'traditional souk setting, intricate arabesque details',
  },
};

const STYLE_TAG_VOCAB = {
  cinematic: 'cinematic',
  editorial: 'editorial',
  documentary: 'documentary',
  ugc: 'UGC-style authenticity',
  high_fashion: 'high-fashion editorial',
  hyper_realistic: 'hyper-realistic detail',
  grainy_film: 'grainy 35mm film texture',
  clean_digital: 'clean digital rendering',
  analog: 'analog film look',
  vhs: 'VHS-era retro texture',
  dreamlike: 'dreamlike soft focus',
  hard_surface: 'hard-surface product cleanliness',
};

const CONSTRAINT_AXES = [
  'cameraAngle',
  'shotType',
  'lighting',
  'timeOfDay',
  'environment',
  'motion',
  'pace',
  'mood',
  'tone',
];

/**
 * Render constraints into Direction / Style clauses (same format as template path).
 */
function renderConstraintsClause(constraints = {}) {
  if (!constraints || typeof constraints !== 'object') return '';

  const fragments = [];
  for (const axis of CONSTRAINT_AXES) {
    const key = constraints[axis];
    const v = key && CONSTRAINT_VOCAB[axis]?.[key];
    if (v) fragments.push(v);
  }

  const styleFragments = [];
  if (Array.isArray(constraints.styleTags)) {
    for (const tag of constraints.styleTags) {
      const v = STYLE_TAG_VOCAB[tag];
      if (v) styleFragments.push(v);
    }
  }

  let out = '';
  if (fragments.length) out += `\nDirection: ${fragments.join('; ')}.`;
  if (styleFragments.length) out += `\nStyle: ${styleFragments.join(', ')}.`;
  return out;
}

module.exports = {
  renderConstraintsClause,
  CONSTRAINT_VOCAB,
  STYLE_TAG_VOCAB,
  CONSTRAINT_AXES,
};
