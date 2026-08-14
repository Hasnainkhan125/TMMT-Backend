'use strict';

/**
 * Mock “Anthropic conclusion” + creative-director workflow for brand intel.
 * Replace `concludeBrandIntelMock` with a real Messages API call when wiring production.
 */

const { buildMockScanPayload } = require('./snapshotToFrontendScan');

/**
 * Pinterest-style reference tiles (mock). Production: replace with Apify Pinterest actor output.
 * @returns {object[]}
 */
function mockDirectorTemplatesFromPinterest() {
  return [
    {
      id: 'pin-mock-1',
      title: 'Bold product hero — neon edge',
      mood: 'high-energy',
      paletteHint: ['#0a0a0a', '#ff3366', '#f5f5f5'],
      imageUrl: 'https://placehold.co/1080x1350/0a0a0a/ff3366/png?text=Mock+Pinterest+Ref+1',
      pinUrl: 'https://www.pinterest.com/pin/mock-board/1',
      source: 'mock_pinterest',
    },
    {
      id: 'pin-mock-2',
      title: 'Lifestyle pour — soft daylight',
      mood: 'trust',
      paletteHint: ['#e8dfd0', '#2c2c2c', '#7d6b52'],
      imageUrl: 'https://placehold.co/1080x1350/e8dfd0/2c2c2c/png?text=Mock+Pinterest+Ref+2',
      pinUrl: 'https://www.pinterest.com/pin/mock-board/2',
      source: 'mock_pinterest',
    },
    {
      id: 'pin-mock-3',
      title: 'UGC selfie + packshot split',
      mood: 'authentic',
      paletteHint: ['#ffffff', '#111111', '#00c853'],
      imageUrl: 'https://placehold.co/1080x1920/ffffff/111111/png?text=Mock+Pinterest+Ref+9:16',
      pinUrl: 'https://www.pinterest.com/pin/mock-board/3',
      source: 'mock_pinterest',
    },
  ];
}

/**
 * Build an image-to-image / reference-guided prompt for “clone this ad” flows.
 *
 * @param {object} p
 * @param {string} p.brandName
 * @param {string} [p.referenceImageUrl] — competitor still, Pinterest tile, or user upload
 * @param {string} [p.referenceAdId]
 * @param {string} [p.aspectRatio] — e.g. '1:1', '4:5', '9:16'
 * @param {string} [p.userNotes]
 * @param {string[]} [p.directorTemplateIds] — selected mock (or real) template ids
 * @returns {{ system: string, user: string, negativePrompt: string, targetPixels: { width: number, height: number } }}
 */
function buildCloneAdPrompt({
  brandName,
  referenceImageUrl = '',
  referenceAdId = '',
  aspectRatio = '4:5',
  userNotes = '',
  directorTemplateIds = [],
} = {}) {
  const templates = mockDirectorTemplatesFromPinterest();
  const selected = templates.filter((t) => directorTemplateIds.includes(t.id));
  const refList = [
    referenceImageUrl && `Primary reference (competitor / user): ${referenceImageUrl}`,
    ...selected.map((t) => `Director template [${t.id}] "${t.title}": ${t.imageUrl} (${t.mood})`),
  ]
    .filter(Boolean)
    .join('\n');

  const targetPixels =
    aspectRatio === '9:16'
      ? { width: 2160, height: 3840 }
      : aspectRatio === '1:1'
        ? { width: 4096, height: 4096 }
        : { width: 3276, height: 4096 }; // 4:5 @ ~4K class

  const system = [
    'You are an elite performance creative director.',
    'Produce ONE precise image-generation brief for a reference-guided model (e.g. image-to-image or multi-reference).',
    'Demand commercial polish: sharp typography hierarchy, clean margins, brand-safe legibility, no warped fingers, no illegible micro-text.',
    `Target canvas: ${targetPixels.width}×${targetPixels.height}px (${aspectRatio}).`,
    referenceAdId && `Inspiration ad id (metadata only): ${referenceAdId}.`,
  ]
    .filter(Boolean)
    .join(' ');

  const user = [
    `Brand: ${brandName || 'Unknown brand'}.`,
    'Objective: net-new ad creative that FEELS inspired by the references but is legally distinct — new layout, new copy, new composition.',
    refList && `References:\n${refList}`,
    userNotes && `Client notes: ${userNotes}`,
    'Output: (1) headline (max 8 words) (2) primary text 90–120 words (3) CTA (4) detailed scene description for the image model (5) list of must-keep brand cues.',
  ]
    .filter(Boolean)
    .join('\n\n');

  const negativePrompt =
    'watermark, stock photo cliché, blurry, low resolution, deformed hands, extra fingers, mangled text, logo of competitor, exact copy of reference';

  return { system, user, negativePrompt, targetPixels, aspectRatio };
}

/**
 * Mock LLM conclusion JSON for frontend panels (battlefield summary + CTA to generate).
 *
 * @param {object} scanPayload — output of buildMockScanPayload()
 * @returns {object}
 */
function concludeBrandIntelMock(scanPayload) {
  const brand = scanPayload?.brand?.name || 'Your brand';
  const totalAds = scanPayload?.apifyData?.competitorAdsSummary?.totalAds ?? 0;
  const withVideo = scanPayload?.apifyData?.competitorAdsSummary?.withVideo ?? 0;

  return {
    executiveSummary: `${brand}: we indexed ${totalAds} Meta Ad Library creatives (${withVideo} video-heavy). Use competitor motion and hooks as inspiration — regenerate originals, do not copy assets verbatim.`,
    differentiators: [
      'Own the same hooks with fresh compositions',
      'Match or beat their CTA clarity in your category',
      'Push 4K-class masters for paid social crops',
    ],
    competitorCreativePatterns: [
      { name: 'Problem → product reveal', frequency: 'high', suggestion: 'Open on tension, resolve with packshot + offer' },
      { name: 'UGC talking head', frequency: 'medium', suggestion: 'Use authentic talent; avoid lookalike of competitor talent' },
    ],
    recommendedNextSteps: [
      'Pick 2–3 winning competitor ads in the panel',
      'Request a clone prompt with your choice of reference image',
      'Blend a Pinterest director template for art direction',
      'Render 1:1, 4:5, and 9:16 from the same master',
    ],
    generateYourOwnAds: {
      headline: 'Turn competitor intelligence into originals',
      body:
        'Select any preview (image or video still), open “Clone with director”, and we will assemble references: competitor frame + Pinterest board tile + your brand kit.',
      whyClone: 'You keep what converts (structure, pacing, offer type) while replacing every pixel and line of copy.',
    },
    cloneWorkflow: {
      steps: [
        { id: 'pick-reference', title: 'Pick reference', description: 'Competitor ad still, Pinterest template, or upload.' },
        { id: 'request-prompt', title: 'Generate prompt', description: 'Mock LLM returns structured brief + negatives.' },
        { id: 'render-4k', title: 'Render master', description: 'Target ~4K class; derive social crops downstream.' },
      ],
      imageGenerationSpec: {
        targetResolutionLabel: '4K-class master',
        aspectRatios: ['1:1', '4:5', '9:16'],
        guidance:
          'Use reference conditioning; increase sharpness and typography weight for mobile legibility. Export PNG masters before compression.',
      },
    },
    directorBoard: {
      source: 'pinterest_mosaic_mock',
      note: 'Swap mockDirectorTemplatesFromPinterest() with Apify Pinterest scraper results when wired.',
      templates: mockDirectorTemplatesFromPinterest(),
    },
    _mock: true,
    _model: 'mock-anthropic-placeholder',
  };
}

/**
 * End-to-end mock: snapshot JSON → frontend scan + conclusion.
 *
 * @param {object} snapshot
 * @param {{ scanId?: string }} [opts]
 */
function snapshotToMockApiResponse(snapshot, opts = {}) {
  const scanPayload = buildMockScanPayload(snapshot, { scanId: opts.scanId });
  const conclusion = concludeBrandIntelMock(scanPayload);
  return {
    scan: { ...scanPayload, intelligence: conclusion },
    conclusion,
    clonePromptExample: buildCloneAdPrompt({
      brandName: scanPayload.brand?.name,
      referenceImageUrl: 'https://placehold.co/800x800/png?text=Competitor+still',
      referenceAdId: 'demo-ad',
      aspectRatio: '4:5',
      userNotes: 'Energy drink, bold, night city',
      directorTemplateIds: ['pin-mock-1'],
    }),
  };
}

module.exports = {
  mockDirectorTemplatesFromPinterest,
  buildCloneAdPrompt,
  concludeBrandIntelMock,
  snapshotToMockApiResponse,
};
