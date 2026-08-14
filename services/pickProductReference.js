/**
 * pickProductReference — choose the RIGHT image to anchor a clone on.
 *
 * THE BUG: code used scan.brand?.images?.[0], which was a generic survey SCENE
 * photo (drone in a canyon). GPT-Image-2 weighted that reference heavily and
 * reproduced the SCENE instead of placing the product into the competitor's
 * layout. For a structure clone, the reference must be a CLEAN PRODUCT shot —
 * or nothing at all.
 *
 * Strategy (cheap → expensive):
 *   1. Heuristic on filenames/dimensions: prefer URLs that look like product
 *      hero shots ("front-view", "product", model names) and square-ish images;
 *      reject logos, banners, scene/lifestyle words.
 *   2. If the heuristic is unsure and you want accuracy, optionally run a tiny
 *      vision classify pass (commented — wire if you have budget).
 *   3. If nothing qualifies, return null → generate from skeleton + text only.
 */

const PRODUCT_HINTS = [
    'front', 'view', 'product', 'hero', 'matrice', 'mavic', 'phantom', 'trinity',
    'dock', 'drone', 'm400', 'm350', 'm30', 'compressed', 'render', 'isolated',
    'white', 'studio', 'packshot',
  ];
  
  const REJECT_HINTS = [
    'logo', 'banner', 'cover', 'hero-bg', 'background', 'scene', 'lifestyle',
    'team', 'about', 'office', 'map', 'icon', 'favicon', 'survey', 'mapping',
    'inspection', 'site', 'aerial', 'landscape', 'header', 'footer',
  ];
  
  function scoreProductImage(url) {
    const u = String(url || '').toLowerCase();
    if (!u) return -Infinity;
    let score = 0;
  
    // Reject obvious non-products hard.
    for (const r of REJECT_HINTS) if (u.includes(r)) score -= 5;
    // Reward product signals.
    for (const p of PRODUCT_HINTS) if (u.includes(p)) score += 3;
  
    // Dimension hints embedded in WP filenames (e.g. 1024x1024 = likely product,
    // 1024x576 = likely banner/scene, 1024x318 = logo strip).
    const dim = u.match(/(\d{2,4})x(\d{2,4})/);
    if (dim) {
      const w = +dim[1], h = +dim[2];
      const ratio = w / h;
      if (ratio >= 0.85 && ratio <= 1.18) score += 3;        // square-ish → product
      else if (ratio > 1.6 || ratio < 0.6) score -= 2;       // wide/tall → banner/logo
      if (h <= 360 && ratio > 2.5) score -= 4;               // logo strip
    }
  
    // PNG often = product render with transparency; jpg scene photos common.
    if (u.endsWith('.png')) score += 1;
  
    return score;
  }
  
  /**
   * Returns the best product image URL, or null if nothing looks like a product.
   * `images` = scan.sourceImageUrls (or brand.images) array.
   */
  function pickProductReference(images) {
    const list = Array.isArray(images) ? images.filter(Boolean) : [];
    if (!list.length) return null;
  
    const ranked = list
      .map((url) => ({ url, score: scoreProductImage(url) }))
      .sort((a, b) => b.score - a.score);
  
    // Require a positive signal — if the best image still looks like a
    // logo/scene (score <= 0), return null and let text drive the product.
    const best = ranked[0];
    return best && best.score > 0 ? best.url : null;
  }
  
  /* Optional vision tiebreaker — uncomment if filename heuristic isn't enough.
  async function pickProductReferenceWithVision(images, openai) {
    const cheap = pickProductReference(images);
    if (cheap) return cheap;
    // Ask the model which URL is a clean isolated product shot.
    const resp = await openai.responses.create({
      model: 'gpt-4.1-mini',
      text: { format: { type: 'json_object' } },
      input: [{ role: 'user', content: [
        { type: 'input_text', text:
          `Which of these image URLs is most likely a CLEAN isolated PRODUCT photo (not a logo, banner, scene, or lifestyle shot)? Return {"index": number} or {"index": -1} if none. URLs:\n${images.map((u,i)=>`${i}: ${u}`).join('\n')}` },
      ]}],
    });
    try {
      const { index } = JSON.parse(stripCodeFences(resp.output_text || '{}'));
      return index >= 0 ? images[index] : null;
    } catch { return null; }
  }
  */
  
  module.exports = { pickProductReference, scoreProductImage };