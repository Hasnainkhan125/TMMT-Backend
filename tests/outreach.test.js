/**
 * outreach.test.js — Tests for email sending, message writing, and outreach pipeline
 *
 * Covers: emailSendingService, messageWriterService, leadsController integration
 * All external services (axios, Anthropic, Mongoose) are mocked.
 */

const { v4: uuidv4 } = require('uuid');

// ── Shared mock for Anthropic — captures the single instance created at require ──
const mockAnthropicCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => {
  return jest.fn().mockImplementation(() => ({
    messages: { create: mockAnthropicCreate },
  }));
});

jest.mock('axios');
const axios = require('axios');

jest.mock('../model/schema/brandProject', () => ({
  findById:          jest.fn(),
  findOne:           jest.fn(),
  findByIdAndUpdate: jest.fn(),
  findOneAndUpdate:  jest.fn(),
  find:              jest.fn(),
}));
const BrandProject = require('../model/schema/brandProject');

const messageWriterService = require('../services/messageWriterService');

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────
const mockBrand = {
  _id:          'brand-outreach-001',
  projectName:  'Bloom Luxe',
  businessType: 'perfume',
  config:       { brand: { brandName: 'Bloom Luxe', tagline: 'Timeless scents for modern souls' } },
  agentMemory: {
    usp: {
      current:            'Long-lasting luxury scents at accessible prices',
      competitiveGap:     'Competitors charge 3x more for similar quality',
      customerPainPoints: ['High prices for quality scents'],
    },
    audience: {
      primary:    { description: 'Women 25-38 in UAE who love luxury fragrance' },
      b2bTargets: [{ decisionMaker: 'Category Manager', coldEmailTemplate: 'Increased margins by 22%' }],
    },
  },
  leads: [],
  toObject() { return { ...this, toObject: undefined }; },
};

const mockLead = {
  id:               'lead-out-001',
  apolloId:         'apollo-out-001',
  firstName:        'Fatima',
  lastName:         'Al Hashimi',
  fullName:         'Fatima Al Hashimi',
  email:            'fatima@retailgroup.ae',
  emailVerified:    true,
  title:            'Category Manager',
  company:          'Gulf Retail Group',
  companySize:      '201-500',
  industry:         'Retail',
  location:         'Dubai, UAE',
  icpScore:         88,
  icpRationale:     'Category manager at major UAE retailer',
  painPointMatched: 'Looking for premium scents with better margins',
  uspAngle:         'Lead with margin improvement data',
  leadStage:        'new',
  outreachMessages: [],
};

const mockLeadNoEmail = { ...mockLead, id: 'lead-no-email-001', email: null };

const mkEmailResp = (subject, body, seq) => ({
  content: [{ text: JSON.stringify({ subject, body, previewText: 'Preview', sequenceNumber: seq, angle: 'Test angle' }) }],
});

// ─────────────────────────────────────────────────────────────────────────────
// messageWriterService
// ─────────────────────────────────────────────────────────────────────────────
describe('messageWriterService', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('writeEmailSequence', () => {
    test('generates first-touch email with all required fields', async () => {
      mockAnthropicCreate.mockResolvedValueOnce(mkEmailResp('Premium fragrances for Gulf Retail', 'Hi Fatima...', 1));
      const msg = await messageWriterService.writeEmailSequence(mockBrand, mockLead, 1);

      expect(msg).toHaveProperty('id');
      expect(msg.subject).toBe('Premium fragrances for Gulf Retail');
      expect(msg.sequenceNumber).toBe(1);
      expect(msg.status).toBe('draft');
      expect(msg.aiGenerated).toBe(true);
      expect(msg.channel).toBe('email');
    });

    test('generates sequence 2 follow-up', async () => {
      mockAnthropicCreate.mockResolvedValueOnce(mkEmailResp('Quick follow-up', 'Following up...', 2));
      const msg = await messageWriterService.writeEmailSequence(mockBrand, mockLead, 2);
      expect(msg.sequenceNumber).toBe(2);
    });

    test('generates sequence 3 final email', async () => {
      mockAnthropicCreate.mockResolvedValueOnce(mkEmailResp('A tip for your buyers', 'One insight...', 3));
      const msg = await messageWriterService.writeEmailSequence(mockBrand, mockLead, 3);
      expect(msg.sequenceNumber).toBe(3);
    });

    test('throws when Anthropic API fails', async () => {
      mockAnthropicCreate.mockRejectedValueOnce(new Error('rate limit'));
      await expect(messageWriterService.writeEmailSequence(mockBrand, mockLead, 1)).rejects.toThrow();
    });

    test('handles lead with minimal data', async () => {
      const minLead = { id: 'min-1', title: '', company: '', industry: '', location: '' };
      mockAnthropicCreate.mockResolvedValueOnce(mkEmailResp('Intro', 'Hello', 1));
      const msg = await messageWriterService.writeEmailSequence(mockBrand, minLead, 1);
      expect(msg.subject).toBe('Intro');
    });

    test('uses correct AI model', async () => {
      mockAnthropicCreate.mockResolvedValueOnce(mkEmailResp('Test', 'Body', 1));
      await messageWriterService.writeEmailSequence(mockBrand, mockLead, 1);
      expect(mockAnthropicCreate).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'claude-haiku-4-5-20251001' })
      );
    });
  });

  describe('writeBatchMessages', () => {
    test('generates messages for multiple leads', async () => {
      const leads = [
        { ...mockLead, id: 'b1' },
        { ...mockLead, id: 'b2', firstName: 'Omar' },
      ];
      mockAnthropicCreate.mockResolvedValueOnce(mkEmailResp('Sub1', 'Body1', 1));
      mockAnthropicCreate.mockResolvedValueOnce(mkEmailResp('Sub2', 'Body2', 1));

      const results = await messageWriterService.writeBatchMessages(mockBrand, leads);
      expect(results).toHaveLength(2);
      expect(results[0].leadId).toBe('b1');
      expect(results[0].message).toBeDefined();
      expect(results[1].leadId).toBe('b2');
    });

    test('handles partial failures in batch', async () => {
      const leads = [
        { ...mockLead, id: 'ok' },
        { ...mockLead, id: 'fail' },
      ];
      mockAnthropicCreate.mockResolvedValueOnce(mkEmailResp('OK', 'Body', 1));
      mockAnthropicCreate.mockRejectedValueOnce(new Error('AI error'));

      const results = await messageWriterService.writeBatchMessages(mockBrand, leads);
      expect(results).toHaveLength(2);
      expect(results[0].message).toBeDefined();
      expect(results[1].error).toBe('AI error');
    });

    test('limits batch to 10 leads max', async () => {
      const many = Array.from({ length: 15 }, (_, i) => ({ ...mockLead, id: `l${i}` }));
      for (let i = 0; i < 10; i++) {
        mockAnthropicCreate.mockResolvedValueOnce(mkEmailResp(`S${i}`, `B${i}`, 1));
      }
      const results = await messageWriterService.writeBatchMessages(mockBrand, many);
      expect(results.length).toBeLessThanOrEqual(10);
    });
  });

  describe('learnFromReply', () => {
    test('extracts learning from positive reply', async () => {
      mockAnthropicCreate.mockResolvedValueOnce({
        content: [{ text: JSON.stringify({
          learning: 'Margin-focused messaging resonates with retail buyers',
          whatWorked: 'Leading with specific margin percentages',
          objection: null,
          suggestedAdjustment: 'Include more specific ROI data',
        }) }],
      });
      BrandProject.findByIdAndUpdate.mockResolvedValueOnce({});

      const result = await messageWriterService.learnFromReply(
        mockBrand, mockLead, 'That sounds interesting, can we schedule a call?', 'positive'
      );
      expect(result.learning).toContain('Margin');
      expect(result.whatWorked).toBeDefined();
    });

    test('handles AI failure gracefully', async () => {
      mockAnthropicCreate.mockRejectedValueOnce(new Error('timeout'));
      const result = await messageWriterService.learnFromReply(
        mockBrand, mockLead, 'Not interested', 'negative'
      );
      expect(result).toHaveProperty('learning', '');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// emailSendingService
// ─────────────────────────────────────────────────────────────────────────────
describe('emailSendingService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.QUMAK_MAILCHIMP_API_KEY = 'test-mandrill-key';
  });

  // sendOutreachEmail is tested at require-time scope since it reads env at module load.
  // We test via the already-required service module.

  describe('sendOutreachEmail', () => {
    // We need to re-require the service to pick up env vars.
    let service;
    beforeEach(() => {
      jest.resetModules();
      process.env.QUMAK_MAILCHIMP_API_KEY = 'test-mandrill-key';
      jest.mock('axios');
      jest.mock('../model/schema/brandProject', () => ({
        findById: jest.fn(), findOne: jest.fn(),
        findByIdAndUpdate: jest.fn(), findOneAndUpdate: jest.fn(), find: jest.fn(),
      }));
      service = require('../services/emailSendingService');
    });

    test('sends email via Mandrill and updates DB', async () => {
      const ax = require('axios');
      const BP = require('../model/schema/brandProject');

      ax.post.mockResolvedValueOnce({ data: [{ _id: 'mnd-001', status: 'sent' }] });
      BP.findOneAndUpdate.mockResolvedValue({});

      const msg = { id: 'msg-d1', subject: 'Premium scents', body: 'Hi Fatima...', sequenceNumber: 1, status: 'draft' };
      const result = await service.sendOutreachEmail(mockBrand, mockLead, msg);

      expect(result.success).toBe(true);
      expect(result.mandrillId).toBe('mnd-001');
      expect(ax.post).toHaveBeenCalledWith(
        expect.stringContaining('/messages/send'),
        expect.objectContaining({ key: 'test-mandrill-key' }),
        expect.any(Object)
      );
    });

    test('throws when lead has no email', async () => {
      await expect(service.sendOutreachEmail(mockBrand, mockLeadNoEmail, { subject: 'T', body: 'B' }))
        .rejects.toThrow('Lead has no email address');
    });

    test('throws when Mandrill rejects message', async () => {
      const ax = require('axios');
      ax.post.mockResolvedValueOnce({ data: [{ _id: 'rej', status: 'rejected', reject_reason: 'hard-bounce' }] });
      await expect(service.sendOutreachEmail(mockBrand, mockLead, { id: 'm1', subject: 'T', body: 'B' }))
        .rejects.toThrow('Mandrill rejected');
    });
  });

  describe('handleWebhook', () => {
    let service;
    beforeEach(() => {
      jest.resetModules();
      process.env.QUMAK_MAILCHIMP_API_KEY = 'test-key';
      jest.mock('axios');
      jest.mock('../model/schema/brandProject', () => ({
        findById: jest.fn(), findOne: jest.fn(),
        findByIdAndUpdate: jest.fn(), findOneAndUpdate: jest.fn(), find: jest.fn(),
      }));
      service = require('../services/emailSendingService');
    });

    test('processes open event', async () => {
      const BP = require('../model/schema/brandProject');
      BP.findOneAndUpdate.mockResolvedValue({});

      const ev = { event: 'open', _id: 'mnd-1', msg: { metadata: { brandId: 'b1', leadId: 'l1' } } };
      const result = await service.handleWebhook(ev);
      expect(result.processed).toBe(1);
    });

    test('processes hard_bounce and marks lead not_fit', async () => {
      const BP = require('../model/schema/brandProject');
      BP.findOneAndUpdate.mockResolvedValue({});

      const ev = { event: 'hard_bounce', _id: 'bn-1', msg: { metadata: { brandId: 'b1', leadId: 'l1' } } };
      const result = await service.handleWebhook(ev);
      expect(result.processed).toBe(1);
      expect(BP.findOneAndUpdate).toHaveBeenCalledTimes(2);
    });

    test('processes array of events', async () => {
      const BP = require('../model/schema/brandProject');
      BP.findOneAndUpdate.mockResolvedValue({});

      const evts = [
        { event: 'open', _id: 'm1', msg: { metadata: { brandId: 'b1', leadId: 'l1' } } },
        { event: 'open', _id: 'm2', msg: { metadata: { brandId: 'b1', leadId: 'l2' } } },
      ];
      const result = await service.handleWebhook(evts);
      expect(result.processed).toBe(2);
    });

    test('skips events with missing metadata', async () => {
      const result = await service.handleWebhook({ event: 'open', _id: 'm1' });
      expect(result.processed).toBe(0);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// leadsController — controller-level tests
// ─────────────────────────────────────────────────────────────────────────────
describe('leadsController', () => {
  let ctrl, res;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();

    jest.mock('axios');
    jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
      messages: { create: jest.fn() },
    })));
    jest.mock('../model/schema/brandProject', () => ({
      findById: jest.fn(), findOne: jest.fn(),
      findByIdAndUpdate: jest.fn(), findOneAndUpdate: jest.fn(), find: jest.fn(),
    }));

    ctrl = require('../controllers/brandProject/leadsController');
    res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  });

  describe('getStats', () => {
    test('returns correct statistics', async () => {
      const BP = require('../model/schema/brandProject');
      BP.findOne.mockResolvedValueOnce({
        _id: 'b-stats',
        leads: [
          { ...mockLead, leadStage: 'new', icpScore: 85, outreachMessages: [] },
          { ...mockLead, id: 'l2', leadStage: 'contacted', icpScore: 75, outreachMessages: [{ status: 'sent', sentAt: new Date() }] },
          { ...mockLead, id: 'l3', leadStage: 'replied', icpScore: 90, outreachMessages: [{ status: 'replied', sentAt: new Date() }] },
        ],
      });

      await ctrl.getStats({ params: { brandId: 'b-stats' }, user: { _id: 'u1' } }, res);
      const r = res.json.mock.calls[0][0];
      expect(r.success).toBe(true);
      expect(r.stats.totalLeads).toBe(3);
      expect(r.stats.stageCounts.new).toBe(1);
      expect(r.stats.avgIcpScore).toBeGreaterThan(0);
    });
  });

  describe('updateLeadStage', () => {
    test('updates to valid stage', async () => {
      const BP = require('../model/schema/brandProject');
      BP.findOne.mockResolvedValueOnce({ _id: 'b1', leads: [mockLead] });
      BP.findOneAndUpdate.mockResolvedValueOnce({});

      await ctrl.updateLeadStage(
        { params: { brandId: 'b1', leadId: mockLead.id }, body: { stage: 'contacted' }, user: { _id: 'u1' } },
        res
      );
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, stage: 'contacted' }));
    });

    test('rejects invalid stage', async () => {
      await ctrl.updateLeadStage(
        { params: { brandId: 'b1', leadId: 'l1' }, body: { stage: 'invalid' }, user: { _id: 'u1' } },
        res
      );
      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  describe('deleteLead', () => {
    test('removes lead from brand', async () => {
      const BP = require('../model/schema/brandProject');
      BP.findOne.mockResolvedValueOnce({ _id: 'b1', leads: [mockLead] });
      BP.findByIdAndUpdate.mockResolvedValueOnce({});

      await ctrl.deleteLead(
        { params: { brandId: 'b1', leadId: mockLead.id }, user: { _id: 'u1' } }, res
      );
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, deleted: true }));
    });
  });

  describe('getLeads', () => {
    test('returns paginated leads', async () => {
      const BP = require('../model/schema/brandProject');
      BP.findOne.mockResolvedValueOnce({
        _id: 'b1',
        leads: [
          { ...mockLead, id: 'l1', icpScore: 90 },
          { ...mockLead, id: 'l2', icpScore: 70 },
          { ...mockLead, id: 'l3', icpScore: 80 },
        ],
      });

      await ctrl.getLeads(
        { params: { brandId: 'b1' }, query: { limit: '2', page: '1' }, user: { _id: 'u1' } }, res
      );

      const r = res.json.mock.calls[0][0];
      expect(r.success).toBe(true);
      expect(r.total).toBe(3);
      expect(r.leads.length).toBeLessThanOrEqual(2);
      expect(r.leads[0].icpScore).toBeGreaterThanOrEqual(r.leads[1].icpScore);
    });

    test('filters by stage', async () => {
      const BP = require('../model/schema/brandProject');
      BP.findOne.mockResolvedValueOnce({
        _id: 'b1',
        leads: [
          { ...mockLead, id: 'l1', leadStage: 'new', icpScore: 80 },
          { ...mockLead, id: 'l2', leadStage: 'contacted', icpScore: 70 },
        ],
      });

      await ctrl.getLeads(
        { params: { brandId: 'b1' }, query: { stage: 'new' }, user: { _id: 'u1' } }, res
      );

      const r = res.json.mock.calls[0][0];
      expect(r.leads.every(l => l.leadStage === 'new')).toBe(true);
    });

    test('returns 404 for non-existent brand', async () => {
      const BP = require('../model/schema/brandProject');
      BP.findOne.mockResolvedValueOnce(null);

      await ctrl.getLeads(
        { params: { brandId: 'none' }, query: {}, user: { _id: 'u1' } }, res
      );
      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe('sendEmail', () => {
    test('returns 400 when lead has no email', async () => {
      const BP = require('../model/schema/brandProject');
      BP.findOne.mockResolvedValueOnce({ _id: 'b1', leads: [mockLeadNoEmail] });

      await ctrl.sendEmail(
        { params: { brandId: 'b1', leadId: mockLeadNoEmail.id }, body: {}, user: { _id: 'u1' } }, res
      );
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('returns 400 when no draft message exists', async () => {
      const BP = require('../model/schema/brandProject');
      BP.findOne.mockResolvedValueOnce({ _id: 'b1', leads: [{ ...mockLead, outreachMessages: [] }] });

      await ctrl.sendEmail(
        { params: { brandId: 'b1', leadId: mockLead.id }, body: {}, user: { _id: 'u1' } }, res
      );
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('returns 404 when lead not found', async () => {
      const BP = require('../model/schema/brandProject');
      BP.findOne.mockResolvedValueOnce({ _id: 'b1', leads: [] });

      await ctrl.sendEmail(
        { params: { brandId: 'b1', leadId: 'nonexist' }, body: {}, user: { _id: 'u1' } }, res
      );
      expect(res.status).toHaveBeenCalledWith(404);
    });
  });
});
