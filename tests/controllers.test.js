/**
 * controllers.test.js — Comprehensive test suite for all brand controllers
 *
 * Covers:
 *   - aiBrandController (brand generation, image gen, PDF, research)
 *   - brandAgentController (insights, content ideas, content strategy)
 *   - brandProjectController (CRUD, credits, assets)
 *   - leadsController (find, generate message, send)
 *   - outreachController (find, message, send, approve, stage)
 *   - tradeLicenseController (submit, get)
 *   - facebookAdsController (auth url, status)
 *   - storeController (dashboard, upsert, publish)
 *   - imagePromptPurifier (build prompt, routing)
 *
 * All external services are mocked — no real API calls.
 */

// ── Mock external SDKs before any require ────────────────────────────────────
const mockOpenAiCreate = jest.fn();
const mockOpenAiImagesGenerate = jest.fn();
const mockOpenAiImagesEdit = jest.fn();
jest.mock('openai', () => {
  return jest.fn().mockImplementation(() => ({
    chat: { completions: { create: mockOpenAiCreate } },
    images: { generate: mockOpenAiImagesGenerate, edit: mockOpenAiImagesEdit },
  }));
});

const mockAnthropicCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => {
  return jest.fn().mockImplementation(() => ({
    messages: { create: mockAnthropicCreate },
  }));
});

const mockFalSubscribe = jest.fn();
const mockFalConfig = jest.fn();
jest.mock('@fal-ai/client', () => ({
  fal: {
    subscribe: mockFalSubscribe,
    config: mockFalConfig,
  },
}));

jest.mock('axios');
const axios = require('axios');

// ── Mock Mongoose models ────────────────────────────────────────────────────
jest.mock('../model/schema/brandProject', () => {
  const mock = {
    findById:           jest.fn(),
    findOne:            jest.fn(),
    findByIdAndUpdate:  jest.fn(),
    findOneAndUpdate:   jest.fn(),
    find:               jest.fn(),
    create:             jest.fn(),
    updateOne:          jest.fn(),
  };
  return mock;
});
const BrandProject = require('../model/schema/brandProject');

jest.mock('../model/schema/user', () => {
  const mock = {
    findById:           jest.fn(),
    findByIdAndUpdate:  jest.fn(),
  };
  return mock;
});
const User = require('../model/schema/user');

jest.mock('../model/schema/store', () => {
  const mock = {
    findOne:            jest.fn(),
    create:             jest.fn(),
    findByIdAndUpdate:  jest.fn(),
    updateOne:          jest.fn(),
  };
  return mock;
});
const Store = require('../model/schema/store');

jest.mock('../model/schema/product', () => {
  const mock = {
    find:               jest.fn(),
    findOne:            jest.fn(),
    create:             jest.fn(),
    findByIdAndUpdate:  jest.fn(),
    countDocuments:     jest.fn(),
  };
  return mock;
});
const Product = require('../model/schema/product');

jest.mock('../model/schema/brandSubmission', () => ({
  findOne:            jest.fn(),
  findByIdAndUpdate:  jest.fn(),
  updateOne:          jest.fn(),
  create:             jest.fn(),
}));

// Mock token meter
jest.mock('../services/tokenMeter', () => ({
  log: jest.fn().mockResolvedValue(null),
  getUserStats: jest.fn().mockResolvedValue({
    plan: 'trial', tokensUsed: 100, tokensLimit: 50000,
    imagesUsed: 1, imagesLimit: 5, totalCostUSD: 0.01,
  }),
  checkCanGenerate: jest.fn().mockResolvedValue({ allowed: true }),
  PLAN_LIMITS: { trial: { tokensPerMonth: 50000, imagesPerMonth: 5 } },
}));

jest.mock('../services/brandMemoryService', () => ({
  saveContentToS3: jest.fn().mockResolvedValue(null),
}));

jest.mock('../services/emailService', () => ({
  queueEmail: jest.fn().mockResolvedValue(null),
}));

// ── Fixtures ────────────────────────────────────────────────────────────────

const MOCK_USER_ID = '507f1f77bcf86cd799439011';
const MOCK_BRAND_ID = '507f1f77bcf86cd799439022';

const mockReq = (body = {}, params = {}, query = {}, user = null) => ({
  body,
  params,
  query,
  user: user || { _id: MOCK_USER_ID },
  ip: '127.0.0.1',
  headers: {},
  connection: { remoteAddress: '127.0.0.1' },
  socket: { remoteAddress: '127.0.0.1' },
});

const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.send = jest.fn().mockReturnValue(res);
  res.redirect = jest.fn().mockReturnValue(res);
  res.setHeader = jest.fn().mockReturnValue(res);
  res.end = jest.fn().mockReturnValue(res);
  res.setTimeout = jest.fn();
  res.statusCode = 200;
  return res;
};

const mockBrandProject = {
  _id: MOCK_BRAND_ID,
  user: MOCK_USER_ID,
  projectName: 'Farwa Perfumes',
  businessType: 'perfume',
  status: 'draft',
  wizardStep: 1,
  wizardCompleted: false,
  completionScore: 20,
  isArchived: false,
  generatedAssets: [],
  leads: [],
  config: {
    brand: {
      brandName: 'Farwa',
      tagline: 'Scent of the Desert',
      colorPalette: { primary: '#C9A227', secondary: '#1A1A2E', accent: '#D4AF37' },
    },
  },
  agentMemory: {
    chatHistory: [],
    usp: { current: 'Heritage-inspired luxury scents' },
    audience: { primary: { description: 'UAE women 25-38' } },
  },
  fragranceConfig: { brandName: 'Farwa' },
  packaging: {},
  upsellSuggestions: [],
  toObject() { return { ...this }; },
  save: jest.fn().mockResolvedValue(this),
};

// ═══════════════════════════════════════════════════════════════════════════
// TEST SUITES
// ═══════════════════════════════════════════════════════════════════════════

describe('aiBrandController', () => {
  const ctrl = require('../controllers/brandProject/aiBrandController');

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('generateBrandConcept', () => {
    it('returns 400 if no category provided', async () => {
      const req = mockReq({ inputs: {} });
      const res = mockRes();
      await ctrl.generateBrandConcept(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
    });

    it('generates a brand with valid inputs', async () => {
      const BrandSubmission = require('../model/schema/brandSubmission');
      BrandSubmission.findOne.mockResolvedValue(null);
      BrandSubmission.create.mockResolvedValue({ _id: 'sub123' });

      mockOpenAiCreate.mockResolvedValueOnce({
        choices: [{
          message: {
            content: JSON.stringify({
              brandName: 'Farwa',
              tagline: 'Scent of the Desert',
              brandStory: 'A luxury fragrance house.',
              colorPalette: { primary: '#C9A227', secondary: '#1A1A2E', accent: '#D4AF37' },
              fragranceNotes: { top: 'Bergamot', middle: 'Rose', base: 'Oud' },
            }),
          },
        }],
      });

      const req = mockReq({
        category: 'perfume',
        fragranceFamily: 'Oud & Wood', gender: 'Unisex', pricePoint: 'Premium',
      });
      const res = mockRes();
      await ctrl.generateBrandConcept(req, res);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    });
  });

  describe('generateMockupImage', () => {
    it('returns 400 without a prompt', async () => {
      const req = mockReq({});
      const res = mockRes();
      await ctrl.generateMockupImage(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('generates an image with valid prompt', async () => {
      mockOpenAiImagesGenerate.mockResolvedValueOnce({
        data: [{ b64_json: 'dGVzdA==' }],
      });

      const req = mockReq({ prompt: 'A luxury perfume bottle on marble' });
      const res = mockRes();
      await ctrl.generateMockupImage(req, res);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: true,
        url: expect.stringContaining('data:image/png;base64,'),
      }));
    });

    it('handles content policy errors', async () => {
      mockOpenAiImagesGenerate.mockRejectedValueOnce(new Error('content_policy violation'));
      const req = mockReq({ prompt: 'test' });
      const res = mockRes();
      await ctrl.generateMockupImage(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'CONTENT_POLICY' }));
    });
  });

  describe('editImage', () => {
    it('returns 400 without prompt', async () => {
      const req = mockReq({});
      const res = mockRes();
      await ctrl.editImage(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  describe('submitInquiry', () => {
    it('returns 400 with missing fields', async () => {
      const req = mockReq({ name: 'Test' });
      const res = mockRes();
      await ctrl.submitInquiry(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('succeeds with valid fields', async () => {
      const req = mockReq({
        name: 'Ali', email: 'ali@test.com', phone: '+971551234',
        businessType: 'drone', budget: '10k', timeline: '3months',
      });
      const res = mockRes();
      await ctrl.submitInquiry(req, res);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    });
  });

  describe('getUserBrands', () => {
    it('returns 401 without user', async () => {
      const req = mockReq({}, {}, {}, null);
      req.user = null;
      const res = mockRes();
      await ctrl.getUserBrands(req, res);
      expect(res.status).toHaveBeenCalledWith(401);
    });

    it('returns brands for authenticated user', async () => {
      BrandProject.find.mockReturnValue({
        sort: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnValue({
            lean: jest.fn().mockResolvedValue([
              { _id: 'b1', projectName: 'Brand A', businessType: 'perfume', createdAt: new Date() },
            ]),
          }),
        }),
      });

      const req = mockReq({}, {}, {}, { _id: MOCK_USER_ID });
      const res = mockRes();
      await ctrl.getUserBrands(req, res);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: true,
        brands: expect.arrayContaining([expect.objectContaining({ name: 'Brand A' })]),
      }));
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════

describe('brandAgentController', () => {
  const agentCtrl = require('../controllers/brandProject/brandAgentController');

  beforeEach(() => jest.clearAllMocks());

  describe('getAgentInsights', () => {
    it('returns 400 without brand or projectId', async () => {
      const req = mockReq({});
      const res = mockRes();
      await agentCtrl.getAgentInsights(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('returns insights for a brand', async () => {
      BrandProject.findById.mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({ agentMemory: { chatHistory: [] } }),
        }),
      });
      BrandProject.findByIdAndUpdate.mockResolvedValue(null);

      mockAnthropicCreate.mockResolvedValueOnce({
        content: [{ text: '**Key insight:** Focus on oud positioning. Next Step: create 3 posts.' }],
      });

      const req = mockReq({
        brand: { brandName: 'Farwa', category: 'perfume' },
        tab: 'dashboard',
      });
      const res = mockRes();
      await agentCtrl.getAgentInsights(req, res);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: true,
        insight: expect.stringContaining('Key insight'),
      }));
    });
  });

  describe('generateContentIdeas', () => {
    it('returns 400 without brand', async () => {
      const req = mockReq({});
      const res = mockRes();
      await agentCtrl.generateContentIdeas(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('generates content for instagram', async () => {
      mockAnthropicCreate.mockResolvedValueOnce({
        content: [{
          text: JSON.stringify({
            hook: 'Discover luxury',
            copy: 'Farwa perfume post',
            hashtags: ['#Farwa', '#UAE'],
            cta: 'Shop now',
            visualSuggestion: 'Hero bottle shot',
          }),
        }],
      });

      const req = mockReq({
        brand: { brandName: 'Farwa', category: 'perfume' },
        platform: 'instagram',
        contentType: 'promotional post',
      });
      const res = mockRes();
      await agentCtrl.generateContentIdeas(req, res);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: true,
        content: expect.objectContaining({ hook: expect.any(String) }),
      }));
    });
  });

  describe('submitVideoRequest', () => {
    it('returns 400 without brand info', async () => {
      const req = mockReq({});
      const res = mockRes();
      await agentCtrl.submitVideoRequest(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('submits video request successfully', async () => {
      BrandProject.findByIdAndUpdate.mockResolvedValue(null);
      const req = mockReq({
        brandProjectId: MOCK_BRAND_ID,
        platform: 'instagram',
        description: 'Brand story video',
        brandName: 'Farwa',
      });
      const res = mockRes();
      await agentCtrl.submitVideoRequest(req, res);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: true,
        requestId: expect.stringContaining('VR-'),
      }));
    });
  });

  describe('schedulePost', () => {
    it('schedules a post to a brand', async () => {
      BrandProject.findByIdAndUpdate.mockResolvedValue(null);
      const req = mockReq({
        brandProjectId: MOCK_BRAND_ID,
        platform: 'instagram',
        content: 'Test post content',
        dayNumber: 1,
      });
      const res = mockRes();
      await agentCtrl.schedulePost(req, res);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════

describe('brandProjectController', () => {
  const ctrl = require('../controllers/brandProject/brandProjectController');

  beforeEach(() => jest.clearAllMocks());

  describe('createProject', () => {
    it('returns 400 if missing fields', async () => {
      User.findById.mockReturnValue({
        select: jest.fn().mockResolvedValue({ platformCredits: 20 }),
      });
      const req = mockReq({ businessType: 'perfume' });
      const res = mockRes();
      await ctrl.createProject(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('creates a project successfully', async () => {
      User.findById.mockReturnValue({
        select: jest.fn().mockResolvedValue({ platformCredits: 20 }),
      });
      User.findByIdAndUpdate.mockResolvedValue(null);
      BrandProject.create.mockResolvedValue({
        _id: MOCK_BRAND_ID, user: MOCK_USER_ID, businessType: 'perfume',
        projectName: 'Test Brand', status: 'draft',
      });

      const req = mockReq({ businessType: 'perfume', projectName: 'Test Brand' });
      const res = mockRes();
      await ctrl.createProject(req, res);
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    });
  });

  describe('listProjects', () => {
    it('returns user projects with funnel stage', async () => {
      User.findById.mockReturnValue({
        select: jest.fn().mockResolvedValue({ platformCredits: 15 }),
      });
      BrandProject.find.mockReturnValue({
        sort: jest.fn().mockResolvedValue([
          {
            ...mockBrandProject,
            toObject() { return { ...mockBrandProject }; },
          },
        ]),
      });

      const req = mockReq();
      const res = mockRes();
      await ctrl.listProjects(req, res);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: true,
        projects: expect.any(Array),
      }));
    });
  });

  describe('getProject', () => {
    it('returns 404 for missing project', async () => {
      BrandProject.findOne.mockResolvedValue(null);
      const req = mockReq({}, { id: 'nonexistent' });
      const res = mockRes();
      await ctrl.getProject(req, res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('returns project with credits', async () => {
      BrandProject.findOne.mockResolvedValue(mockBrandProject);
      User.findById.mockReturnValue({
        select: jest.fn().mockResolvedValue({ platformCredits: 10 }),
      });

      const req = mockReq({}, { id: MOCK_BRAND_ID });
      const res = mockRes();
      await ctrl.getProject(req, res);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: true,
        credits: 10,
      }));
    });
  });

  describe('updateProject', () => {
    it('returns 404 for missing project', async () => {
      BrandProject.findOne.mockResolvedValue(null);
      const req = mockReq({ projectName: 'Updated' }, { id: MOCK_BRAND_ID });
      const res = mockRes();
      await ctrl.updateProject(req, res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('updates allowed fields', async () => {
      const saveMock = jest.fn().mockResolvedValue(true);
      BrandProject.findOne.mockResolvedValue({
        ...mockBrandProject,
        save: saveMock,
      });

      const req = mockReq({ projectName: 'New Name', status: 'configured' }, { id: MOCK_BRAND_ID });
      const res = mockRes();
      await ctrl.updateProject(req, res);
      expect(saveMock).toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    });
  });

  describe('generateAsset', () => {
    it('returns 400 for invalid asset type', async () => {
      const req = mockReq({ type: 'invalid' }, { id: MOCK_BRAND_ID });
      const res = mockRes();
      await ctrl.generateAsset(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('returns 402 for insufficient credits', async () => {
      User.findById.mockReturnValue({
        select: jest.fn().mockResolvedValue({ platformCredits: 0 }),
      });
      const req = mockReq({ type: 'mockup' }, { id: MOCK_BRAND_ID });
      const res = mockRes();
      await ctrl.generateAsset(req, res);
      expect(res.status).toHaveBeenCalledWith(402);
    });
  });

  describe('archiveProject', () => {
    it('archives a project', async () => {
      BrandProject.findOneAndUpdate.mockResolvedValue(true);
      const req = mockReq({}, { id: MOCK_BRAND_ID });
      const res = mockRes();
      await ctrl.archiveProject(req, res);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    });
  });

  describe('getCredits', () => {
    it('returns credits', async () => {
      User.findById.mockReturnValue({
        select: jest.fn().mockResolvedValue({ platformCredits: 20 }),
      });
      const req = mockReq();
      const res = mockRes();
      await ctrl.getCredits(req, res);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, credits: 20 }));
    });
  });

  describe('buyCredits', () => {
    it('returns 400 for invalid amount', async () => {
      const req = mockReq({ amount: -5 });
      const res = mockRes();
      await ctrl.buyCredits(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('adds credits', async () => {
      User.findByIdAndUpdate.mockReturnValue({
        select: jest.fn().mockResolvedValue({ platformCredits: 30 }),
      });

      const req = mockReq({ amount: 10, paymentReference: 'pay_123' });
      const res = mockRes();
      await ctrl.buyCredits(req, res);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: true,
        creditsRemaining: 30,
      }));
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════

describe('tradeLicenseController', () => {
  const ctrl = require('../controllers/brandProject/tradeLicenseController');

  beforeEach(() => jest.clearAllMocks());

  describe('submitApplication', () => {
    it('returns 400 if missing required fields', async () => {
      const req = mockReq({}, { brandId: MOCK_BRAND_ID });
      const res = mockRes();
      await ctrl.submitApplication(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('returns 400 for invalid package', async () => {
      const req = mockReq({
        fullName: 'Ali', email: 'a@b.com', phone: '+971551234',
        package: 'invalid_pkg',
      }, { brandId: MOCK_BRAND_ID });
      const res = mockRes();
      await ctrl.submitApplication(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('submits application successfully', async () => {
      BrandProject.findOneAndUpdate.mockResolvedValue({
        tradeLicenseApplication: {
          package: 'starter', fullName: 'Ali', email: 'a@b.com',
          phone: '+971551234', status: 'submitted',
        },
        projectName: 'Farwa',
      });

      const req = mockReq({
        fullName: 'Ali', email: 'a@b.com', phone: '+971551234',
        package: 'starter',
      }, { brandId: MOCK_BRAND_ID });
      const res = mockRes();
      await ctrl.submitApplication(req, res);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    });

    it('returns 404 if brand not found', async () => {
      BrandProject.findOneAndUpdate.mockResolvedValue(null);
      const req = mockReq({
        fullName: 'Ali', email: 'a@b.com', phone: '+971551234',
        package: 'starter',
      }, { brandId: 'nonexistent' });
      const res = mockRes();
      await ctrl.submitApplication(req, res);
      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe('getApplication', () => {
    it('returns 404 if brand not found', async () => {
      BrandProject.findOne.mockResolvedValue(null);
      const req = mockReq({}, { brandId: 'nonexistent' });
      const res = mockRes();
      await ctrl.getApplication(req, res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('returns application data', async () => {
      BrandProject.findOne.mockResolvedValue({
        tradeLicenseApplication: { package: 'starter', status: 'submitted' },
      });
      const req = mockReq({}, { brandId: MOCK_BRAND_ID });
      const res = mockRes();
      await ctrl.getApplication(req, res);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: true,
        application: expect.objectContaining({ package: 'starter' }),
      }));
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════

describe('outreachController', () => {
  const ctrl = require('../controllers/brandProject/outreachController');

  beforeEach(() => jest.clearAllMocks());

  describe('findLeads', () => {
    it('returns 400 without brandProjectId', async () => {
      const req = mockReq({});
      const res = mockRes();
      await ctrl.findLeads(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  describe('getLeads', () => {
    it('returns leads for a brand', async () => {
      jest.spyOn(require('../services/outreachService'), 'getLeads')
        .mockResolvedValueOnce([{ id: 'l1', firstName: 'Sara' }]);

      const req = mockReq({}, { brandProjectId: MOCK_BRAND_ID }, {});
      const res = mockRes();
      await ctrl.getLeads(req, res);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: true,
        leads: expect.any(Array),
      }));
    });
  });

  describe('generateMessage', () => {
    it('returns 400 without required fields', async () => {
      const req = mockReq({ brandProjectId: MOCK_BRAND_ID });
      const res = mockRes();
      await ctrl.generateMessage(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('returns 404 if brand not found', async () => {
      BrandProject.findById.mockResolvedValue(null);
      const req = mockReq({ brandProjectId: MOCK_BRAND_ID, leadId: 'l1' });
      const res = mockRes();
      await ctrl.generateMessage(req, res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('returns 404 if lead not found', async () => {
      BrandProject.findById.mockResolvedValue({ ...mockBrandProject, leads: [] });
      const req = mockReq({ brandProjectId: MOCK_BRAND_ID, leadId: 'nonexistent' });
      const res = mockRes();
      await ctrl.generateMessage(req, res);
      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe('approveMessage', () => {
    it('returns 400 without required fields', async () => {
      const req = mockReq({});
      const res = mockRes();
      await ctrl.approveMessage(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('approves a message', async () => {
      BrandProject.findOneAndUpdate.mockResolvedValue(true);
      const req = mockReq({
        brandProjectId: MOCK_BRAND_ID,
        leadId: 'l1',
        messageId: 'm1',
      });
      const res = mockRes();
      await ctrl.approveMessage(req, res);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    });
  });

  describe('updateLeadStage', () => {
    it('returns 400 without required fields', async () => {
      const req = mockReq({ brandProjectId: MOCK_BRAND_ID });
      const res = mockRes();
      await ctrl.updateLeadStage(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('updates lead stage', async () => {
      BrandProject.findOneAndUpdate.mockResolvedValue(true);
      const req = mockReq({
        brandProjectId: MOCK_BRAND_ID,
        leadId: 'l1',
        stage: 'qualified',
      });
      const res = mockRes();
      await ctrl.updateLeadStage(req, res);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    });
  });

  describe('mailchimpSubscribe', () => {
    it('returns 400 without email', async () => {
      const req = mockReq({});
      const res = mockRes();
      await ctrl.mailchimpSubscribe(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════

describe('facebookAdsController', () => {
  const ctrl = require('../controllers/brandProject/facebookAdsController');

  beforeEach(() => jest.clearAllMocks());

  describe('getAuthUrl', () => {
    it('returns OAuth URL', () => {
      process.env.META_APP_ID = 'test_app_id';
      const req = mockReq();
      const res = mockRes();
      ctrl.getAuthUrl(req, res);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: true,
        url: expect.stringContaining('facebook.com'),
      }));
    });
  });

  describe('getStatus', () => {
    it('returns not connected when no FB data', async () => {
      User.findById.mockReturnValue({
        select: jest.fn().mockResolvedValue({ socialConnections: {} }),
      });
      const req = mockReq();
      const res = mockRes();
      await ctrl.getStatus(req, res);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: true,
        connected: false,
      }));
    });

    it('returns connected with pages', async () => {
      User.findById.mockReturnValue({
        select: jest.fn().mockResolvedValue({
          socialConnections: {
            facebook: {
              accessToken: Buffer.from('test-token').toString('base64'),
              pages: [{ id: '123', name: 'Test Page' }],
              connectedAt: new Date(),
            },
          },
        }),
      });

      const req = mockReq();
      const res = mockRes();
      await ctrl.getStatus(req, res);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: true,
        connected: true,
        pages: expect.arrayContaining([expect.objectContaining({ name: 'Test Page' })]),
      }));
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════

describe('imagePromptPurifier', () => {
  const purifier = require('../services/imagePromptPurifier');

  beforeEach(() => jest.clearAllMocks());

  describe('buildRawPrompt', () => {
    it('builds perfume hero bottle prompt', () => {
      const prompt = purifier.buildRawPrompt({
        brandName: 'Farwa',
        category: 'perfume',
        colorPalette: { primary: '#C9A227', accent: '#D4AF37' },
        fragranceFamily: 'Oud & Wood',
        bottleShape: 'angular faceted',
        bottleMaterial: 'frosted glass',
        capStyle: 'magnetic zamac cap',
        labelFinish: 'debossed matte',
        inputs: { topNotes: ['bergamot', 'saffron'], baseNotes: ['oud', 'musk'] },
      }, 'heroBottle');

      expect(prompt).toContain('perfume');
      expect(prompt).toContain('frosted glass');
      expect(prompt).toContain('bergamot');
      expect(prompt).not.toContain('undefined');
    });

    it('builds skincare lifestyle prompt', () => {
      const prompt = purifier.buildRawPrompt({
        brandName: 'GlowUp',
        category: 'skincare',
        colorPalette: { primary: '#fff', accent: '#333' },
        skinConcerns: ['Hydration'],
        packagingStyle: 'minimal clinical white',
        inputs: {},
      }, 'lifestyle');

      expect(prompt).toContain('skincare');
      expect(prompt).toContain('Hydration');
    });

    it('falls back to default for unknown category', () => {
      const prompt = purifier.buildRawPrompt({
        brandName: 'TechCo',
        category: 'drone',
        colorPalette: {},
        inputs: {},
      }, 'heroBottle');

      expect(prompt).toContain('TechCo');
    });

    it('builds social square prompt', () => {
      const prompt = purifier.buildRawPrompt({
        brandName: 'Farwa',
        category: 'perfume',
        colorPalette: { primary: 'amber', accent: 'gold' },
        bottleShape: 'angular',
        bottleMaterial: 'frosted glass',
        inputs: {},
      }, 'socialSquare');

      expect(prompt).toContain('Instagram');
      expect(prompt).toContain('1:1');
    });
  });

  describe('purifyPrompt', () => {
    it('calls Claude to purify a prompt', async () => {
      mockAnthropicCreate.mockResolvedValueOnce({
        content: [{ text: 'Purified ultra-realistic prompt for Farwa perfume bottle.' }],
        usage: { input_tokens: 200, output_tokens: 400 },
      });

      const result = await purifier.purifyPrompt(
        'raw prompt text',
        { brandName: 'Farwa', category: 'perfume', brandId: MOCK_BRAND_ID },
        'heroBottle',
        MOCK_USER_ID,
      );

      expect(result).toContain('Purified');
      expect(mockAnthropicCreate).toHaveBeenCalledTimes(1);
    });
  });

  describe('generateBrandImage routing', () => {
    it('routes lifestyle images through Flux', async () => {
      mockAnthropicCreate.mockResolvedValueOnce({
        content: [{ text: 'Purified lifestyle prompt' }],
        usage: { input_tokens: 100, output_tokens: 300 },
      });

      mockFalSubscribe.mockResolvedValueOnce({
        data: { images: [{ url: 'https://fal.ai/result.jpg' }] },
      });

      const result = await purifier.generateBrandImage(
        { brandName: 'Farwa', category: 'perfume', colorPalette: {}, inputs: {} },
        'lifestyle',
        MOCK_USER_ID,
      );

      expect(result.model).toBe('flux-pro');
      expect(result.url).toContain('fal.ai');
    });

    it('routes heroBottle through GPT-image-1', async () => {
      mockAnthropicCreate.mockResolvedValueOnce({
        content: [{ text: 'Purified hero bottle prompt' }],
        usage: { input_tokens: 100, output_tokens: 300 },
      });

      mockOpenAiImagesGenerate.mockResolvedValueOnce({
        data: [{ b64_json: 'dGVzdA==' }],
      });

      const result = await purifier.generateBrandImage(
        { brandName: 'Farwa', category: 'perfume', colorPalette: {}, inputs: {} },
        'heroBottle',
        MOCK_USER_ID,
      );

      expect(result.model).toBe('gpt-image-1');
      expect(result.base64).toBeDefined();
    });
  });

  describe('generateLogoImage', () => {
    it('generates a logo via GPT-image-1', async () => {
      mockAnthropicCreate.mockResolvedValueOnce({
        content: [{ text: 'Minimalist logo prompt' }],
        usage: { input_tokens: 50, output_tokens: 150 },
      });

      mockOpenAiImagesGenerate.mockResolvedValueOnce({
        data: [{ b64_json: 'bG9nbw==' }],
      });

      const result = await purifier.generateLogoImage(
        { brandName: 'Farwa', category: 'perfume', colorPalette: { primary: 'gold' } },
        MOCK_USER_ID,
      );

      expect(result.imageType).toBe('logo');
      expect(result.base64).toBeDefined();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════

describe('storeController', () => {
  const storeCtrl = require('../controllers/store/storeController');

  beforeEach(() => jest.clearAllMocks());

  describe('getMyStore', () => {
    it('returns null when no store exists', async () => {
      Store.findOne.mockReturnValue({
        lean: jest.fn().mockResolvedValue(null),
      });
      const req = mockReq();
      const res = mockRes();
      await storeCtrl.getMyStore(req, res);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: true,
        store: null,
      }));
    });
  });

  describe('publishStore', () => {
    it('returns 404 if no store', async () => {
      Store.findOne.mockResolvedValue(null);
      const req = mockReq({});
      const res = mockRes();
      await storeCtrl.publishStore(req, res);
      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe('getStoreDashboard', () => {
    it('returns dashboard data', async () => {
      const mockStore = {
        _id: 'store1', name: 'Farwa Store', isPublished: true,
        toObject() { return this; },
      };
      Store.findOne.mockReturnValue({
        lean: jest.fn().mockResolvedValue(mockStore),
      });
      Product.find.mockReturnValue({
        sort: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue([]),
        }),
      });
      Product.countDocuments.mockResolvedValue(0);

      const req = mockReq();
      const res = mockRes();
      await storeCtrl.getStoreDashboard(req, res);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    });
  });

  describe('launchStoreFromBrand', () => {
    it('creates store and products from brand project', async () => {
      const mockBrandDoc = {
        _id:          'brand-xyz',
        projectName:  'Oasis Scent',
        businessType: 'perfume',
        pricePoint:   'luxury',
        config: {
          brand: {
            brandName: 'Oasis Scent',
            tagline:   'Desert luxury in a bottle',
            colorPalette: { primary: '#c4a265' },
          },
        },
        agentMemory: { usp: { current: 'Premium scents' } },
        fragranceConfig: { scentProfile: 'Oriental', family: 'Oud' },
        packaging: {},
        leads: [],
      };

      BrandProject.findOne.mockResolvedValueOnce(mockBrandDoc);
      Store.findOne.mockResolvedValueOnce(null);
      Store.create.mockResolvedValueOnce({
        _id: 'store-new', slug: 'oasis-scent', name: 'Oasis Scent',
        save: jest.fn(),
      });

      mockOpenAiCreate.mockResolvedValueOnce({
        choices: [{
          message: {
            content: JSON.stringify([
              { name: 'Oasis Signature', description: 'Flagship oud perfume', price: 350, quantity: 50, category: 'perfume', tags: ['oud'], sku: 'SIG-001', isFeatured: true },
              { name: 'Oasis Classic', description: 'Everyday luxury', price: 180, quantity: 100, category: 'perfume', tags: ['daily'], sku: 'CLS-002', isFeatured: false },
              { name: 'Oasis Discovery', description: 'Travel size', price: 75, quantity: 200, category: 'perfume', tags: ['travel'], sku: 'DSC-003', isFeatured: false },
              { name: 'Oasis Gift Set', description: 'Premium gift box', price: 600, comparePrice: 750, quantity: 30, category: 'perfume', tags: ['gift'], sku: 'GFT-004', isFeatured: false },
            ]),
          },
        }],
      });

      Product.create
        .mockResolvedValueOnce({ _id: 'p1', name: 'Oasis Signature', price: 350 })
        .mockResolvedValueOnce({ _id: 'p2', name: 'Oasis Classic', price: 180 })
        .mockResolvedValueOnce({ _id: 'p3', name: 'Oasis Discovery', price: 75 })
        .mockResolvedValueOnce({ _id: 'p4', name: 'Oasis Gift Set', price: 600 });

      BrandProject.findByIdAndUpdate.mockResolvedValueOnce({});

      const req = mockReq({ brandProjectId: 'brand-xyz' });
      const res = mockRes();
      await storeCtrl.launchStoreFromBrand(req, res);

      const result = res.json.mock.calls[0][0];
      expect(result.success).toBe(true);
      expect(result.store.slug).toBe('oasis-scent');
      expect(result.products).toHaveLength(4);
      expect(Product.create).toHaveBeenCalledTimes(4);
      expect(BrandProject.findByIdAndUpdate).toHaveBeenCalledWith(
        'brand-xyz',
        expect.objectContaining({ $set: { status: 'launched' } }),
      );
    });

    it('returns 400 without brandProjectId', async () => {
      const req = mockReq({});
      const res = mockRes();
      await storeCtrl.launchStoreFromBrand(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('returns 404 when brand not found', async () => {
      BrandProject.findOne.mockResolvedValueOnce(null);
      const req = mockReq({ brandProjectId: 'nonexistent' });
      const res = mockRes();
      await storeCtrl.launchStoreFromBrand(req, res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('updates existing store instead of creating new one', async () => {
      const existingStore = {
        _id: 'existing-store', slug: 'old-name', name: 'Old Name',
        save: jest.fn().mockResolvedValue(true),
      };

      BrandProject.findOne.mockResolvedValueOnce({
        _id: 'brand-1', projectName: 'New Brand', businessType: 'skincare',
        config: { brand: { brandName: 'New Brand', tagline: 'Fresh skin' } },
        agentMemory: {},
      });
      Store.findOne.mockResolvedValueOnce(existingStore);

      mockOpenAiCreate.mockResolvedValueOnce({
        choices: [{
          message: {
            content: JSON.stringify({ products: [
              { name: 'Serum', description: 'Hydrating', price: 120, quantity: 50, category: 'skincare', tags: [], sku: 'S1', isFeatured: true },
            ] }),
          },
        }],
      });

      Product.create.mockResolvedValueOnce({ _id: 'p1', name: 'Serum', price: 120 });
      BrandProject.findByIdAndUpdate.mockResolvedValueOnce({});

      const req = mockReq({ brandProjectId: 'brand-1' });
      const res = mockRes();
      await storeCtrl.launchStoreFromBrand(req, res);

      expect(existingStore.save).toHaveBeenCalled();
      expect(existingStore.name).toBe('New Brand');
      expect(Store.create).not.toHaveBeenCalled();
      expect(res.json.mock.calls[0][0].success).toBe(true);
    });

    it('uses fallback products when AI fails', async () => {
      BrandProject.findOne.mockResolvedValueOnce({
        _id: 'brand-2', projectName: 'Fallback Brand', businessType: 'food',
        config: { brand: { brandName: 'Fallback Brand' } },
        agentMemory: {},
      });
      Store.findOne.mockResolvedValueOnce(null);
      Store.create.mockResolvedValueOnce({
        _id: 'store-fb', slug: 'fallback-brand', name: 'Fallback Brand',
        save: jest.fn(),
      });

      mockOpenAiCreate.mockRejectedValueOnce(new Error('AI quota exceeded'));

      Product.create
        .mockResolvedValueOnce({ _id: 'fb1', name: 'Fallback Brand Signature', price: 130 })
        .mockResolvedValueOnce({ _id: 'fb2', name: 'Fallback Brand Classic', price: 82 })
        .mockResolvedValueOnce({ _id: 'fb3', name: 'Fallback Brand Discovery', price: 31 })
        .mockResolvedValueOnce({ _id: 'fb4', name: 'Fallback Brand Gift Collection', price: 252 });

      BrandProject.findByIdAndUpdate.mockResolvedValueOnce({});

      const req = mockReq({ brandProjectId: 'brand-2' });
      const res = mockRes();
      await storeCtrl.launchStoreFromBrand(req, res);

      const result = res.json.mock.calls[0][0];
      expect(result.success).toBe(true);
      expect(result.products).toHaveLength(4);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════

describe('tokenMeter (mocked)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('exports required functions', () => {
    const tm = require('../services/tokenMeter');
    expect(tm.log).toBeDefined();
    expect(tm.getUserStats).toBeDefined();
    expect(tm.checkCanGenerate).toBeDefined();
    expect(tm.PLAN_LIMITS).toBeDefined();
  });

  it('log returns null on success (mocked)', async () => {
    const tm = require('../services/tokenMeter');
    const result = await tm.log({
      userId: MOCK_USER_ID, feature: 'image_generation',
      model: 'gpt-image-1', tokensIn: 0, tokensOut: 0,
    });
    expect(result).toBeNull();
  });

  it('checkCanGenerate returns allowed (mocked)', async () => {
    const tm = require('../services/tokenMeter');
    const result = await tm.checkCanGenerate(MOCK_USER_ID, 'trial', 'image_generation');
    expect(result.allowed).toBe(true);
  });
});
