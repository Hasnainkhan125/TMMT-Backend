/**
 * seed_arabic_templates.js
 *
 * Seeds the `generation_templates` collection with 10 Qumak-original templates
 * that ship with full Arabic (Khaleeji + MSA) prompt blueprints.
 *
 * This is the moat. TopView/Creatify/Higgsfield/Omneky all left `i18nPrompts.ar`
 * empty. We do not. See docs/PIVOT_WEDGE.md.
 *
 * Run:
 *   node scripts/seed_arabic_templates.js
 *
 * Idempotent — uses { source, sourceId } as the upsert key.
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { MongoClient } = require('mongodb');

// ── Helpers ──────────────────────────────────────────────────────────────────
const KHALEEJI_HOOK_LIB = [
  'يا جماعة، شوفوا هذا!',          // "Hey everyone, look at this!"
  'صدق ولا كذب؟',                  // "Truth or lie?"
  'هذا اللي كنتم تنتظرونه',        // "This is what you've been waiting for"
  'تحدي يومي عليكم',               // "Daily challenge for you"
  'ما تتخيل وش صار',                // "You won't believe what happened"
];

const CTA_AR = 'اطلب الحين عبر واتساب — التوصيل اليوم';
const CTA_EN = 'Order now on WhatsApp — same-day delivery';

const GULF_CONTEXT = 'Gulf-native art direction: warm desert tones, Khaleeji wardrobe (kandura/abaya where appropriate), Arabic script overlay (right-to-left), prayer-time-friendly pacing, no alcohol, no pork, halal-safe lifestyle cues.';

// ── The 10 templates ─────────────────────────────────────────────────────────
const TEMPLATES = [
  {
    sourceId: 'qumak_ar_ugc_review_v1',
    name: 'Khaleeji UGC Review (15s vertical)',
    description: 'Short, punchy Khaleeji-Arabic UGC review with WhatsApp CTA. Built for UAE/KSA F&B and beauty SMEs.',
    contentType: 'ugc_review',
    contentGroup: 'ugc',
    outputType: 'video',
    aspectRatio: '9:16',
    defaultDuration: 15,
    bestCategories: ['restaurant', 'cafe', 'beauty', 'skincare', 'perfume'],
    bestPlatforms: ['instagram', 'tiktok', 'snapchat', 'whatsapp'],
    locale: 'gulf',
    promptBlueprint:
      '{product_image} A 15-second vertical UGC review filmed on iPhone in a sunlit Dubai/Riyadh apartment. ' +
      '0-2s HOOK: presenter (Khaleeji styling, warm smile) holds {product_name} close to camera and says "{hook_line}". ' +
      '2-8s: shows three quick benefits with handheld B-roll, soft natural light. ' +
      '8-13s: before/after or result shot, RTL Arabic caption appears top-third. ' +
      '13-15s: hero product on wooden table, on-screen text "{cta_line}".',
    promptBlueprintAr:
      '{product_image} فيديو UGC طوله 15 ثانية بصيغة عمودية مصور بالآيفون داخل شقة مضاءة بنور الشمس في دبي أو الرياض. ' +
      'من 0 إلى 2 ثانية: الهوك — يقدم الشخصية الخليجية المنتج {product_name} للكاميرا ويقول: "{hook_line}". ' +
      'من 2 إلى 8 ثوانٍ: ثلاث فوائد سريعة مع لقطات B-roll محمولة باليد وإضاءة طبيعية ناعمة. ' +
      'من 8 إلى 13 ثانية: لقطة قبل/بعد أو نتيجة الاستخدام، مع ظهور تعليق عربي في الثلث العلوي من اليمين إلى اليسار. ' +
      'من 13 إلى 15 ثانية: لقطة بطل للمنتج على طاولة خشبية مع نص شاشة: "{cta_line}".',
  },
  {
    sourceId: 'qumak_ar_food_closeup_v1',
    name: 'Halal F&B Cinematic Close-up (10s)',
    description: 'Cinematic food close-up with steam, drizzle, and Arabic overlay. F&B safe (halal-only cues).',
    contentType: 'food_closeup',
    contentGroup: 'food',
    outputType: 'video',
    aspectRatio: '9:16',
    defaultDuration: 10,
    bestCategories: ['restaurant', 'cafe', 'food_delivery'],
    bestPlatforms: ['instagram', 'tiktok', 'snapchat'],
    locale: 'gulf',
    promptBlueprint:
      '{product_image} A 10-second cinematic vertical food shot. Macro lens, shallow depth, slow drizzle/steam reveal of {product_name}. ' +
      '0-3s: dish lands on dark plate, dramatic side light. ' +
      '3-7s: hero ingredient close-up, drizzle in slow motion. ' +
      '7-10s: pull-back to reveal full dish, RTL Arabic title "{hook_line}", CTA pill: "{cta_line}".',
    promptBlueprintAr:
      '{product_image} لقطة طعام سينمائية عمودية طولها 10 ثوانٍ. عدسة ماكرو، عمق ضحل، كشف بطيء عن البخار/الصوص فوق {product_name}. ' +
      'من 0 إلى 3 ثوانٍ: الطبق يحط على صحن داكن مع إضاءة جانبية درامية. ' +
      'من 3 إلى 7 ثوانٍ: لقطة مقربة للمكون البطل وصوص بحركة بطيئة. ' +
      'من 7 إلى 10 ثوانٍ: انسحاب الكاميرا لإظهار الطبق كاملاً، عنوان عربي من اليمين إلى اليسار: "{hook_line}"، وزر CTA: "{cta_line}".',
  },
  {
    sourceId: 'qumak_ar_perfume_luxury_v1',
    name: 'Oud & Perfume Luxury Hero (12s)',
    description: 'Luxury perfume hero shot — gold accents, oud smoke, RTL serif caption. Perfect for KSA/UAE perfumeries.',
    contentType: 'brand_luxury',
    contentGroup: 'brand',
    outputType: 'video',
    aspectRatio: '9:16',
    defaultDuration: 12,
    bestCategories: ['perfume', 'beauty'],
    bestPlatforms: ['instagram', 'snapchat'],
    locale: 'gulf',
    promptBlueprint:
      '{product_image} A 12-second luxury perfume reveal. Black marble surface, gold rim lighting, slow oud-smoke curl rising behind {product_name}. ' +
      '0-4s: smoke reveals bottle silhouette. ' +
      '4-9s: macro pan around bottle, light catches engraving. ' +
      '9-12s: bottle settles on marble, RTL Arabic serif title "{hook_line}" fades in, gold CTA bar "{cta_line}".',
    promptBlueprintAr:
      '{product_image} كشف عطر فاخر مدته 12 ثانية. سطح من الرخام الأسود وإضاءة ذهبية، دخان عود يتصاعد ببطء خلف {product_name}. ' +
      'من 0 إلى 4 ثوانٍ: الدخان يكشف ظل القارورة. ' +
      'من 4 إلى 9 ثوانٍ: حركة ماكرو حول القارورة، الضوء ينعكس على النقش. ' +
      'من 9 إلى 12 ثانية: القارورة تستقر على الرخام، يظهر عنوان عربي بخط Serif من اليمين إلى اليسار: "{hook_line}"، وشريط CTA ذهبي: "{cta_line}".',
  },
  {
    sourceId: 'qumak_ar_real_estate_walkthrough_v1',
    name: 'Off-Plan Property Walkthrough (20s)',
    description: 'Vertical walkthrough for off-plan UAE/KSA properties with bilingual price overlay.',
    contentType: 'cinematic_lifestyle',
    contentGroup: 'cinematic',
    outputType: 'video',
    aspectRatio: '9:16',
    defaultDuration: 20,
    bestCategories: ['realestate', 'interior'],
    bestPlatforms: ['instagram', 'tiktok', 'facebook'],
    locale: 'gulf',
    promptBlueprint:
      '{product_image} A 20-second vertical drone-to-interior walkthrough of a Dubai/Riyadh off-plan property. ' +
      '0-4s: aerial of skyline, building reveal. ' +
      '4-12s: glide through living room, kitchen, balcony — golden-hour light. ' +
      '12-17s: feature highlights (smart home, view) with EN+AR captions. ' +
      '17-20s: brand lockup + bilingual price chip "{cta_line}".',
    promptBlueprintAr:
      '{product_image} جولة عمودية مدتها 20 ثانية بطائرة درون تتحول إلى لقطات داخلية لعقار قيد الإنشاء في دبي/الرياض. ' +
      'من 0 إلى 4 ثوانٍ: لقطة جوية للأفق وكشف للمبنى. ' +
      'من 4 إلى 12 ثانية: انسياب عبر الصالة والمطبخ والشرفة بإضاءة الساعة الذهبية. ' +
      'من 12 إلى 17 ثانية: إبراز الميزات (المنزل الذكي، الإطلالة) مع تعليقات عربية وإنجليزية. ' +
      'من 17 إلى 20 ثانية: شعار العلامة وبطاقة سعر ثنائية اللغة: "{cta_line}".',
  },
  {
    sourceId: 'qumak_ar_gym_transformation_v1',
    name: 'Gym Transformation UGC (15s)',
    description: 'Before/after gym transformation, modest activewear, motivational Khaleeji voiceover.',
    contentType: 'ugc_lifestyle',
    contentGroup: 'ugc',
    outputType: 'video',
    aspectRatio: '9:16',
    defaultDuration: 15,
    bestCategories: ['gym', 'sports', 'wellness'],
    bestPlatforms: ['instagram', 'tiktok', 'snapchat'],
    locale: 'gulf',
    promptBlueprint:
      '{product_image} A 15-second vertical gym transformation. Modest activewear, no skin-baring. ' +
      '0-3s HOOK: split-screen before / after with text "{hook_line}". ' +
      '3-10s: training cuts (squats, treadmill, smiles) shot in {brand_name} gym. ' +
      '10-15s: trainer high-fives client, on-screen offer "{cta_line}".',
    promptBlueprintAr:
      '{product_image} تحول رياضي عمودي مدته 15 ثانية. ملابس رياضية محتشمة دون كشف. ' +
      'من 0 إلى 3 ثوانٍ: الهوك — شاشة منقسمة قبل/بعد مع نص: "{hook_line}". ' +
      'من 3 إلى 10 ثوانٍ: لقطات تدريب (سكوات، تريدميل، ابتسامات) داخل صالة {brand_name}. ' +
      'من 10 إلى 15 ثانية: المدرب يصافح المتدرب، عرض شاشة: "{cta_line}".',
  },
  {
    sourceId: 'qumak_ar_salon_beauty_v1',
    name: 'Ladies Salon Beauty Reveal (12s)',
    description: 'Ladies-only salon transformation reveal, soft pastel palette, RTL Arabic captions.',
    contentType: 'ugc_virtual_try_on',
    contentGroup: 'ugc',
    outputType: 'video',
    aspectRatio: '9:16',
    defaultDuration: 12,
    bestCategories: ['beauty', 'haircare', 'skincare'],
    bestPlatforms: ['instagram', 'snapchat', 'tiktok'],
    locale: 'gulf',
    promptBlueprint:
      '{product_image} A 12-second vertical ladies-only beauty reveal in {brand_name} salon. Soft pastel palette, golden mirror frames. ' +
      '0-3s: client enters, hood-up before. ' +
      '3-9s: stylist works — close-up of brushes, color, blow-dry. ' +
      '9-12s: reveal turn, mirror catches face, RTL Arabic caption "{hook_line}", CTA "{cta_line}".',
    promptBlueprintAr:
      '{product_image} كشف جمال نسائي عمودي مدته 12 ثانية داخل صالون {brand_name}. لوحة ألوان باستيل ناعمة وإطارات مرايا ذهبية. ' +
      'من 0 إلى 3 ثوانٍ: العميلة تدخل بمظهر "قبل". ' +
      'من 3 إلى 9 ثوانٍ: المصففة تعمل — لقطات قريبة للفرشاة واللون والتجفيف. ' +
      'من 9 إلى 12 ثانية: دوران الكشف، المرآة تعكس الوجه، تعليق عربي من اليمين إلى اليسار: "{hook_line}" مع CTA: "{cta_line}".',
  },
  {
    sourceId: 'qumak_ar_ramadan_offer_v1',
    name: 'Ramadan Offer Hero (8s static + motion)',
    description: 'Ramadan crescent + lantern motion graphic with bilingual offer copy.',
    contentType: 'product_hero',
    contentGroup: 'product',
    outputType: 'video',
    aspectRatio: '1:1',
    defaultDuration: 8,
    bestCategories: ['retail', 'ecommerce', 'restaurant', 'fashion'],
    bestPlatforms: ['instagram', 'facebook', 'snapchat'],
    locale: 'gulf',
    promptBlueprint:
      '{product_image} An 8-second Ramadan offer ad. Deep navy + gold palette, animated crescent + fanous lantern. ' +
      '0-3s: lantern lights up, reveals product hero shot of {product_name}. ' +
      '3-6s: bilingual offer chip with discount % and Ramadan greeting. ' +
      '6-8s: brand lockup of {brand_name} + CTA "{cta_line}". Subtle oud particles in motion.',
    promptBlueprintAr:
      '{product_image} إعلان عرض رمضاني مدته 8 ثوانٍ. لوحة كحلية عميقة مع ذهبي، هلال متحرك وفانوس مضيء. ' +
      'من 0 إلى 3 ثوانٍ: الفانوس يضيء ويكشف لقطة بطل للمنتج {product_name}. ' +
      'من 3 إلى 6 ثوانٍ: بطاقة عرض ثنائية اللغة بنسبة الخصم وتحية رمضانية. ' +
      'من 6 إلى 8 ثوانٍ: شعار {brand_name} مع CTA: "{cta_line}". جزيئات عود ناعمة في الحركة.',
  },
  {
    sourceId: 'qumak_ar_national_day_v1',
    name: 'UAE/KSA National Day Patriotic (10s)',
    description: 'National Day montage — flag colors, falconry, skyline, bilingual greeting overlay.',
    contentType: 'brand_story',
    contentGroup: 'brand',
    outputType: 'video',
    aspectRatio: '9:16',
    defaultDuration: 10,
    bestCategories: ['retail', 'ecommerce', 'general', 'realestate', 'automotive'],
    bestPlatforms: ['instagram', 'tiktok', 'facebook', 'snapchat'],
    locale: 'gulf',
    promptBlueprint:
      '{product_image} A 10-second National Day montage. Flag colors as background gradient, sweeping shots: skyline, dunes, falcon, family. ' +
      '0-4s: emotional intro with national anthem cue. ' +
      '4-8s: {brand_name} product hero shot integrated subtly. ' +
      '8-10s: bilingual greeting + CTA "{cta_line}".',
    promptBlueprintAr:
      '{product_image} مونتاج لليوم الوطني مدته 10 ثوانٍ. ألوان العلم كتدرج خلفي، لقطات واسعة: الأفق، الكثبان، الصقر، العائلة. ' +
      'من 0 إلى 4 ثوانٍ: مقدمة عاطفية مع إيحاء النشيد الوطني. ' +
      'من 4 إلى 8 ثوانٍ: لقطة بطل لمنتج {brand_name} مدمجة بأناقة. ' +
      'من 8 إلى 10 ثوانٍ: تحية ثنائية اللغة وCTA: "{cta_line}".',
  },
  {
    sourceId: 'qumak_ar_white_friday_flash_v1',
    name: 'White Friday Flash Sale (6s loop)',
    description: 'High-energy 6s vertical loop for White Friday with countdown timer and bilingual discount.',
    contentType: 'product_showcase',
    contentGroup: 'product',
    outputType: 'video',
    aspectRatio: '9:16',
    defaultDuration: 6,
    bestCategories: ['ecommerce', 'retail', 'fashion', 'beauty'],
    bestPlatforms: ['instagram', 'tiktok', 'snapchat'],
    locale: 'gulf',
    promptBlueprint:
      '{product_image} A 6-second high-energy White Friday loop. Black + electric white palette, fast cuts. ' +
      '0-2s: countdown timer slams in, hook "{hook_line}". ' +
      '2-5s: rapid product carousel of {product_name} variants on rotating pedestal. ' +
      '5-6s: discount chip + CTA "{cta_line}". Loops seamlessly.',
    promptBlueprintAr:
      '{product_image} لوب وايت فرايدي عالي الطاقة مدته 6 ثوانٍ. لوحة سوداء وأبيض كهربائي وقطع سريعة. ' +
      'من 0 إلى 2 ثانية: عدّاد تنازلي يقتحم الشاشة مع الهوك: "{hook_line}". ' +
      'من 2 إلى 5 ثوانٍ: عرض سريع لتشكيلات {product_name} على قاعدة دوارة. ' +
      'من 5 إلى 6 ثوانٍ: بطاقة الخصم وCTA: "{cta_line}". تكرار سلس.',
  },
  {
    sourceId: 'qumak_ar_whatsapp_dm_promo_v1',
    name: 'WhatsApp DM Promo Card (square)',
    description: 'Square static-with-motion promo card built specifically for WhatsApp Business broadcast.',
    contentType: 'product_hero',
    contentGroup: 'product',
    outputType: 'image',
    aspectRatio: '1:1',
    defaultDuration: 0,
    bestCategories: ['restaurant', 'beauty', 'retail', 'gym', 'cafe'],
    bestPlatforms: ['whatsapp', 'instagram'],
    locale: 'gulf',
    promptBlueprint:
      '{product_image} A square 1:1 promo card optimized for WhatsApp DM broadcast. Bold central product hero of {product_name}. ' +
      'Top: bilingual headline (EN top, AR bottom, RTL). ' +
      'Bottom: WhatsApp-green CTA pill "{cta_line}". ' +
      'Brand mark of {brand_name} top-right. High contrast, mobile-first, readable at 240px.',
    promptBlueprintAr:
      '{product_image} بطاقة ترويجية مربعة 1:1 مُحسّنة لبث واتساب. لقطة بطل مركزية جريئة للمنتج {product_name}. ' +
      'في الأعلى: عنوان ثنائي اللغة (الإنجليزية في الأعلى، العربية في الأسفل من اليمين إلى اليسار). ' +
      'في الأسفل: زر CTA باللون الأخضر الواتسابي: "{cta_line}". ' +
      'علامة {brand_name} في الزاوية العلوية اليمنى. تباين عالٍ، مُحسّن للجوال، مقروء عند 240 بكسل.',
  },
];

// ── Build full docs ──────────────────────────────────────────────────────────
function buildDoc(t, idx) {
  const hook = KHALEEJI_HOOK_LIB[idx % KHALEEJI_HOOK_LIB.length];
  return {
    source: 'qumak_original',
    sourceId: t.sourceId,
    sourceHash: `qumak-ar-v1-${t.sourceId}`,
    name: t.name,
    description: t.description,
    contentType: t.contentType,
    contentGroup: t.contentGroup,
    outputType: t.outputType,
    aspectRatio: t.aspectRatio,
    defaultDuration: t.defaultDuration,
    defaultResolution: 720,
    promptBlueprint: t.promptBlueprint
      .replace('{hook_line}', hook)
      .replace('{cta_line}', CTA_EN),
    promptBlueprintAr: t.promptBlueprintAr
      .replace('{hook_line}', hook)
      .replace('{cta_line}', CTA_AR),
    i18nPrompts: {
      en: t.promptBlueprint
        .replace('{hook_line}', hook)
        .replace('{cta_line}', CTA_EN),
      ar: t.promptBlueprintAr
        .replace('{hook_line}', hook)
        .replace('{cta_line}', CTA_AR),
    },
    gulfContextModifier: GULF_CONTEXT,
    negativePrompt: 'alcohol, pork, immodest clothing, religious imagery, political symbols, low-resolution, watermark, distorted text, mangled Arabic letters',
    supportedModels: t.outputType === 'image'
      ? ['flux_1.1_pro', 'nano_banana_pro', 'gpt_image_1', 'auto']
      : ['kling_3.0', 'seedance_2.0', 'veo_3.1', 'auto'],
    recommendedModel: t.outputType === 'image' ? 'flux_1.1_pro' : 'kling_3.0',
    inputSlots: [
      { key: 'product_image', type: 'image', title: 'Product image / hero shot', required: true, allowedFormats: ['jpg', 'png', 'webp'], maxFileSizeMB: 25 },
      { key: 'brand_name',    type: 'text',  title: 'Brand name', required: true,  maxLength: 60 },
      { key: 'product_name',  type: 'text',  title: 'Product / offer name', required: true, maxLength: 60 },
      { key: 'product_desc',  type: 'text',  title: 'Short product description', required: false, maxLength: 200 },
    ],
    requiresProductImage: true,
    requiresAvatar: false,
    requiresBrandKit: false,
    bestCategories: t.bestCategories,
    bestPlatforms: t.bestPlatforms,
    locale: t.locale,
    media: {},
    engagement: { qualityTier: 'hero', finalScore: 90 },
    isFeatured: true,
    isActive: true,
    updatedAt: new Date(),
  };
}

// ── Run ──────────────────────────────────────────────────────────────────────
async function run() {
  const uri = process.env.DB_URL || process.env.MONGO_URI;
  const dbName = process.env.DB || 'qumak';

  if (!uri) {
    console.error('[seed_arabic_templates] DB_URL / MONGO_URI not set in .env');
    process.exit(1);
  }

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);
  const col = db.collection('generation_templates');

  await col.createIndex({ source: 1, sourceId: 1 }, { unique: true });

  const ops = TEMPLATES.map((t, i) => {
    const doc = buildDoc(t, i);
    return {
      updateOne: {
        filter: { source: doc.source, sourceId: doc.sourceId },
        update: { $set: doc, $setOnInsert: { createdAt: new Date() } },
        upsert: true,
      },
    };
  });

  const result = await col.bulkWrite(ops, { ordered: false });
  const arabicCount = await col.countDocuments({ 'i18nPrompts.ar': { $ne: null, $ne: '' } });
  const heroCount = await col.countDocuments({ source: 'qumak_original', 'engagement.qualityTier': 'hero' });

  console.log('═══════════════════════════════════');
  console.log('  Arabic templates seeded');
  console.log('═══════════════════════════════════');
  console.log(`Upserted: ${result.upsertedCount}`);
  console.log(`Modified: ${result.modifiedCount}`);
  console.log(`Templates with Arabic prompts: ${arabicCount}`);
  console.log(`Qumak-original hero tier: ${heroCount}`);

  await client.close();
}

if (require.main === module) {
  run().catch(e => {
    console.error('[seed_arabic_templates] Fatal:', e);
    process.exit(1);
  });
}

module.exports = { TEMPLATES, buildDoc };
