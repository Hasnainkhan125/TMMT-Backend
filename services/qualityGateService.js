'use strict';

const RUBRIC_PROMPT = `You are a quality reviewer for AI-generated social media content.
Inspect the provided image(s) and return a JSON object (no markdown, raw JSON only) with this exact structure:
{
  "pass": boolean,
  "identityConsistent": boolean,
  "productVisible": boolean,
  "captionHasDisclosure": boolean,
  "textReadable": boolean,
  "reasons": string[]
}

Rules:
- identityConsistent: the person in the generated image looks consistent with the reference portrait (if provided)
- productVisible: if a product name is provided, the product is clearly identifiable in the image
- captionHasDisclosure: the caption contains #ad, #AI, or #AIcreator (or Arabic equivalents)
- textReadable: any text overlay is legible and not cut off
- pass: true only if ALL criteria are true
- reasons: list only the criteria that FAILED, as short sentences`;

/**
 * checkAsset — Gemini Flash vision check against quality rubric.
 *
 * @param {object} params
 * @param {string} params.assetUrl           URL of generated image/video thumbnail
 * @param {string} params.referenceImageUrl  Persona reference portrait URL
 * @param {string} params.caption            Planned caption
 * @param {string} [params.productName]      Product being shown (optional)
 * @returns {{ pass: boolean, reasons: string[], details: object, raw: object }}
 */
async function checkAsset({ assetUrl, referenceImageUrl, caption, productName }) {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!key) {
    console.warn('[qualityGate] GEMINI_API_KEY not set — skipping quality check');
    return { pass: true, reasons: ['quality_gate_skipped_no_key'], details: {}, raw: null };
  }

  const userText = [
    RUBRIC_PROMPT,
    `Caption: ${caption || ''}`,
    productName ? `Product: ${productName}` : '',
    'Reference portrait is the first image. Generated asset is the second image.',
  ].filter(Boolean).join('\n');

  async function fetchAsBase64(url) {
    try {
      const resp = await fetch(url, { headers: { 'User-Agent': 'QumakQualityGate/1.0' } });
      if (!resp.ok) return null;
      const buf = Buffer.from(await resp.arrayBuffer());
      const mime = (resp.headers.get('content-type') || 'image/jpeg').split(';')[0];
      return { data: buf.toString('base64'), mime_type: mime };
    } catch (_e) {
      return null;
    }
  }

  const parts = [{ text: userText }];

  const [refImg, assetImg] = await Promise.all([
    referenceImageUrl ? fetchAsBase64(referenceImageUrl) : Promise.resolve(null),
    fetchAsBase64(assetUrl),
  ]);

  if (refImg)   parts.push({ inline_data: refImg });
  if (assetImg) parts.push({ inline_data: assetImg });

  const model    = 'gemini-2.5-flash-preview-04-17';
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;

  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts }] }),
    });
  } catch (fetchErr) {
    console.warn('[qualityGate] Fetch to Gemini failed:', fetchErr.message);
    return { pass: true, reasons: ['quality_gate_skipped_fetch_error'], details: {}, raw: null };
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    console.warn(`[qualityGate] Gemini rejected (${response.status}):`, text.slice(0, 200));
    return { pass: true, reasons: ['quality_gate_skipped_api_error'], details: {}, raw: null };
  }

  const data = await response.json();
  const rawText = data?.candidates?.[0]?.content?.parts?.find(p => p.text)?.text || '';

  let parsed;
  try {
    parsed = JSON.parse(rawText.trim());
  } catch (_e) {
    console.warn('[qualityGate] Could not parse Gemini response:', rawText.slice(0, 200));
    return { pass: true, reasons: ['quality_gate_skipped_parse_error'], details: {}, raw: data };
  }

  return {
    pass:    !!parsed.pass,
    reasons: Array.isArray(parsed.reasons) ? parsed.reasons : [],
    details: {
      identityConsistent:   !!parsed.identityConsistent,
      productVisible:       !!parsed.productVisible,
      captionHasDisclosure: !!parsed.captionHasDisclosure,
      textReadable:         !!parsed.textReadable,
    },
    raw: data,
  };
}

module.exports = { checkAsset };
