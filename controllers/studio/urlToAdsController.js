'use strict';

/**
 * urlToAdsController — Phase 7 HTTP surface for the URL-to-Ads flow.
 *
 * Thin adapter over `urlToAdsService`. The old urlToAdController (Phase 1)
 * still exists for the existing drawer — this one powers the persistent
 * report page at /studio/url-to-ads/:scanId.
 *
 *   POST  /studio/url-to-ads/scan                  — create a scan
 *   GET   /studio/url-to-ads/scan/:id              — fetch one
 *   GET   /studio/url-to-ads/scans                 — list for current user/session
 *   POST  /studio/url-to-ads/scan/:id/generate     — render 3 ads
 *   DELETE /studio/url-to-ads/scan/:id             — archive
 *
 * Error shapes are consistent so the frontend can surface one toast:
 *   { success: false, error: 'code', message: 'user-friendly text' }
 */

const UrlToAdsScan = require('../../model/schema/urlToAdsScan');                  // your model
const urlToAdsService = require('../../services/urlToAdsService');
const geoip = require('geoip-lite');
const { renderVideoAd } = require('../../services/renderVideoAd');           // adjust path
const { pickProductReference } = require('../../services/pickProductReference'); // adjust path
const metaAdLibrary = require('../../services/scraper/metaAdLibrary');
 
// ─── Serializers ─────────────────────────────────────────────────────────────

function serializeScan(scan) {
  if (!scan) return null;
  const plain = scan.toObject ? scan.toObject() : scan;
  return {
    id:       String(plain._id || plain.id),
    url:      plain.url,
    host:     plain.host,
    status:   plain.status,
    brand:    plain.brand || {},
    brandPalette: plain.brandPalette || null,
    fonts: Array.isArray(plain.fonts) ? plain.fonts : [],
    productCatalog: plain.productCatalog || null,
    businessProfile: plain.businessProfile || null,
    competitors:   plain.competitors   || [],
    competitorAds: plain.competitorAds || [],
    apifyCompetitorAds: plain.apifyData?.competitorAds || [],
    competitorAdsSummary: plain.apifyData?.competitorAdsSummary || null,
    audience:      plain.audience      || {},
    research:      plain.research      || null,
    intelligence:  plain.intelligence  || null,
    apifyData:     plain.apifyData     || null,
    moneyMath:     plain.moneyMath     || null,
    roast:         plain.roast         || null,
    competitiveGap: plain.competitiveGap || null,
    whatsappCommerce: plain.whatsappCommerce || {
      detected: false,
      waLinks: [],
      waNumbers: [],
      waCtas: [],
      cataloguePresence: false,
      confidence: 'low',
    },
    whatsappCopyPack: plain.whatsappCopyPack || null,
    metaDeploy:    plain.metaDeploy    || null,
    digestEnrolled: !!plain.digestEnrolled,
    digestLastSentAt: plain.digestLastSentAt || null,
    copy:     plain.copy || {},
    ads:      (plain.ads || []).map((ad) => ({
      label:            ad.label,
      headline:         ad.headline,
      hookLine:         ad.hookLine,
      body:             ad.body,
      cta:              ad.cta,
      aspectRatio:      ad.aspectRatio,
      vibe:             ad.vibe,
      category:         ad.category,
      prompt:           ad.prompt,
      negativePrompt:   ad.negativePrompt,
      modelId:          ad.modelId,
      referenceImageUrl: ad.referenceImageUrl,
      status:           ad.status,
      jobId:            ad.jobId,
      assetId:          ad.assetId,
      assetUrl:         ad.assetUrl,
      thumbnailUrl:     ad.thumbnailUrl,
      errorMessage:     ad.errorMessage,
      productId:        ad.productId,
      productTitle:     ad.productTitle,
      productPrice:     ad.productPrice,
      productImageUrl:  ad.productImageUrl,
      kind:             ad.kind || 'image',
      videoUrl:         ad.videoUrl,
    })),
    adSetId:  plain.adSetId || null,
    adSpecs: Array.isArray(plain.adSpecs) ? plain.adSpecs : [],
    errorMessage: plain.errorMessage,
    createdAt: plain.createdAt,
    updatedAt: plain.updatedAt,
  };
}

// ─── Error shaping ───────────────────────────────────────────────────────────

function handleErr(err, res) {
  if (err?.name === 'ZodError') {
    return res.status(400).json({
      success: false,
      error:   'invalid_input',
      message: err.issues?.[0]?.message || 'Invalid input',
      issues:  err.issues,
    });
  }
  const map = {
    invalid_url:         { status: 400, msg: 'That URL doesn\'t look right.' },
    fetch_failed:        { status: 502, msg: err.message || 'We couldn\'t reach that site.' },
    scan_failed:         { status: 502, msg: err.message || 'Scan failed.' },
    not_found:           { status: 404, msg: 'Scan not found.' },
    forbidden:           { status: 403, msg: 'You can\'t access that scan.' },
    scan_not_ready:      { status: 409, msg: err.message },
    invalid_scan:        { status: 409, msg: 'Scan has no ad blueprints yet.' },
    invalid_product_selection: { status: 400, msg: err.message || 'Products not found in catalog.' },
    insufficient_credits:{ status: 402, msg: 'You\'re out of credits.' },
    brand_not_confirmed: { status: 409, msg: 'Confirm your brand details first.' },
  };
  const m = map[err?.code];
  if (m) return res.status(m.status).json({ success: false, error: err.code, message: m.msg });
  console.error('[urlToAdsController]', err);
  return res.status(500).json({ success: false, error: 'server_error', message: 'Something went wrong.' });
}

// ─── Handlers ────────────────────────────────────────────────────────────────

async function scan(req, res) {
  const url = (req.body?.url || '').trim();
  console.log(url,"url");
  try {

    const doc = await urlToAdsService.scanUrl({ url, req });

    return res.json({ success: true, scan: doc });
  } catch (err) {
    return handleErr(err, res);
  }
}

async function getById(req, res) {
  try {
    const doc = await urlToAdsService.getScan(req.params.id, req);
    if (!doc) return res.status(404).json({ success: false, error: 'not_found', message: 'Scan not found.' });
    return res.json({ success: true, scan: doc });
  } catch (err) {
    console.log(err,"we have error")
    return handleErr(err, res);
  }
}

async function list(req, res) {
  try {
    const limit = Math.min(parseInt(req.query?.limit || '20', 10) || 20, 100);
    const docs = await urlToAdsService.listScans({ req, limit });
    return res.json({
      success: true,
      scans: docs.map(serializeScan).filter(Boolean),
    });
  } catch (err) {
    return handleErr(err, res);
  }
}

async function generateSingleAd(req, res) {
  const locale = localeFromReq(req);
  try {
    const out = await urlToAdsService.generateSingleAd({
      scanId: req.params.id,
      req,
      kind: req.body?.kind,
      modelId: req.body?.modelId,
      prompt: req.body?.prompt,
      locale: locale,
      label: req.body?.label,
      aspectRatio: req.body?.aspectRatio,
      referenceImageUrl: req.body?.referenceImageUrl,
      creativeStyleHint: req.body?.creativeStyleHint,
      sourceCompetitor: req.body?.sourceCompetitor,
    });
    return res.json({
      success: true,
      ad: out.ad,
      adSetId: out.adSetId,
    });
  }
  catch (err) {
    return handleErr(err, res);
  }
}



function sanitizeHeadline(raw, scan) {
  const isJunk = (s) => !s || !String(s).trim() || String(s).trim().toLowerCase() === 'unknown';
 
  if (!isJunk(raw)) return String(raw).trim();
 
  // try the seed ad headline, but only if it isn't junk
  const seed = scan.ads?.find((a) => !isJunk(a?.headline))?.headline;
  if (!isJunk(seed)) return String(seed).trim();
 
  // try a competitor primary angle
  const angle = (scan.apifyData?.competitorAds || [])
    .flatMap((c) => c?.ads || [])
    .map((a) => a?.intelligence?.primaryAngle)
    .find((x) => !isJunk(x));
  if (!isJunk(angle)) return String(angle).trim();
 
  // last resort: construct from brand, never "unknown"
  const name = scan.brand?.name || 'Your brand';
  const cat = scan.brand?.category ? ` — ${scan.brand.category}` : '';
  return `${name}${cat}`;
}

function scaleShotsToCount(baseShots, shotCount) {
  if (!shotCount || shotCount <= baseShots.length) return baseShots.slice(0, Math.max(1, shotCount || baseShots.length));
 
  const first = baseShots[0];
  const last = baseShots[baseShots.length - 1];
  const middle = baseShots.slice(1, -1);
  const body = middle.length ? middle : [baseShots[Math.floor(baseShots.length / 2)]];
 
  const need = shotCount - 2;                 // reserve slots for hook + cta
  const filled = [];
  for (let i = 0; i < need; i += 1) {
    filled.push({ ...body[i % body.length] });
  }
  return [first, ...filled, last];
}
// ── CONTROLLER ──────────────────────────────────────────────────────────────
async function generateVideoAdController(req, res) {
  try {
    const { id } = req.params;
    const {
      templateKey, competitorScenes, styleClipUrl,
      headline, cta, startImageUrl, productImageUrl,
      shotCount,lipsync, textOverlay, competitorPosterUrl,
      avatarBrief,audio,durationSec,    


    } = req.body || {};
 
    const scan = await UrlToAdsScan.findById(id);
    if (!scan) return res.status(404).json({ success: false, message: 'Scan not found.' });
 
    // Server-side product reference — never trust the frontend to pick the right
    // image. Prefer an explicit startImageUrl from the modal, else score the
    // scan's images (the Matrice-not-the-canyon logic).
    const productImageUrlLocal = productImageUrl || startImageUrl || pickProductReference(scan.sourceImageUrls || []) ||scan.brand?.images?.[0] || null;

    if (!productImageUrlLocal) {
      return res.status(400).json({ success: false, message: 'productImageUrl is required — the brand product anchors every shot.' });
    }

  const cleanHeadline = sanitizeHeadline(headline, scan);   // ← see helper below

  const { adRow } = await renderVideoAd({
    scan, req, templateKey, competitorScenes, styleClipUrl,
    headline: cleanHeadline,
    cta: cta || 'Learn more',
    productImageUrl:productImageUrlLocal,
    competitorPosterUrl,
    avatarBrief,
    audio,
    durationSec,    
    shotCount: Number(shotCount) || 3,
    lipsync: Boolean(lipsync),
    textOverlay: textOverlay !== false,     // default ON
  });

  return res.json({ success: true, scan, adRow });
} catch (err) {
  console.error('[generateVideoAd] failed:', err);
  return res.status(500).json({ success: false, message: err.message || 'Could not generate video.' });
}
}
async function generate(req, res) {
  const locale = localeFromReq(req);
  try {
    const out = await urlToAdsService.generateAds({
      scanId:       req.params.id,
      userId:       req.user._id,
      req,
      mode:         req.body?.mode || 'append',
      locale:       locale,
      numVariants:  req.body?.numVariants,
      kind:         req.body?.kind,
      generateCopy: req.body?.generateCopy,
      modelId:              req.body?.modelId,
      templateCategory:     req.body?.templateCategory,
      templateName:         req.body?.templateName,
      creativeStyleHint:    req.body?.creativeStyleHint,
      referenceImageUrl:    req.body?.referenceImageUrl,
      referenceVideoUrl:    req.body?.referenceVideoUrl,
      startImageUrl:        req.body?.startImageUrl,
      extras:               req.body?.extras,
    });
    return res.json({
      success: true,
      scan:    out.scan,
      adSetId: out.adSetId,
    });
  } catch (err) {
    return handleErr(err, res);
  }
}



function localeFromReq(req) {
  const ip =
    req.headers['cf-connecting-ip'] ||
    req.headers['x-forwarded-for']?.split(',')[0] ||
    req.socket?.remoteAddress;
  const geo = geoip.lookup(ip);
  return geo?.country?.toLowerCase() || 'global';
}
async function generatePerProduct(req, res) {
  const locale = localeFromReq(req);
  try {
    const out = await urlToAdsService.generatePerProductAds({
      scanId: req.params.id,
      req,
      productIds:         req.body?.productIds || [],
      variantsPerProduct: req.body?.variantsPerProduct,
      kind:               req.body?.kind,
      generateCopy:       req.body?.generateCopy,
      modelId:             req.body?.modelId,
      templateCategory:    req.body?.templateCategory,
      templateName:        req.body?.templateName,
      creativeStyleHint:   req.body?.creativeStyleHint,
      referenceImageUrl:   req.body?.referenceImageUrl,
      locale:              locale,
      extras:               req.body?.extras,
    });
    return res.json({
      success: true,
      scan: out.scan,
      adSetId: out.adSetId,
    });
  } catch (err) {
    return handleErr(err, res);
  }
}

async function archive(req, res) {
  try {
    const doc = await urlToAdsService.archiveScan(req.params.id, req);
    if (!doc) return res.status(404).json({ success: false, error: 'not_found', message: 'Scan not found.' });
    return res.json({ success: true, scan: serializeScan(doc) });
  } catch (err) {
    return handleErr(err, res);
  }
}

async function patchDigest(req, res) {
  try {
    const doc = await urlToAdsService.updateScanDigest({
      scanId: req.params.id,
      req,
      digestEnrolled: !!req.body?.digestEnrolled,
    });
    if (!doc) return res.status(404).json({ success: false, error: 'not_found', message: 'Scan not found.' });
    return res.json({ success: true, scan: serializeScan(doc) });
  } catch (err) {
    return handleErr(err, res);
  }
}


async function confirmBrand(req, res) {
  try {
    const doc = await urlToAdsService.confirmBrand({
      scanId: req.params.id,
      req,
      payload: req.body || {},
    });
    if (!doc) return res.status(404).json({ success: false, error: 'not_found', message: 'Scan not found.' });
    return res.json({ success: true, scan: doc });
  } catch (err) {
    return handleErr(err, res);
  }
}


async function generateUrlAdsController(req, res) {
  const { id } = req.params;
  const {
    numVariants = 3,
    kind = 'image',
    mode = 'append',          // ← NEW
    modelId,
    templateCategory,
    templateName,
    creativeStyleHint,
    referenceImageUrl,
    referenceVideoUrl,        // ← NEW (video ref2vid)
    startImageUrl,            // ← NEW (video start frame)
    locale,
    adSetId,
    extras,
  } = req.body || {};
 
  const scan = await urlToAdsService.generateAds({
    scanId: id,
    userId: req.user._id,
    numVariants,
    kind,
    mode,
    modelId,
    templateCategory,
    templateName,
    creativeStyleHint,
    referenceImageUrl,
    referenceVideoUrl,
    startImageUrl,
    locale,
    adSetId,
    extras,
  });
 
  return res.json({ success: true, scan });
}



async function refreshCompetitorAds(req, res) {
  const { id } = req.params;
  const { keyword, country = 'AE' } = req.body || {};
  if (!keyword || !keyword.trim()) {
    return res.status(400).json({ error: 'keyword_required' });
  }
  try {
    const result = await metaAdLibrary.fetchAdsByKeyword({
      keywords: keyword.trim(),
      countries: [country],
      limit: 20,
    });

    console.log(result,"result");
    // persist onto the scan so a reload keeps the refreshed set
    await UrlToAdsScan.updateOne(
      { _id: id },
      { $set: { 'apifyData.competitorAds': result.ads, 'apifyData.competitorsKeyword': keyword.trim() } }
    );
    return res.json({ success: true, competitors: result.ads });
  } catch (err) {
    console.error('[refreshCompetitorAds] failed:', err);
    return res.status(500).json({ success: false, message: err.message || 'Could not refresh competitor ads.' });
  }
}

module.exports = {
  scan,
  generateSingleAd,
  generateUrlAdsController,
  getById,
  list,
  generate,
  generatePerProduct,
  archive,
  patchDigest,
  generateVideoAdController,
  confirmBrand,
  localeFromReq,
  refreshCompetitorAds,
  _helpers: { serializeScan },
};
