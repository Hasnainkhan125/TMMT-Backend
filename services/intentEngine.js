'use strict';

/**
 * intentEngine.js
 *
 * The single intelligence layer that replaces:
 *   - adBrain.buildAdPrompt (pipe-separated label soup)
 *   - promptEnhancer.enhancePrompt (serial Haiku call on every request)
 *   - the z.enum(['gym','realestate',...]) prison
 *   - MODE_DIRECTIONS / NEUTRAL_DNA / CATEGORY_DNA split-brain
 *
 * ONE call to classifyIntent() before enqueue.
 * ONE call to synthesizePrompt() to build the final string.
 * No hardcoded enum anywhere in this file.
 *
 * Design invariants:
 *   1. User's words are always the first clause in the final prompt.
 *      Diffusion models attend harder to earlier tokens. Scene goes first.
 *   2. No pipe characters in the prompt output. Ever.
 *   3. classifyIntent() always resolves — Haiku failure → deterministic fallback.
 *   4. Domain DNA is a default, not a prison. Unknown domains get a
 *      "premium commercial" baseline and the user's intent carries it.
 *   5. Regional layer is additive, never overrides the user's described scene.
 *      Default audience is global; pass `locale` to override (gulf, india,
 *      china, uk, us, europe, russia, etc).
 */

const Anthropic = require('@anthropic-ai/sdk');
const { renderConstraintsClause } = require('./constraintRender');

const MODEL    = 'claude-haiku-4-5-20251001';
const TIMEOUT  = 5000; 

// ─── 1. INTENT SCHEMA ────────────────────────────────────────────────────────
//
// This is what Haiku returns. Every downstream system reads from this object.
// No other fields are read from user input after this point.
//
// intent_type:      what the user is actually trying to do
// domain:           the subject matter (open string — no enum)
// audience:         who will see the output
// style_register:   the visual/tonal world (open string)
// is_commercial:    true = ad/business, false = pure creative/personal
// gulf_relevant:    true = apply Gulf cultural modifiers / Gulf-only seasonal
//                   layer (Ramadan, Eid, UAE/KSA national days). For non-gulf
//                   locales we still apply a region-specific mod from
//                   `regionMods`, just not the Gulf seasonal layer.
// output_kind:      image | video | copy | chat
// confidence:       0-1 — if < 0.5 we use the deterministic path more heavily

/*
Intent types (not an enum — just documentation):
  creative_image    — "generate an image of X"
  creative_video    — "make a video of X"
  ad_image          — "ad for my restaurant"
  ad_video          — "reel for my skincare brand"
  director          — "cinematic scene, lens grammar, film references"
  url_to_ad         — "here's my product URL, make an ad"
  brand_kit         — has brand colors/fonts, wants consistent output
  chat              — question, no generation needed
  upscale           — image input, wants higher res
  restyle           — image input, wants style transfer
*/

// ─── 2. DOMAIN DNA ───────────────────────────────────────────────────────────
//
// Open-ended. Unknown domains fall through to 'default'.
// Each entry: { scene, lighting, grade, gulfMod, neg }
//   • `gulfMod` is the legacy per-domain Gulf-flavored modifier. We keep it
//     verbatim for backward-compat with workers/tests that still read it
//     directly. At init time we mirror it into `regionMods.gulf` so the new
//     locale-aware lookup path can find it.
//   • `regionMods[locale]` is the canonical per-locale modifier. Locales
//     without a per-domain entry fall back to `DEFAULT_REGION_MODS[locale]`,
//     which itself falls back to `DEFAULT_REGION_MODS.global`.
// These are FRAGMENTS that slot into the final prompt — not the full prompt.

const DOMAIN_DNA = {
  // ── F&B ──────────────────────────────────────────────────────────────────
  restaurant:    { scene:'warm restaurant interior, plated dishes with steam, candlelit table', lighting:'warm amber overhead pendants, candlelight rim', grade:'deep warm tones, film emulsion feel', gulfMod:'Arabic mezze spread, saffron and burnt amber palette, Emirates hospitality warmth', neg:'fluorescent, fast food, plastic, cold' },
  cafe:          { scene:'specialty coffee bar, latte art close-up, morning light', lighting:'soft window key, dust particles in beam', grade:'warm creamy tones', gulfMod:'Gulf specialty cafe, Arabica origin story, warm neutral palette', neg:'chain cafe, cold, generic' },
  food:          { scene:'food photography, textural close-up, styled plating', lighting:'soft north-facing window light, bounce fill', grade:'rich saturated food tones', gulfMod:'halal context, family feast aesthetic, generous portions', neg:'plastic, cold, unstyled' },
  bakery:        { scene:'artisan bread on wooden surface, steam rising, flour dust', lighting:'golden morning side-light', grade:'warm honey tones', gulfMod:'Gulf khobz and ma\'amoul, date-gold palette', neg:'supermarket, plastic wrapped, cold' },

  // ── Fashion & Beauty ─────────────────────────────────────────────────────
  fashion:       { scene:'editorial fashion, model off-center, strong shadow play', lighting:'hard directional key, single source', grade:'cool neutrals or deep contrast', gulfMod:'Gulf modest fashion aesthetic, heavyweight fabric texture, minimal palette', neg:'busy background, poor posture, cheap fabric' },
  streetwear:    { scene:'urban street fashion, candid editorial, raw location', lighting:'flat on-camera flash, overexposed background', grade:'lo-fi, desaturated, grainy', gulfMod:'Dubai street context, DIFC or Al Quoz backdrop', neg:'studio, posed, polished' },
  luxury_fashion:{ scene:'high fashion editorial, architectural setting, sculptural garment', lighting:'clean studio, single large softbox', grade:'bleached, high contrast, Celine-palette', gulfMod:'Gulf luxury boutique context, marble and brass', neg:'busy, casual, chain store' },
  beauty:        { scene:'beauty close-up, dewy skin, macro product detail', lighting:'soft diffused key, ring light accent', grade:'warm clinical, creamy whites', gulfMod:'halal beauty, warm champagne undertones, Gulf cosmetics aesthetic', neg:'harsh shadows, pores, clinical cold' },
  skincare: { 
    scene:'skincare product on clean surface, texture macro, ingredient reveal',
    lighting:'ultra-soft diffused box, no hard shadows',
    grade:'crisp clean whites with warm highlight',
    gulfMod:'clinical luxury, premium beauty shelf',
    neg:'cluttered, messy, cold blue'
  },
  haircare:      { scene:'hair product, silky texture emphasis, movement', lighting:'soft wrap light, rim on hair', grade:'warm neutrals, silky sheen', gulfMod:'Gulf hair care premium, warm humidity-free aesthetic', neg:'dry, static, low production' },
  perfume:       { scene:'perfume bottle in darkness, tendrils of smoke, incense glow', lighting:'single candle source, deep chiaroscuro, amber highlights', grade:'luxury_warm, deep amber-black', gulfMod:'oud and bakhoor aesthetic, arabesque shadow patterns, Al-Khaleej soul', neg:'bright white, cheap, clinical, generic' },
  jewelry:       { scene:'jewelry on black velvet, macro crystal detail, facet sparkle', lighting:'cold precise studio, rim from above', grade:'cold high contrast, jewel-tone accents', gulfMod:'gold souk aesthetic, 22K warmth, premium Dubai retail', neg:'plastic, cheap clasp, unclear detail' },

  // ── Real Estate & Architecture ───────────────────────────────────────────
  realestate:    { scene:'luxury interior, floor-to-ceiling glass, golden hour pour', lighting:'golden hour warm through windows, interior accent', grade:'champagne and warm white, luxury hospitality', gulfMod:'Dubai glass towers, Marina or Downtown skyline context, marble lobby', neg:'grey sky, empty unfurnished, cheap fittings' },
  architecture:  { scene:'architectural exterior, geometric composition, material detail', lighting:'blue hour or golden hour, dramatic sky', grade:'crisp professional, magazine-architectural', gulfMod:'UAE premium finish, desert-modern aesthetic, Vision 2030 context', neg:'ugly sky, bad angle, distortion' },
  interior:      { scene:'interior design, curated furniture, natural light', lighting:'north-facing ambient, task lighting accents', grade:'warm neutrals, editorial interiors', gulfMod:'Gulf hospitality warmth, Arabic geometric pattern detail', neg:'cluttered, cheap, dark' },

  // ── Automotive ───────────────────────────────────────────────────────────
  automotive:    { scene:'car on location, motion blur implied, detail shots', lighting:'golden hour rim, paint reflections, desert glow', grade:'rich saturated, car-magazine finish', gulfMod:'UAE desert or Jebel Jais backdrop, falcon aesthetic, premium Gulf market', neg:'dirty, parked lot, flat overcast' },

  // ── Fitness & Wellness ───────────────────────────────────────────────────
  gym:           { scene:'dark premium gym interior, athlete mid-lift, chalk dust particles', lighting:'hard directional side light, teal-orange grade', grade:'cinematic_teal_orange, high contrast', gulfMod:'UAE elite fitness club, polished concrete, iron silhouettes', neg:'outdoor park, bright daylight, casual' },
  wellness:      { scene:'spa or wellness space, serene atmosphere, natural materials', lighting:'soft diffused, candle accents, earth tones', grade:'warm earth neutrals', gulfMod:'Gulf luxury spa, rose and oud aromatherapy context', neg:'clinical, cold, hotel generic' },
  sport:         { scene:'athletic action, peak-effort moment, sports environment', lighting:'stadium lights or golden outdoor, dynamic', grade:'vivid sports broadcast contrast', gulfMod:'UAE sports culture, desert marathon or urban athletics', neg:'static, casual, poor effort' },

  // ── Tech & SaaS ──────────────────────────────────────────────────────────
  saas:          { scene:'modern workspace, laptop in use, team collaboration', lighting:'screen-glow blue-white, natural window fill', grade:'clean professional, screen-accurate', gulfMod:'Dubai DIFC office, UAE skyline implied, Vision 2030 context', neg:'cluttered desk, outdated hardware, empty office' },
  tech:          { scene:'consumer electronics, product on dark surface, edge detail macro', lighting:'single rim, precise shadow, product clean', grade:'cold clean precision', gulfMod:'Dubai tech retail premium, GITEX aesthetic', neg:'plastic feel, dusty, generic' },
  app:           { scene:'app interface on device, hand interaction, natural context', lighting:'ambient lifestyle, screen-visible', grade:'fresh clean consumer', gulfMod:'Arabic UI visible, Gulf user context', neg:'stock photo hand, isolated device, white void' },

  // ── Professional Services ─────────────────────────────────────────────────
  service:       { scene:'professional environment, confident team, modern office', lighting:'daylight-fill, trust-building warmth', grade:'clean professional', gulfMod:'Dubai corporate tower, Gulf business culture, Emirati business attire visible', neg:'casual, messy, unprofessional' },
  legal:         { scene:'law office or courtroom aesthetic, books, authority', lighting:'warm professional interior, dignity', grade:'warm neutral authority', gulfMod:'UAE legal context, DIFC courts aesthetic', neg:'casual, cluttered, cheap' },
  medical:       { scene:'medical setting, clean clinical, professional staff', lighting:'clinical bright, clean whites', grade:'clinical luxury, no sterile cold', gulfMod:'Dubai healthcare premium, private clinic aesthetic', neg:'scary, poor lighting, outdated equipment' },
  education:     { scene:'learning environment, engaged students, modern facility', lighting:'natural abundant daylight, inclusive warmth', grade:'optimistic warm', gulfMod:'UAE university context, Vision 2030 education narrative', neg:'boring, lecture-hall-empty, dated' },

  // ── Entertainment & Creative ──────────────────────────────────────────────
  music:         { scene:'artist or instrument, moody creative space, performance energy', lighting:'stage or practise-room dramatic', grade:'dark atmospheric', gulfMod:'Gulf music and art scene, Arabic fusion context', neg:'stock, generic, over-lit' },
  film:          { scene:'cinematic film scene, story-driven moment, character in environment', lighting:'motivated by scene — practical sources, naturalistic', grade:'anamorphic, film grain, period-accurate', gulfMod:'Gulf film context if relevant, Dubai or Abu Dhabi location', neg:'video look, flat, newscaster frame' },
  art:           { scene:'artwork or installation, gallery context or in-situ', lighting:'gallery spot or natural ambient', grade:'faithful reproduction, clean neutral', gulfMod:'Gulf contemporary art scene, Louvre Abu Dhabi aesthetic', neg:'glare, distortion, over-saturated' },
  gaming:        { scene:'game character or environment, key art composition', lighting:'dramatic fantasy or sci-fi motivated', grade:'vivid saturated key art', gulfMod:'MENA gaming market, Arabic script visible where relevant', neg:'low poly, amateur, stock' },
  events:        { scene:'event space or moment, energy and atmosphere', lighting:'venue lighting, crowd warmth', grade:'event photography, editorial', gulfMod:'Gulf luxury events, MICE market Dubai, premium hospitality aesthetic', neg:'empty venue, bad angle, flash-flat' },

  // ── E-commerce & Product ─────────────────────────────────────────────────
  ecommerce:     { scene:'product on clean surface, hero shot, detail callouts', lighting:'multi-source studio, crisp shadow', grade:'clean commercial white or marble', gulfMod:'Dubai e-commerce premium, clean Arabic market shelf aesthetic', neg:'busy background, cluttered, amateur' },
  product:       { scene:'product hero, rotating or still, premium surface', lighting:'three-point studio, specular highlight', grade:'magazine-commercial, sharp critical focus', gulfMod:'Gulf premium retail context, mall-anchor brand feel', neg:'cheap, prop-heavy, text overlay' },

  // ── Catch-all — not a failure, a baseline ────────────────────────────────
  default:       { scene:'', lighting:'motivated cinematic lighting, intentional shadow', grade:'photorealistic, magazine-grade', gulfMod:'premium Gulf commercial aesthetic', neg:'watermark, blurry, distorted, amateur' },
};

// ─── 2b. REGION MODS ─────────────────────────────────────────────────────────
//
// Per-locale modifier strings. The previous version of this engine only spoke
// "gulf" — every domain entry above carried a hand-written `gulfMod`. We now
// support a small set of locales out of the box; the worldwide default is
// `global`. Callers select via `inputs.locale` (or `intent.locale`); when no
// locale is provided we default to 'global'.
//
// We keep the per-domain Gulf strings (they're rich and well-tuned) by
// mirroring `dna.gulfMod` → `dna.regionMods.gulf` at init. Other locales
// don't get per-domain text — they use the short `DEFAULT_REGION_MODS[locale]`
// neutral string. That's intentional: for non-Gulf runs we want the prompt
// to stay regionally neutral so the user's brand DNA + scene carry the look.

const DEFAULT_REGION_MODS = {
  global: 'international audience, neutral premium tone, English-first, broadly recognizable visual language',
  gulf:   'premium Gulf commercial aesthetic',
  india:  'India-aware audience, vibrant warm palette, pan-Indian cultural cues, English/Hinglish-friendly',
  china:  'mainland China audience, refined modern luxury, simplified Chinese typography aware',
  uk:     'UK audience, understated editorial tone, dry sophistication, British English',
  us:     'US audience, confident bold pacing, mainstream American sensibility',
  europe: 'continental European audience, design-led minimal aesthetic, multilingual sensibility',
  russia: 'Russian-speaking audience, dramatic high-contrast aesthetic, Cyrillic-aware typography',
};

// Mirror legacy `gulfMod` into the new `regionMods.gulf` slot once. Workers
// and tests that still read `dna.gulfMod` directly continue to work — both
// fields point at the same string.
for (const _key of Object.keys(DOMAIN_DNA)) {
  const _entry = DOMAIN_DNA[_key];
  if (_entry && _entry.gulfMod && !_entry.regionMods) {
    _entry.regionMods = { gulf: _entry.gulfMod };
  }
}

/**
 * Pick the region mod string to splice into the final prompt.
 * Looks up: per-domain regionMods[locale] → DEFAULT_REGION_MODS[locale]
 *   → DEFAULT_REGION_MODS.global. Always returns a non-empty string.
 */
function pickRegionMod(dna, locale = 'global') {
  const key = String(locale || 'global').toLowerCase();
  return (dna && dna.regionMods && dna.regionMods[key])
      || DEFAULT_REGION_MODS[key]
      || DEFAULT_REGION_MODS.global;
}

// ─── 3. SEASONAL MODIFIERS ───────────────────────────────────────────────────

function getSeasonalMod() {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth() + 1, d = now.getDate();
  if (y === 2026 && m === 3 && d >= 1  && d <= 30)  return 'Ramadan warmth — lantern gold palette, generous generous spirit, no hard sell';
  if (y === 2026 && m === 3 && d >= 31)              return 'Eid Al-Fitr — joyful cream and gold, festive generosity';
  if (y === 2026 && m === 4 && d <= 2)               return 'Eid Al-Fitr — joyful cream and gold, festive generosity';
  if (y === 2026 && m === 6 && d >= 6  && d <= 8)   return 'Eid Al-Adha — rich warm tones, family gathering spirit';
  if (m === 12  && (d === 2 || d === 3))             return 'UAE National Day — proud green and gold palette, celebratory national spirit';
  if (m === 9   && d === 23)                         return 'Saudi National Day — green and gold, Vision 2030 energy';
  return null;
}

// ─── 4. INTENT CLASSIFIER ────────────────────────────────────────────────────

const CLASSIFIER_SYSTEM = `You are a creative intent classifier for an AI creative studio. 
Analyze the user input and return ONLY valid JSON, no other text.

Return this exact shape:
{
  "intent_type": "creative_image|creative_video|ad_image|ad_video|director|url_to_ad|chat|upscale|restyle",
  "domain": "single word or short phrase describing subject matter — be specific, never say 'general'",
  "audience": "who will see this output, one phrase",
  "style_register": "visual/tonal world in 3-5 words",
  "is_commercial": true|false,
  "gulf_relevant": true|false,
  "output_kind": "image|video|copy|chat",
  "confidence": 0.0-1.0
}

Rules:
- domain must be specific: 'perfume' not 'product', 'streetwear' not 'fashion', 'italian_restaurant' → 'restaurant'
- If unclear, pick the closest specific domain. Never output 'general' or 'other'
- gulf_relevant: true if UAE/Saudi/Gulf/Arabic context visible or locale is gulf
- is_commercial: true if there's a business, brand, or sales intent
- confidence < 0.6 means you're guessing — still output your best guess`;

async function classifyIntent({ rawInput, locale = 'global', extras = {} }) {
  const client = getClient();

  const context = [
    rawInput,
    extras.brandName    ? `Brand: ${extras.brandName}`    : null,
    extras.hasImage     ? 'User uploaded an image'        : null,
    extras.urlScrape    ? `URL product data: ${JSON.stringify(extras.urlScrape).slice(0, 400)}` : null,
    `Locale: ${locale}`,
  ].filter(Boolean).join('\n');

  if (!client) return deterministicClassify(rawInput, locale, extras);

  try {
    const result = await Promise.race([
      client.messages.create({
        model: MODEL,
        max_tokens: 300,
        system: CLASSIFIER_SYSTEM,
        messages: [{ role: 'user', content: context }],
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), TIMEOUT)),
    ]);

    const text = result.content?.[0]?.text?.trim() || '';
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    // Validate required fields — if malformed fall through to deterministic
    if (!parsed.intent_type || !parsed.domain || !parsed.output_kind) {
      throw new Error('incomplete classification');
    }

    return parsed;
  } catch (_) {
    return deterministicClassify(rawInput, locale, extras);
  }
}

function deterministicClassify(rawInput, locale, extras) {
  const lower = (rawInput || '').toLowerCase();

  // output_kind
  const isVideo = /\b(video|reel|film|cinematic|motion|animate|movie|scene)\b/.test(lower);
  const isChat  = /^(what|how|why|when|who|can you|tell me|explain|is it|does)\b/.test(lower.trim());
  const output_kind = isChat ? 'chat' : isVideo ? 'video' : 'image';

  // domain — try to be specific
  // const DOMAIN_SIGNALS = [
  //   ['perfume',       /perfume|fragrance|oud|cologne|scent|bakhoor|عطر|بخور|عود/],
  //   ['restaurant',    /restaurant|food|eat|dish|menu|cuisine|cafe|coffee|bakery/],
  //   ['fashion',       /fashion|clothing|outfit|wear|dress|jacket|shoes|apparel/],
  //   ['beauty',        /beauty|makeup|cosmetic|skincare|skincare|serum|cream|moistur/],
  //   ['realestate',    /property|apartment|villa|real estate|home|condo|listing/],
  //   ['automotive',    /car|vehicle|suv|sedan|auto|drive|motor/],
  //   ['gym',           /gym|fitness|workout|athlete|muscle|training|sport/],
  //   ['saas',          /software|app|platform|saas|product|tech|digital|tool/],
  //   ['jewelry',       /jewel|ring|necklace|bracelet|watch|gold|diamond/],
  //   ['service',       /service|consulting|agency|firm|professional|business/],
  //   ['events',        /event|wedding|conference|party|celebration|launch/],
  //   ['film',          /film|scene|cinematic|movie|shot|director|cinemat/],
  // ];


  const DOMAIN_SIGNALS = [

    // =========================
    // BEAUTY / PERSONAL CARE
    // =========================
  
    ['skincare', /\b(skincare|skin care|serum|moisturi[sz]er|cleanser|toner|retinol|niacinamide|spf|exfoliant|facial)\b/i],
  
    ['perfume', /\b(perfume|fragrance|oud|cologne|parfum|scent|bakhoor|attar|عطر|بخور|عود)\b/i],
  
    ['haircare', /\b(shampoo|conditioner|hair oil|hair mask|scalp treatment|keratin)\b/i],
  
    ['beauty', /\b(makeup|cosmetic|foundation|lipstick|mascara|concealer|beauty)\b/i],
  
    ['wellness', /\b(wellness|spa|massage|holistic|recovery|sauna)\b/i],
  
    // =========================
    // FASHION
    // =========================
  
    ['streetwear', /\b(streetwear|hypebeast|oversized tee|sneakerhead)\b/i],
  
    ['luxury_fashion', /\b(haute couture|luxury fashion|designer wear|runway)\b/i],
  
    ['fashion', /\b(fashion|clothing|abaya|kaftan|hoodie|denim|tailoring|ready[- ]to[- ]wear|apparel)\b/i],
  
    ['jewelry', /\b(jewelry|ring|necklace|bracelet|diamond|pendant|gold|watch|timepiece)\b/i],
  
    // =========================
    // FOOD & BEVERAGE
    // =========================
  
    ['bakery', /\b(bakery|pastry|croissant|sourdough|artisan bread)\b/i],
  
    ['cafe', /\b(cafe|coffee shop|espresso|latte|specialty coffee|roastery)\b/i],
  
    ['restaurant', /\b(restaurant|fine dining|menu|chef|cuisine|tasting menu|bistro)\b/i],
  
    ['beverage', /\b(matcha|juice bar|smoothie|kombucha)\b/i],
  
    // =========================
    // HOSPITALITY / TRAVEL
    // =========================
  
    ['hotel', /\b(hotel|resort|suite|hospitality|staycation)\b/i],
  
    ['travel', /\b(travel|tourism|tour operator|vacation|destination)\b/i],
  
    // =========================
    // REAL ESTATE / HOME
    // =========================
  
    ['realestate', /\b(property|apartment|villa|real estate|condo|listing|brokerage)\b/i],
  
    ['interior', /\b(interior design|furniture|home decor|kitchen design)\b/i],
  
    // =========================
    // AUTOMOTIVE
    // =========================
  
    ['automotive', /\b(car|vehicle|suv|supercar|automotive|dealership|ev)\b/i],
  
    // =========================
    // FITNESS
    // =========================
  
    ['gym', /\b(gym|fitness|crossfit|weightlifting|personal training|pilates)\b/i],
  
    // =========================
    // TECH
    // =========================
  
    ['saas', /\b(saas|crm|erp|workflow automation|software platform|dashboard)\b/i],
  
    ['fintech', /\b(fintech|payments|digital wallet|banking|neobank)\b/i],
  
    ['crypto', /\b(web3|crypto|defi|wallet|staking|blockchain|nft)\b/i],
  
    ['tech', /\b(gadget|consumer electronics|wearable|smart device)\b/i],
  
    // =========================
    // PROFESSIONAL SERVICES
    // =========================
  
    ['medical', /\b(clinic|dental|dermatology|plastic surgery|aesthetic clinic)\b/i],
  
    ['legal', /\b(law firm|attorney|legal services)\b/i],
  
    ['agency', /\b(marketing agency|creative agency|branding studio)\b/i],
  
    ['consulting', /\b(consulting|strategy advisory|business consulting)\b/i],
  
    // =========================
    // EDUCATION
    // =========================
  
    ['education', /\b(course|academy|bootcamp|training institute|tutoring)\b/i],
  
    // =========================
    // EVENTS / CREATIVE
    // =========================
  
    ['events', /\b(wedding|conference|launch event|exhibition|event planning)\b/i],
  
    ['film', /\b(cinematic|film production|director|cinema|videography)\b/i],
  
    ['photography', /\b(photography|photo studio|portrait|editorial shoot)\b/i],
  
  ];

  let domain = 'product';
  for (const [d, rx] of DOMAIN_SIGNALS) {
    if (rx.test(lower)) { domain = d; break; }
  }
  if (extras.urlScrape?.category) domain = extras.urlScrape.category;

  const is_commercial = !!(
    extras.brandName ||
    extras.urlScrape ||
    /\b(ad|ads|advertising|campaign|brand|reel|commercial|promote|sell|shop|buy)\b/.test(lower)
  );

  const gulf_relevant = locale === 'gulf' || /\b(uae|dubai|gulf|arab|saudi|ksa|emirati|ramadan|eid|halal)\b/.test(lower);

  return {
    intent_type: is_commercial ? (isVideo ? 'ad_video' : 'ad_image') : (isVideo ? 'creative_video' : 'creative_image'),
    domain,
    audience:        extras.targetAudience || (gulf_relevant ? 'Gulf market consumers' : 'general audience'),
    style_register:  DOMAIN_DNA[domain]?.grade || 'photorealistic commercial',
    is_commercial,
    gulf_relevant,
    output_kind,
    confidence:      0.5,
  };
}

// ─── 5. CONTEXT ASSEMBLER ────────────────────────────────────────────────────
//
// Runs in parallel — no serial awaits.

async function assembleContext({ intent, inputs, template, urlScrapeData }) {
  const dna = DOMAIN_DNA[intent.domain] || DOMAIN_DNA.default;

  // Resolve locale: explicit `inputs.locale` wins, otherwise we infer one from
  // the intent (gulf_relevant → 'gulf', else 'global'). Default 'global' keeps
  // the engine worldwide-by-default; passing locale='gulf' resurfaces the old
  // Gulf-flavored prompt verbatim.
  const inferredLocale = intent && intent.gulf_relevant ? 'gulf' : 'global';
  const locale = String(inputs?.locale || intent?.locale || inferredLocale || 'global').toLowerCase();

  // Everything that can run in parallel
  const [seasonal] = await Promise.all([
    // Seasonal layer is Gulf-only (Ramadan/Eid/UAE/KSA national days). For
    // non-gulf locales we suppress it.
    Promise.resolve((intent.gulf_relevant || locale === 'gulf') ? getSeasonalMod() : null),
    // Future: brand kit fetch, template fetch, reference image embeddings
  ]);

  const regionMod = pickRegionMod(dna, locale);

  return {
    dna,
    seasonal,
    locale,
    regionMod,
    // Back-compat alias — older code paths read `context.gulfMod`. We only
    // populate it when the resolved locale is gulf so global-mode runs don't
    // accidentally inject Gulf flavor through a stale reference.
    gulfMod:    locale === 'gulf' ? regionMod : null,
    brandKit:   inputs.brandKit || null,
    urlData:    urlScrapeData || null,
  };
}

// ─── 6. PROMPT SYNTHESIZER ───────────────────────────────────────────────────
//
// Produces a single clean string. No pipes. No empty tokens. Scene always first.
// The key architectural change: we use natural language throughout.

/** Template path calls this after blueprint assembly; universal path uses synthesizePrompt. */
function appendNativeAudioTail(prompt, audio) {
  if (!prompt || !audio || !audio.enabled) return prompt || '';
  const mode = String(audio.mode || 'native').toLowerCase();
  if (mode !== 'native') return prompt;
  return `${prompt}\n\nAudio: synchronized native dialogue and ambient sound aligned with the scene.`;
}

function synthesizePrompt({ intent, context, inputs, constraints }) {
  const { dna, seasonal } = context;
  // `regionMod` is the canonical per-locale modifier; fall back to the legacy
  // `gulfMod` field if a caller hand-built a context object without locale.
  const regionMod = context.regionMod || context.gulfMod || null;
  const userScene = (inputs.prompt || inputs.description || '').trim();

  // Build ordered parts — scene always first
  const parts = [];

  // 1. USER SCENE — the anchor. Never overridden.
  if (userScene) parts.push(userScene);

  // 2. BRAND CONTEXT — only if provided
  if (inputs.brandName?.trim()) {
    parts.push(`for ${inputs.brandName.trim()}`);
  }

  // 3. DOMAIN SCENE — only if user didn't describe one, or as background
  if (dna.scene && !userScene) {
    parts.push(dna.scene);
  } else if (dna.scene && userScene) {
    // Append as atmospheric context, not a replacement
    parts.push(`Set against: ${dna.scene}`);
  }

  // 4. LIGHTING + GRADE — always useful
  const lightingParts = [dna.lighting, dna.grade].filter(Boolean);
  if (lightingParts.length) parts.push(lightingParts.join(', '));

  // 5. REGION MODIFIER — additive only (locale-aware: gulf, india, uk, …
  //    or a neutral 'global' baseline if no locale was supplied).
  if (regionMod) parts.push(regionMod);

  // 6. SEASONAL — additive only
  if (seasonal) parts.push(seasonal);

  // 7. URL SCRAPE DATA — weave in product specifics
  if (context.urlData) {
    const { productName, price, description: pDesc } = context.urlData;
    if (productName) parts.push(`Product: ${productName}`);
    if (pDesc)       parts.push(pDesc.slice(0, 120));
  }

  // 8. AUDIENCE — commercial mode only
  if (intent.is_commercial && inputs.targetAudience) {
    parts.push(`Target: ${inputs.targetAudience}`);
  }

  // 9. VIBE — when explicitly set
  if (inputs.vibe) parts.push(inputs.vibe);

  // 10. QUALITY TAIL — short, no conflicting instructions
  const qualityTail = intent.output_kind === 'video'
    ? 'Cinematic quality, professional advertising grade'
    : 'Photorealistic, sharp critical focus, professional advertising quality';

  parts.push(qualityTail);

  // Join with ". " — same Direction/Style clause as template path (constraintRender)
  let finalPrompt = parts.join('. ');
  const directionClause = renderConstraintsClause(constraints || inputs.constraints || {});
  if (directionClause) finalPrompt += directionClause;

  // Negative prompt — category-aware, never fights the user's intent
  const baseNeg = dna.neg || 'watermark, blurry, low quality, distorted, amateur';
  const negativePrompt = intent.is_commercial
    ? `${baseNeg}, text overlay, logo in frame, fake brand packaging`
    : baseNeg;

  finalPrompt = finalPrompt.replace(/\.\s+\./g, '.').replace(/\s{2,}/g, ' ').trim();
  finalPrompt = appendNativeAudioTail(finalPrompt, inputs.audio);

  return {
    finalPrompt,
    negativePrompt,
    promptMetadata: {
      domain:        intent.domain,
      intent_type:   intent.intent_type,
      is_commercial: intent.is_commercial,
      gulf_relevant: intent.gulf_relevant,
      confidence:    intent.confidence,
      sceneFromUser: !!userScene,
      seasonal:      !!seasonal,
    },
  };
}

// ─── 7. VARIANT BUILDER ──────────────────────────────────────────────────────

const VARIANT_TRACKS = [
  { cameraAngle:'eye_level',     lighting:'soft_natural',   shotType:'medium',       motion:'slow_push',  pace:'normal'   },
  { cameraAngle:'low_angle',     lighting:'hard_studio',    shotType:'product_only', motion:'orbit',      pace:'normal'   },
  { cameraAngle:'over_shoulder', lighting:'golden_hour',    shotType:'close_up',     motion:'handheld',   pace:'snappy'   },
  { cameraAngle:'eye_level',     lighting:'low_key_moody',  shotType:'extreme_close',motion:'static',     pace:'languid'  },
  { cameraAngle:'high_angle',    lighting:'high_key',       shotType:'wide',         motion:'slow_pull',  pace:'normal'   },
  { cameraAngle:'dutch',         lighting:'neon_night',     shotType:'medium',       motion:'parallax',   pace:'snappy'   },
];

function buildVariants({ intent, context, inputs, n = 1 }) {
  const count = Math.max(1, Math.min(6, n));
  return VARIANT_TRACKS.slice(0, count).map((track, i) => {
    const { finalPrompt, negativePrompt, promptMetadata } = synthesizePrompt({
      intent, context, inputs,
      constraints: { ...track, ...(inputs.constraints || {}) },
    });
    return { finalPrompt, negativePrompt, promptMetadata, variantIndex: i, constraints: track };
  });
}

// ─── 8. MAIN EXPORTED PIPELINE ───────────────────────────────────────────────
//
// Called by studioController. Returns everything the controller needs.

async function run({ inputs, urlScrapeData = null, template = null,knownDomain=null }) {
  const rawInput = (inputs.prompt || inputs.description || '').trim();

  // Step 1: classify intent (one Haiku call, always resolves)
  let intent;
  if (knownDomain) {
    // Caller already knows the domain (per-product path, URL scan with
    // known brand.category, Studio panel with hand-authored prompt).
    // Skip classification entirely — it only causes drift.
    intent = {
      intent_type: inputs.kind === 'video' ? 'ad_video' : 'ad_image',
      domain: String(knownDomain).toLowerCase(),
      audience: inputs.targetAudience || 'general audience',
      style_register: DOMAIN_DNA[knownDomain]?.grade || 'photorealistic commercial',
      is_commercial: true,
      gulf_relevant: String(inputs.locale || '').toLowerCase() === 'gulf',
      output_kind: inputs.kind === 'video' ? 'video' : 'image',
      confidence: 1.0,
    };
  } else {
    intent = await classifyIntent({
      rawInput,
      locale: inputs.locale || 'global',
      extras: {
        brandName: inputs.brandName,
        targetAudience: inputs.targetAudience,
        hasImage: !!inputs.referenceImageUrl,
        urlScrape: urlScrapeData,
      },
    });
  }

  // Step 2: if it's a chat intent, bail early — no generation
  if (intent.output_kind === 'chat') {
    return { intent, isChatIntent: true, finalPrompt: null, negativePrompt: null };
  }

  // Step 3: assemble context in parallel
  const context = await assembleContext({ intent, inputs, template, urlScrapeData });

  // Step 4: synthesize prompt(s)
  const variants = inputs.variants > 1
    ? buildVariants({ intent, context, inputs, n: inputs.variants })
    : null;

  const primary = synthesizePrompt({
    intent, context, inputs,
    constraints: inputs.constraints,
  });

  return {
    intent,
    isChatIntent: false,
    ...primary,
    variants,
    // Pass through for model router
    suggestedOutputKind: intent.output_kind,
    domain:              intent.domain,
    is_commercial:       intent.is_commercial,
  };
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

let _client;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

module.exports = {
  run,
  classifyIntent,
  assembleContext,
  synthesizePrompt,
  buildVariants,
  deterministicClassify,
  DOMAIN_DNA,
  DEFAULT_REGION_MODS,
  pickRegionMod,
  appendNativeAudioTail,
};
