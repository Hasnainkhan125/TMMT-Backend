'use strict';

/**
 * LLM `competitorAds` entries are text-only (angle/hook/format). After Apify
 * returns Meta ads + IG posts, we attach real stills so the UI is media-first.
 */

function pickStillFromNormalizedAd(ad) {
  if (!ad) return null;
  const v0 = Array.isArray(ad.videos) ? ad.videos[0] : null;
  if (v0?.preview) return { url: v0.preview, kind: 'video_poster' };
  if (v0?.sd || v0?.hd) return { url: v0.sd || v0.hd, kind: 'video_frame' };
  if (Array.isArray(ad.images) && ad.images[0]) return { url: ad.images[0], kind: 'image' };
  const c0 = Array.isArray(ad.cards) ? ad.cards[0] : null;
  if (c0?.imageUrl) return { url: c0.imageUrl, kind: 'carousel' };
  if (Array.isArray(ad.previewUrls) && ad.previewUrls[0]) {
    return { url: ad.previewUrls[0], kind: 'legacy_preview' };
  }
  if (Array.isArray(ad.creativeUrls) && ad.creativeUrls[0]) {
    return { url: ad.creativeUrls[0], kind: 'legacy_creative' };
  }
  return null;
}

function collectMetaAdStills(apifyData) {
  const out = [];
  const buckets = apifyData?.competitorAds || [];
  for (const bucket of buckets) {
    const ads = bucket.ads || [];
    const compName = typeof bucket.competitor === 'string'
      ? bucket.competitor
      : (bucket.competitor?.name || '');
    for (const ad of ads) {
      const still = pickStillFromNormalizedAd(ad);
      if (!still?.url) continue;
      out.push({
        url: still.url,
        mediaUrls: [still.url].concat(
          (ad.images || []).slice(0, 3),
        ).filter(Boolean),
        kind: still.kind,
        source: 'meta_ad_library',
        pageName: ad.pageName || compName,
        caption: [ad.adText, ad.headline, ad.cta].filter(Boolean).join(' · '),
        postUrl: ad.adLibraryUrl || null,
        landingPageUrl: ad.landingPageUrl || null,
      });
    }
  }
  return out;
}

function collectInstagramStills(apifyData) {
  const posts = apifyData?.instagramTopPosts || [];
  const out = [];
  for (const p of posts) {
    const url = p.mediaUrls?.[0];
    if (!url) continue;
    out.push({
      url,
      mediaUrls: (p.mediaUrls || []).slice(0, 6),
      kind: 'instagram',
      source: 'instagram',
      pageName: p._competitorName || p._igUsername || '',
      caption: p.caption || '',
      postUrl: p.postUrl || '',
    });
  }
  return out;
}

function collectBrandSiteStills(scan) {
  const imgs = scan.brand?.images || [];
  return imgs.slice(0, 12).map((url) => ({
    url,
    mediaUrls: [url],
    kind: 'brand_site',
    source: 'brand_site',
    pageName: scan.brand?.name || scan.host || '',
    caption: '',
    postUrl: scan.url || scan.brand?.url || '',
  }));
}

function collectLogoStill(scan) {
  const u = scan.brand?.logoUrl || scan.brand?.favicon;
  if (!u) return [];
  return [{
    url: u,
    mediaUrls: [u],
    kind: 'logo',
    source: 'brand_logo',
    pageName: scan.brand?.name || scan.host || '',
    caption: '',
    postUrl: scan.url || scan.brand?.url || '',
  }];
}

function tokenize(s) {
  return String(s || '')
    .toLowerCase()
    .split(/[^a-z0-9\u0600-\u06FF]+/)
    .filter((w) => w.length > 3);
}

function scoreOverlap(angleBlob, mediaBlob) {
  const a = new Set(tokenize(angleBlob));
  let sc = 0;
  for (const w of tokenize(mediaBlob)) {
    if (a.has(w)) sc++;
  }
  return sc;
}

/**
 * @param {Array<object>} angles — LLM competitorAds rows
 * @param {Array<object>} stills — collected stills with url, caption, …
 * @returns {Array<object>}
 */
function assignStillsToAngles(angles, stills) {
  if (!Array.isArray(angles) || !angles.length) return angles || [];
  if (!stills.length) {
    return angles.map((a) => ({
      ...a,
      _mediaStatus: 'pending',
    }));
  }

  const used = new Set();
  return angles.map((ang, idx) => {
    const blob = `${ang.angle || ''} ${ang.hook || ''} ${ang.format || ''} ${ang.whyItWorks || ''}`;
    let bestI = -1;
    let bestScore = 0;
    for (let i = 0; i < stills.length; i++) {
      if (used.has(i)) continue;
      const st = stills[i];
      const mediaBlob = `${st.caption || ''} ${st.pageName || ''}`;
      const sc = scoreOverlap(blob, mediaBlob);
      if (sc > bestScore) {
        bestScore = sc;
        bestI = i;
      }
    }
    let pick = bestI >= 0 && bestScore > 0
      ? bestI
      : stills.findIndex((_, i) => !used.has(i));
    if (pick < 0) pick = idx % stills.length;
    while (used.has(pick) && pick + 1 < stills.length) pick++;
    if (used.has(pick) || pick < 0) {
      const st = stills[idx % stills.length];
      return {
        ...ang,
        thumbnailUrl: st.url,
        mediaUrl: st.url,
        mediaUrls: st.mediaUrls || [st.url],
        mediaSource: st.source,
        mediaKind: st.kind,
        mediaPostUrl: st.postUrl || null,
        mediaCaption: (st.caption || '').slice(0, 280),
        mediaPageName: st.pageName || null,
        _mediaStatus: 'ready',
      };
    }
    used.add(pick);
    const st = stills[pick];
    return {
      ...ang,
      thumbnailUrl: st.url,
      mediaUrl: st.url,
      mediaUrls: st.mediaUrls || [st.url],
      mediaSource: st.source,
      mediaKind: st.kind,
      mediaPostUrl: st.postUrl || null,
      mediaCaption: (st.caption || '').slice(0, 280),
      mediaPageName: st.pageName || null,
      _mediaStatus: 'ready',
    };
  });
}

function enrichHooksWithRefs(scan, stills) {
  const hooks = scan.research?.hooks;
  if (!Array.isArray(hooks) || !hooks.length) return;
  const brandImgs = collectBrandSiteStills(scan);
  const pool = [...stills, ...brandImgs];
  if (!pool.length) return;

  scan.research.hooks = hooks.map((h, i) => {
    const st = pool[i % pool.length];
    return {
      ...h,
      referenceImageUrl: h.referenceImageUrl || st.url || null,
      mediaPreviewUrl: st.url || null,
    };
  });
  scan.markModified('research');
}

/**
 * Mutates mongoose scan: competitorAds + research.competitorAds + research.hooks
 *
 * @param {import('mongoose').Document|object} scan
 */
function enrichScanStrategicAnglesWithMedia(scan) {
  try {
    const apify = scan.apifyData || {};
    const meta = collectMetaAdStills(apify);
    const ig = collectInstagramStills(apify);
    const brandStills = collectBrandSiteStills(scan);
    const logoStills = collectLogoStill(scan);
    const stills = [...meta, ...ig, ...brandStills, ...logoStills];

    if (Array.isArray(scan.competitorAds) && scan.competitorAds.length) {
      scan.competitorAds = assignStillsToAngles(scan.competitorAds, stills);
      scan.markModified?.('competitorAds');
    }
    if (scan.research && Array.isArray(scan.research.competitorAds) && scan.research.competitorAds.length) {
      scan.research.competitorAds = assignStillsToAngles(scan.research.competitorAds, stills);
      scan.markModified?.('research');
    }

    enrichHooksWithRefs(scan, stills);
  } catch (e) {
    console.warn('[mergeStrategicAnglesWithMedia]', e.message);
  }
}

module.exports = {
  enrichScanStrategicAnglesWithMedia,
  pickStillFromNormalizedAd,
  _test: { assignStillsToAngles, collectMetaAdStills },
};
