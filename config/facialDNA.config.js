/**
 * facialDNA.config.js — DIRECTOR-LEVEL character identity config.
 *
 * Two jobs:
 *   1. A rich, validated CharacterDNA spec (what a director would lock on a
 *      callsheet) → renders to a stable identity block reused in EVERY shot.
 *   2. A small set of Gulf-relevant PRESET personas so the user can pick in one
 *      tap instead of filling 12 fields. (This is the Persona idea from the
 *      Creatify schema, but lightweight — a ref image + a DNA spec, no training.)
 *
 * NO avatar training, NO consent video, NO lipsync here. Identity is locked by
 * (a) one canonical ref image + (b) this immutable descriptor in the prompt.
 */

// ── controlled vocabularies (director config surfaces these as dropdowns) ──
const ENUMS = {
    gender:    ['woman', 'man', 'non-binary person'],
    ageRange:  ['early 20s', 'late 20s', 'early 30s', 'late 30s', '40s', '50s+'],
    build:     ['slim', 'average build', 'athletic', 'fuller figure'],
    // Gulf-relevant appearance options — keep RESPECTFUL + optional. Used only
    // when the user explicitly wants regional representation.
    presentation: [
      'modern Gulf professional, smart-casual',
      'hijab, elegant modest styling',
      'kandura / thobe',
      'abaya',
      'Western business casual',
      'streetwear casual',
    ],
    skinTone:  ['fair', 'light olive', 'warm olive', 'tan', 'deep'],
    hair:      ['short dark', 'shoulder-length dark', 'long dark', 'curly dark', 'covered (hijab)', 'short greying'],
    energy:    ['warm and trustworthy', 'energetic and upbeat', 'calm and authoritative', 'aspirational and polished'],
    setting:   ['clean studio', 'modern office', 'home bathroom', 'retail/clinic interior', 'outdoor city', 'cafe'],
  };
  
  // ── the spec a "director" fills (or a preset provides) ──
  function normalizeDNA(input = {}) {
    return {
      gender:       input.gender       || 'woman',
      age:          input.age          || 'late 20s',
      build:        input.build        || 'average build',
      presentation: input.presentation || 'modern Gulf professional, smart-casual',
      skinTone:     input.skinTone     || 'warm olive',
      hair:         input.hair         || 'shoulder-length dark',
      energy:       input.energy       || 'warm and trustworthy',
      setting:      input.setting      || 'clean studio',
      wardrobe:     input.wardrobe     || '',          // free text, optional
      distinguishing: input.distinguishing || '',      // stable freckles/glasses/etc
      faceRefUrl:   input.faceRefUrl   || null,         // the LOCKED image, if any
    };
  }
  
  // Immutable identity block — leads every presenter shot prompt.
  function renderIdentityBlock(dna) {
    const d = normalizeDNA(dna);
    const persona = [
      `the SAME ${d.age} ${d.gender}`,
      `${d.skinTone} skin`,
      `${d.hair} hair`,
      d.presentation,
      d.wardrobe && `wearing ${d.wardrobe}`,
      d.distinguishing,
      `${d.energy} energy`,
    ].filter(Boolean).join(', ');
  
    return (
      `CHARACTER LOCK — ${persona}. ` +
      `Identical face and person in every shot; do not change appearance, age, ` +
      `hairstyle, skin tone, or wardrobe between shots. Setting: ${d.setting}.`
    );
  }
  
  // ── one-tap presets (Gulf SME relevant). Each = a DNA spec; faceRefUrl is
  // filled when you have a locked portrait for that preset in R2. ──
  const PRESETS = {
    gulf_pro_woman:   { label: 'Gulf Professional (F)', gender: 'woman', age: 'late 20s', presentation: 'modern Gulf professional, smart-casual', skinTone: 'warm olive', hair: 'shoulder-length dark', energy: 'warm and trustworthy' },
    hijab_presenter:  { label: 'Hijab Presenter (F)',   gender: 'woman', age: 'early 30s', presentation: 'hijab, elegant modest styling', skinTone: 'light olive', hair: 'covered (hijab)', energy: 'calm and authoritative' },
    kandura_man:      { label: 'Kandura Presenter (M)', gender: 'man',   age: 'early 30s', presentation: 'kandura / thobe', skinTone: 'tan', hair: 'short dark', energy: 'calm and authoritative' },
    young_creator_f:  { label: 'Young Creator (F)',     gender: 'woman', age: 'early 20s', presentation: 'streetwear casual', skinTone: 'tan', hair: 'long dark', energy: 'energetic and upbeat', setting: 'home bathroom' },
    clinic_doctor:    { label: 'Clinician (F)',         gender: 'woman', age: 'late 30s', presentation: 'Western business casual', skinTone: 'fair', hair: 'shoulder-length dark', energy: 'calm and authoritative', setting: 'retail/clinic interior', wardrobe: 'white medical coat' },
  };
  
  function presetToDNA(presetKey, overrides = {}) {
    const base = PRESETS[presetKey] || PRESETS.gulf_pro_woman;
    const { label, ...spec } = base;
    return normalizeDNA({ ...spec, ...overrides });
  }
  
  module.exports = { ENUMS, PRESETS, normalizeDNA, renderIdentityBlock, presetToDNA };