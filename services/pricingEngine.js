function computeUsdCost(costSpec, params) {
    const { unit, usd } = costSpec;
  
    if (unit === 'per_image') {
      let cost = usd.base;
      if (usd.byResolution && params.resolution) {
        cost *= (usd.byResolution[params.resolution] ?? 1);
      }
      // quality tiers for gpt-image-2 etc.
      if (usd.byQuality && params.quality) {
        cost = usd.byQuality[params.quality] ?? cost;
      }
      return cost;
    }
  
    if (unit === 'per_second') {
      const dur = params.duration || 5;
      let perSec = usd.base;
      if (usd.byResolution) perSec *= (usd.byResolution[params.resolution] ?? 1);
  
      // reference image handling
      const refCount = countReferenceInputs(params); // counts image_urls, elements, start frame
      if (usd.referenceImage) {
        const r = usd.referenceImage;
        if (r.mode === 'discount' && refCount > 0) perSec *= r.value;
        if (r.mode === 'surcharge' && refCount > 0) perSec *= r.value;
      }
  
      let cost = perSec * dur;
  
      // per-item reference cost (the Kling O3 $8 case)
      if (usd.referenceImage?.mode === 'per_item') {
        const billable = Math.max(0, refCount - (usd.referenceImage.freeCount || 0));
        cost += billable * usd.referenceImage.perItemUsd;
      }
  
      // audio
      if (params.audioEnabled && usd.audio) {
        if (usd.audio.mode === 'multiplier') cost *= usd.audio.value;
        if (usd.audio.mode === 'flat') cost += usd.audio.value;
      }
  
      return cost;
    }
  
    if (unit === 'token_based') {
      const tokens = computeTokens(params, usd.tokenFormula); // h×w×dur×24/1024 etc.
      return (tokens / 1000) * usd.tokenRateUsd;
    }
  
    throw new Error(`Unknown cost unit: ${unit}`);
  }
  
  function computeCost(model, params) {
    const usdCost = computeUsdCost(model.costSpec, params);
    const PRICE_PER_CREDIT_USD = Number(process.env.PRICE_PER_CREDIT_USD || 0.03);
    const markup = model.costSpec.markup || 2.5;
    const credits = Math.ceil((usdCost * markup) / PRICE_PER_CREDIT_USD);
    const variants = Math.max(1, params.variants || 1);
  
    return {
      usdCost: +(usdCost * variants).toFixed(4),   // your real cost
      credits: credits * variants,                  // what you charge
      breakdown: { perUnitUsd: usdCost, markup, pricePerCredit: PRICE_PER_CREDIT_USD, variants },
    };
  }
  
  function countReferenceInputs(params) {
    let n = 0;
    if (params.startFrame || params.image_url || params.start_image_url) n += 1;
    if (Array.isArray(params.image_urls)) n += params.image_urls.length;
    if (Array.isArray(params.elements)) {
      for (const el of params.elements) {
        if (el?.frontal_image_url) n += 1;
        if (Array.isArray(el?.reference_image_urls)) n += el.reference_image_urls.length;
      }
    }
    return n;
  }

module.exports = {
    computeUsdCost,
    computeCost,
    countReferenceInputs,
  };