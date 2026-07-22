'use strict';

/**
 * influencerService — Phase 6 unit tests.
 *
 * Same strategy as adSetService.test.js — stub Mongo, queues, modelRouter,
 * creditsService and adSetService so the pure pieces (prompt composition,
 * persona create, scene dispatch) run in isolation. Worker behaviour is
 * covered by the integration harness.
 */

jest.mock('../model/schema/persona', () => {
  // We stub the Mongoose model with a factory so `Persona.create(doc)` in
  // the service returns an object that also has `.save()` (the service
  // mutates + saves after creation). `findById(id)` returns a chainable
  // mock where `.lean()` returns the stored doc directly.
  const _store = new Map();
  const createDoc = (doc) => {
    const id = doc._id || `persona_${_store.size + 1}`;
    const entity = {
      _id: id,
      toString: () => id,
      ...doc,
      save: jest.fn(async function save() {
        _store.set(this._id.toString(), { ...this });
        return this;
      }),
    };
    _store.set(id.toString(), { ...entity });
    return entity;
  };
  const Persona = {
    create: jest.fn(async (doc) => createDoc(doc)),
    // Return the live object so mutations inside the service are visible
    // when we inspect it from the test.
    findById: jest.fn((id) => {
      const live = _store.get(id?.toString());
      const chain = {
        lean: () => Promise.resolve(live ? { ...live } : null),
      };
      return Object.assign(Promise.resolve(live || null), chain);
    }),
    find: jest.fn(() => ({
      sort: () => ({ skip: () => ({ limit: () => ({ lean: () => Promise.resolve([]) }) }) }),
    })),
    _store,
    _reset: () => _store.clear(),
  };
  return Persona;
});

jest.mock('../model/schema/studioJob', () => {
  const _store = new Map();
  return {
    create: jest.fn(async (doc) => {
      // Respect an explicit _id so tests can seed fixtures under known ids
      // ("job_hero"). Auto-generate otherwise so the happy path works.
      const id = doc?._id || `job_${_store.size + 1}`;
      const job = { ...doc, _id: id, id, toString: () => id };
      _store.set(id.toString(), job);
      return job;
    }),
    findById: jest.fn((id) => {
      const live = _store.get(id?.toString());
      const chain = { lean: () => Promise.resolve(live ? { ...live } : null) };
      return Object.assign(Promise.resolve(live || null), chain);
    }),
    find: jest.fn(() => ({
      sort: () => ({ limit: () => ({ lean: () => Promise.resolve([]) }) }),
    })),
    _store,
    _reset: () => _store.clear(),
  };
});

jest.mock('../model/schema/studioAsset', () => ({
  findById: jest.fn(),
}));

jest.mock('../services/queues', () => ({
  enqueueStudioJob: jest.fn(async () => ({})),
}));

jest.mock('../services/creditsService', () => ({
  getBalance: jest.fn(async () => 10_000),
  quote:       jest.fn(async () => 4),
  chargeForJob: jest.fn(async () => ({})),
}));

jest.mock('../services/modelRouter', () => ({
  route: jest.fn(async ({ requestedModelId, kind, referenceImageUrl }) => ({
    modelId: requestedModelId || (kind === 'video' ? 'kling_v3_pro' : 'flux_pro'),
    provider: 'fal',
    falModelId: 'fal-ai/mock',
    input: { prompt: 'MOCK', ...(referenceImageUrl ? { image_url: referenceImageUrl } : {}) },
    creditsCost: 4,
    kind,
    label: requestedModelId || 'Mock Model',
  })),
  resolveModel: jest.fn(),
}));

jest.mock('../services/adSetService', () => ({
  enqueueAdSet: jest.fn(async ({ inputs }) => ({
    adSetId: 'adset_1',
    numVariants: inputs.numVariants,
    totalCreditsCost: inputs.numVariants * 4,
    childJobIds: Array.from({ length: inputs.numVariants }, (_, i) => `job_${i + 1}`),
    sessionId: 'session-xyz',
  })),
}));

const influencerService = require('../services/influencerService');
const Persona           = require('../model/schema/persona');
const StudioJob         = require('../model/schema/studioJob');
const modelRouter       = require('../services/modelRouter');
const adSetService      = require('../services/adSetService');
const queues            = require('../services/queues');
const creditsService    = require('../services/creditsService');

// ─────────────────────────────────────────────────────────────────────────────

const OWNER = {
  user: { _id: 'user_1', role: 'user', plan: 'pro' },
  cookies: { qumak_session: 'session-abc' },
};

const ADMIN = {
  user: { _id: 'user_admin', role: 'admin', plan: 'agency' },
  cookies: { qumak_session: 'session-admin' },
};

afterEach(() => {
  jest.clearAllMocks();
  Persona._reset();
  StudioJob._reset();
  // Re-install default implementations — jest.clearAllMocks wipes .calls
  // but NOT .mockImplementation, *unless* a prior test queued a
  // mockResolvedValueOnce that wasn't consumed. Resetting the default
  // defensively prevents leakage across tests.
  creditsService.getBalance.mockReset().mockImplementation(async () => 10_000);
  creditsService.quote.mockReset().mockImplementation(async () => 4);
  creditsService.chargeForJob.mockReset().mockImplementation(async () => ({}));
  modelRouter.route.mockReset().mockImplementation(async ({ requestedModelId, kind, referenceImageUrl }) => ({
    modelId: requestedModelId || (kind === 'video' ? 'kling_v3_pro' : 'flux_pro'),
    provider: 'fal',
    falModelId: 'fal-ai/mock',
    input: { prompt: 'MOCK', ...(referenceImageUrl ? { image_url: referenceImageUrl } : {}) },
    creditsCost: 4,
    kind,
    label: requestedModelId || 'Mock Model',
  }));
  adSetService.enqueueAdSet.mockReset().mockImplementation(async ({ inputs }) => ({
    adSetId: 'adset_1',
    numVariants: inputs.numVariants,
    totalCreditsCost: inputs.numVariants * 4,
    childJobIds: Array.from({ length: inputs.numVariants }, (_, i) => `job_${i + 1}`),
    sessionId: 'session-xyz',
  }));
});

// ─── buildPromptFromAttrs ────────────────────────────────────────────────────

describe('buildPromptFromAttrs', () => {
  test('uses the canonical fallback when no characterType is given', () => {
    const p = influencerService.buildPromptFromAttrs({});
    expect(p).toMatch(/a confident person/);
    expect(p).toMatch(/editorial portrait/);
  });

  test('maps vocabulary to cinematic phrases (not raw UI values)', () => {
    const p = influencerService.buildPromptFromAttrs({
      characterType: 'Elf',
      gender: 'Non-binary',
      ethnicity: 'Middle Eastern',
      eyeColor: 'Green',
      skinMaterial: 'Scales',
      horns: 'Antlers',
      age: 'Mature',
    });
    expect(p).toMatch(/high-fantasy elf/);
    expect(p).toMatch(/non-binary/);
    expect(p).toMatch(/Middle Eastern \/ Khaleeji heritage/);
    expect(p).toMatch(/striking green eyes/);
    expect(p).toMatch(/iridescent scaled skin/);
    expect(p).toMatch(/branching antlers/);
    expect(p).toMatch(/in their 40s/);
    expect(p).not.toMatch(/\bElf\b/);  // raw UI value should be rewritten
  });

  test('hoists userPrompt to the front as USER INTENT', () => {
    const p = influencerService.buildPromptFromAttrs(
      { characterType: 'Human' },
      'on a Marina rooftop at golden hour',
    );
    expect(p.startsWith('USER INTENT: on a Marina rooftop')).toBe(true);
  });

  test('unknown values pass through verbatim (forward-compatible vocabulary)', () => {
    const p = influencerService.buildPromptFromAttrs({
      characterType: 'Elf',
      eyeColor: 'Luminescent Teal',  // not in the phrase map
    });
    expect(p).toMatch(/Luminescent Teal/);
  });

  test('body/style/face descriptions appear as labelled sections', () => {
    const p = influencerService.buildPromptFromAttrs({
      bodyDescription: 'athletic build, 5\'9"',
      styleDescription: 'streetwear, charcoal blazer',
      faceDescription: 'high cheekbones',
    });
    expect(p).toMatch(/body: athletic build, 5'9"/);
    expect(p).toMatch(/style: streetwear, charcoal blazer/);
    expect(p).toMatch(/face: high cheekbones/);
  });
});

// ─── buildScenePrompt ────────────────────────────────────────────────────────

describe('buildScenePrompt', () => {
  test('anchors with SAME PERSON FROM REFERENCE and includes scene tokens', () => {
    const persona = {
      attributes: {
        characterType: 'Human',
        gender: 'Female',
        ethnicity: 'Middle Eastern',
        age: 'Adult',
      },
    };
    const p = influencerService.buildScenePrompt({
      persona,
      scenePrompt: 'walking along Marina promenade at sunset',
    });
    expect(p).toMatch(/^SAME PERSON FROM REFERENCE/);
    expect(p).toMatch(/a confident human person/);
    expect(p).toMatch(/female-presenting/);
    expect(p).toMatch(/Middle Eastern \/ Khaleeji heritage/);
    expect(p).toMatch(/SCENE: walking along Marina promenade at sunset/);
    expect(p).toMatch(/preserve facial identity from reference/);
  });

  test('degrades gracefully when persona attributes are empty', () => {
    const p = influencerService.buildScenePrompt({
      persona: { attributes: {} },
      scenePrompt: 'in a bookstore',
    });
    expect(p).toMatch(/the same person from the reference image/);
    expect(p).toMatch(/SCENE: in a bookstore/);
  });
});

// ─── createPersona ───────────────────────────────────────────────────────────

describe('createPersona', () => {
  test('imported reference path skips rendering and flips to ready', async () => {
    const { persona, jobId, creditsCost } = await influencerService.createPersona({
      req: OWNER,
      inputs: {
        name: 'Layla',
        kind: 'influencer',
        attributes: { characterType: 'Human', gender: 'Female' },
        importedReferenceUrl: 'https://cdn.qumak.com/hero.jpg',
      },
    });

    expect(persona.status).toBe('ready');
    expect(persona.heroImageUrl).toBe('https://cdn.qumak.com/hero.jpg');
    expect(persona.importedReferenceUrl).toBe('https://cdn.qumak.com/hero.jpg');
    expect(jobId).toBeNull();
    expect(creditsCost).toBeUndefined();
    expect(modelRouter.route).not.toHaveBeenCalled();
    expect(queues.enqueueStudioJob).not.toHaveBeenCalled();
    expect(creditsService.chargeForJob).not.toHaveBeenCalled();
  });

  test('standard path routes through modelRouter with the requested hero model', async () => {
    const { persona, jobId, creditsCost } = await influencerService.createPersona({
      req: OWNER,
      inputs: {
        name: 'Layla',
        kind: 'influencer',
        attributes: { characterType: 'Human', gender: 'Female', ethnicity: 'Middle Eastern' },
        userPrompt: 'warm editorial portrait',
        modelId: 'nano_banana_pro',
        aspectRatio: '4:5',
      },
    });

    expect(persona.status).toBe('generating');
    expect(persona.name).toBe('Layla');
    expect(persona.seedModelId).toBe('nano_banana_pro');
    expect(jobId).toMatch(/^job_/);
    expect(creditsCost).toBe(4);

    expect(modelRouter.route).toHaveBeenCalledWith(expect.objectContaining({
      requestedModelId: 'nano_banana_pro',
      kind: 'image',
      aspectRatio: '4:5',
    }));
    // Hero render must NOT pass a referenceImageUrl — the hero IS the reference.
    const routedArgs = modelRouter.route.mock.calls[0][0];
    expect(routedArgs.referenceImageUrl).toBeUndefined();

    expect(creditsService.chargeForJob).toHaveBeenCalledTimes(1);
    expect(queues.enqueueStudioJob).toHaveBeenCalledTimes(1);
  });

  test('defaults the hero model by kind when caller omits modelId', async () => {
    await influencerService.createPersona({
      req: OWNER,
      inputs: {
        kind: 'character',
        attributes: { characterType: 'Alien' },
      },
    });
    const routedArgs = modelRouter.route.mock.calls[0][0];
    expect(routedArgs.requestedModelId).toBe(influencerService._constants.DEFAULT_HERO_MODELS.character);
  });

  test('admin role skips the credits gate entirely', async () => {
    creditsService.getBalance.mockResolvedValueOnce(0);  // would fail non-admin
    const { persona } = await influencerService.createPersona({
      req: ADMIN,
      inputs: { name: 'Boss', attributes: { characterType: 'Human' } },
    });
    expect(persona.status).toBe('generating');
    expect(creditsService.getBalance).not.toHaveBeenCalled();
    expect(creditsService.chargeForJob).not.toHaveBeenCalled();
  });

  test('throws insufficient_credits when balance < hero cost (non-admin)', async () => {
    creditsService.getBalance.mockResolvedValueOnce(1);
    await expect(influencerService.createPersona({
      req: OWNER,
      inputs: { name: 'Poor', attributes: { characterType: 'Human' } },
    })).rejects.toMatchObject({ code: 'insufficient_credits', required: 4, balance: 1 });
    // Persona must not have been created for a failed credit gate.
    expect(Persona.create).not.toHaveBeenCalled();
    expect(queues.enqueueStudioJob).not.toHaveBeenCalled();
  });

  test('zod rejects payloads with empty attribute coercion errors', async () => {
    await expect(influencerService.createPersona({
      req: OWNER,
      inputs: { name: '', kind: 'not-a-kind' },
    })).rejects.toBeDefined();
  });
});

// ─── generateScene ───────────────────────────────────────────────────────────

describe('generateScene', () => {
  async function createReadyPersona(overrides = {}) {
    const persona = await Persona.create({
      _id: 'persona_ready',
      userId: OWNER.user._id,
      sessionId: OWNER.cookies.qumak_session,
      name: 'Layla',
      kind: 'influencer',
      attributes: { characterType: 'Human', gender: 'Female' },
      status: 'ready',
      heroImageUrl: 'https://cdn.qumak.com/layla-hero.jpg',
      sceneCount: 0,
      ...overrides,
    });
    return persona;
  }

  test('rejects when persona is not ready', async () => {
    await Persona.create({
      _id: 'persona_generating',
      userId: OWNER.user._id,
      sessionId: OWNER.cookies.qumak_session,
      name: 'Half-baked',
      kind: 'influencer',
      status: 'generating',
    });
    await expect(influencerService.generateScene({
      req: OWNER,
      personaId: 'persona_generating',
      inputs: { scenePrompt: 'at a café' },
    })).rejects.toMatchObject({ code: 'persona_hero_not_ready' });
  });

  test('rejects when persona is missing', async () => {
    await expect(influencerService.generateScene({
      req: OWNER,
      personaId: 'does_not_exist',
      inputs: { scenePrompt: 'at a café' },
    })).rejects.toMatchObject({ code: 'persona_not_found' });
  });

  test('single-variant path enqueues one job with the hero URL as reference', async () => {
    const persona = await createReadyPersona();
    const result = await influencerService.generateScene({
      req: OWNER,
      personaId: persona._id,
      inputs: { scenePrompt: 'at a Dubai rooftop café at golden hour', kind: 'image', numVariants: 1 },
    });

    expect(result.kind).toBe('single');
    expect(result.jobId).toMatch(/^job_/);
    expect(result.creditsCost).toBe(4);

    // The hero URL must have been threaded into the modelRouter call.
    const routedArgs = modelRouter.route.mock.calls[0][0];
    expect(routedArgs.referenceImageUrl).toBe('https://cdn.qumak.com/layla-hero.jpg');
    expect(routedArgs.kind).toBe('image');
    // Default scene model (no modelId supplied).
    expect(routedArgs.requestedModelId).toBe(influencerService._constants.DEFAULT_SCENE_MODELS.image);

    expect(adSetService.enqueueAdSet).not.toHaveBeenCalled();
    expect(queues.enqueueStudioJob).toHaveBeenCalledTimes(1);

    // Persona usage counters bumped.
    const after = Persona._store.get('persona_ready');
    expect(after.sceneCount).toBe(1);
    expect(after.lastUsedAt).toBeInstanceOf(Date);
  });

  test('multi-variant path delegates to adSetService with reference glued in', async () => {
    const persona = await createReadyPersona();
    const result = await influencerService.generateScene({
      req: OWNER,
      personaId: persona._id,
      inputs: {
        scenePrompt: 'at a Dubai rooftop café at golden hour',
        kind: 'image',
        numVariants: 4,
      },
    });

    expect(result.kind).toBe('ad_set');
    expect(result.adSetId).toBe('adset_1');
    expect(result.numVariants).toBe(4);

    expect(adSetService.enqueueAdSet).toHaveBeenCalledTimes(1);
    const adArgs = adSetService.enqueueAdSet.mock.calls[0][0].inputs;
    expect(adArgs.referenceImageUrl).toBe('https://cdn.qumak.com/layla-hero.jpg');
    expect(adArgs.numVariants).toBe(4);
    expect(adArgs.extras).toMatchObject({ personaId: 'persona_ready', isPersonaScene: true });
    // Copy gen is off by default for persona scenes — persona IS the product.
    expect(adArgs.generateCopy).toBe(false);

    // Scene count incremented by the number of variants, not one.
    const after = Persona._store.get('persona_ready');
    expect(after.sceneCount).toBe(4);
  });

  test('video scenes default to the video scene model and set durationSec', async () => {
    const persona = await createReadyPersona();
    const result = await influencerService.generateScene({
      req: OWNER,
      personaId: persona._id,
      inputs: { scenePrompt: 'walking through Marina', kind: 'video', numVariants: 1, durationSec: 6 },
    });
    expect(result.kind).toBe('single');

    const routedArgs = modelRouter.route.mock.calls[0][0];
    expect(routedArgs.kind).toBe('video');
    expect(routedArgs.durationSec).toBe(6);
    expect(routedArgs.requestedModelId).toBe(influencerService._constants.DEFAULT_SCENE_MODELS.video);
  });

  test('forbids cross-session access to a persona', async () => {
    await createReadyPersona();
    const OTHER = { user: null, cookies: { qumak_session: 'stranger-session' } };
    await expect(influencerService.generateScene({
      req: OTHER,
      personaId: 'persona_ready',
      inputs: { scenePrompt: 'anywhere' },
    })).rejects.toMatchObject({ code: 'forbidden' });
  });
});

// ─── finalizeHero ────────────────────────────────────────────────────────────

describe('finalizeHero', () => {
  async function seedPersonaWithJob(jobState) {
    await Persona.create({
      _id: 'persona_pending',
      userId: OWNER.user._id,
      sessionId: OWNER.cookies.qumak_session,
      name: 'Hero Test',
      kind: 'influencer',
      status: 'generating',
      heroJobId: 'job_hero',
    });
    await StudioJob.create({ _id: 'job_hero', ...jobState });
  }

  test('no-op when persona is already ready', async () => {
    await Persona.create({
      _id: 'persona_already_ready',
      userId: OWNER.user._id,
      sessionId: OWNER.cookies.qumak_session,
      name: 'Already',
      status: 'ready',
      heroImageUrl: 'https://cdn/x.jpg',
    });
    const result = await influencerService.finalizeHero('persona_already_ready', {
      userId: OWNER.user._id, sessionId: OWNER.cookies.qumak_session,
    });
    expect(result.status).toBe('ready');
  });

  test('stamps hero URL when the hero job completed', async () => {
    await seedPersonaWithJob({
      status: 'completed',
      output: { storedImageUrl: 'https://cdn/hero.jpg', thumbnailUrl: 'https://cdn/thumb.jpg' },
      assetId: 'asset_1',
    });
    const result = await influencerService.finalizeHero('persona_pending', {
      userId: OWNER.user._id, sessionId: OWNER.cookies.qumak_session,
    });
    expect(result.status).toBe('ready');
    expect(result.heroImageUrl).toBe('https://cdn/hero.jpg');
    expect(result.heroThumbnailUrl).toBe('https://cdn/thumb.jpg');
  });

  test('flips to failed when the hero job failed', async () => {
    await seedPersonaWithJob({ status: 'failed', output: {} });
    const result = await influencerService.finalizeHero('persona_pending', {
      userId: OWNER.user._id, sessionId: OWNER.cookies.qumak_session,
    });
    expect(result.status).toBe('failed');
  });

  test('still generating when the hero job is not terminal', async () => {
    await seedPersonaWithJob({ status: 'generating', output: {} });
    const result = await influencerService.finalizeHero('persona_pending', {
      userId: OWNER.user._id, sessionId: OWNER.cookies.qumak_session,
    });
    expect(result.status).toBe('generating');  // unchanged
  });
});
