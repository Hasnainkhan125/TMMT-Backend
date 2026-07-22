/**
 * leads.test.js — Comprehensive tests for Leads Engine (Phase 2)
 *
 * Covers: leadResearchService, messageWriterService, emailSendingService,
 *         leadsController (all endpoints)
 *
 * All external services (axios, Anthropic, Mongoose) are mocked.
 */

process.env.QUMAK_APOLO_LEADS_API_KEY = 'test_apollo_key_mock';
process.env.ANTHROPIC_API_KEY          = 'test_anthropic_key_mock';
process.env.QUMAK_MAILCHIMP_API_KEY    = 'test_mandrill_key_mock';

const { v4: uuidv4 } = require('uuid');

// ── Mock axios ──────────────────────────────────────────────────────────────
jest.mock('axios');
const axios = require('axios');

// ── Mock Anthropic SDK ──────────────────────────────────────────────────────
const mockAnthropicCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => {
  return jest.fn().mockImplementation(() => ({
    messages: { create: mockAnthropicCreate },
  }));
});

// ── Mock BrandProject model (supports .findById().select() chaining) ──────
const mockBrandProjectMethods = {
  findById:           jest.fn(),
  findOne:            jest.fn(),
  findByIdAndUpdate:  jest.fn(),
  findOneAndUpdate:   jest.fn(),
  find:               jest.fn(),
  create:             jest.fn(),
};

function chainable(resolved) {
  const q = {
    select: jest.fn().mockReturnThis(),
    lean:   jest.fn().mockReturnThis(),
    limit:  jest.fn().mockReturnThis(),
    sort:   jest.fn().mockReturnThis(),
    then:   (onFulfilled, onRejected) => Promise.resolve(resolved).then(onFulfilled, onRejected),
    catch:  (onRejected) => Promise.resolve(resolved).catch(onRejected),
  };
  return q;
}

jest.mock('../model/schema/brandProject', () => mockBrandProjectMethods);
const BrandProject = require('../model/schema/brandProject');

// ── Import services under test ──────────────────────────────────────────────
const leadResearchService  = require('../services/leadResearchService');
const messageWriterService = require('../services/messageWriterService');
const emailSendingService  = require('../services/emailSendingService');

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────
const mockBrand = {
  _id:          'brand123',
  projectName:  'Desert Bloom Perfume',
  businessType: 'perfume',
  pricePoint:   'luxury',
  config:       { brand: { brandName: 'Desert Bloom', tagline: 'Luxury for everyone' } },
  agentMemory: {
    usp: {
      current:            'Long-lasting luxury scents at accessible prices',
      competitiveGap:     'Competitors charge 3x more for similar quality',
      customerPainPoints: ['High prices for similar quality'],
    },
    audience: {
      primary:    { description: 'Retail buyers and category managers in UAE luxury sector' },
      b2bTargets: [{ decisionMaker: 'Head of Luxury Buying', coldEmailTemplate: 'Results show 40% margin improvement' }],
    },
  },
  leads: [],
  toObject() { return { ...this }; },
};

const mockLead = {
  id:               'lead-uuid-001',
  apolloId:         'apollo-001',
  firstName:        'Sarah',
  lastName:         'Al Mansoori',
  fullName:         'Sarah Al Mansoori',
  email:            'sarah@luxuryretail.ae',
  emailVerified:    true,
  title:            'Category Manager',
  company:          'Luxury Retail Group',
  companySize:      '201-500',
  industry:         'Retail',
  location:         'Dubai, UAE',
  icpScore:         82,
  icpRationale:     'Category manager at UAE luxury retailer — perfect fit',
  painPointMatched: 'Looking for premium scents that sell well at mid-range pricing',
  uspAngle:         'Lead with cost-per-use value vs competitor pricing',
  leadStage:        'new',
  outreachMessages: [],
};

const apolloPerson = {
  id:           'apollo-001',
  first_name:   'Sarah',
  last_name:    'Al Mansoori',
  name:         'Sarah Al Mansoori',
  email:        'sarah@luxuryretail.ae',
  email_status: 'verified',
  title:        'Category Manager',
  organization: {
    name:                    'Luxury Retail Group',
    industry:                'Retail',
    estimated_num_employees: 200,
    website_url:             'https://luxuryretail.ae',
  },
  city:         'Dubai',
  country:      'United Arab Emirates',
  linkedin_url: 'https://linkedin.com/in/sarah-am',
};

// ─────────────────────────────────────────────────────────────────────────────
// leadResearchService.buildSearchFilters
// ─────────────────────────────────────────────────────────────────────────────
describe('buildSearchFilters', () => {
  test('maps perfume category to correct titles and industries', () => {
    const filters = leadResearchService.buildSearchFilters({ businessType: 'perfume' });
    expect(filters.personTitles).toContain('Retail Buyer');
    expect(filters.personTitles).toContain('Category Manager');
    expect(filters.industries).toContain('Cosmetics');
    expect(filters.personLocations).toContain('Dubai');
    expect(filters.personLocations).toContain('United Arab Emirates');
  });

  test('maps skincare category correctly', () => {
    const filters = leadResearchService.buildSearchFilters({ businessType: 'skincare' });
    expect(filters.personTitles).toContain('Brand Manager');
    expect(filters.industries).toContain('Health and Wellness');
  });

  test('maps tech category correctly', () => {
    const filters = leadResearchService.buildSearchFilters({ businessType: 'tech' });
    expect(filters.personTitles).toContain('CTO');
    expect(filters.industries).toContain('Software');
  });

  test('maps food_beverage category correctly', () => {
    const filters = leadResearchService.buildSearchFilters({ businessType: 'food_beverage' });
    expect(filters.personTitles).toContain('F&B Manager');
    expect(filters.industries).toContain('Food and Beverages');
  });

  test('maps clothing category correctly', () => {
    const filters = leadResearchService.buildSearchFilters({ businessType: 'clothing' });
    expect(filters.personTitles).toContain('Fashion Director');
    expect(filters.industries).toContain('Fashion');
  });

  test('maps wellness category correctly', () => {
    const filters = leadResearchService.buildSearchFilters({ businessType: 'wellness' });
    expect(filters.personTitles).toContain('Wellness Director');
    expect(filters.industries).toContain('Fitness');
  });

  test('uses default filters for unknown category', () => {
    const filters = leadResearchService.buildSearchFilters({ businessType: 'unknown_category' });
    expect(filters.personTitles).toContain('CEO');
    expect(filters.personTitles).toContain('Founder');
  });

  test('always includes UAE/GCC locations', () => {
    const filters = leadResearchService.buildSearchFilters({ businessType: 'custom' });
    expect(filters.personLocations).toContain('United Arab Emirates');
    expect(filters.personLocations).toContain('Saudi Arabia');
    expect(filters.personLocations).toContain('Qatar');
    expect(filters.personLocations).toContain('Kuwait');
    expect(filters.personLocations).toContain('Oman');
  });

  test('merges agent memory b2b target titles', () => {
    const brandWithTargets = {
      businessType: 'perfume',
      agentMemory: {
        audience: {
          b2bTargets: [
            { decisionMaker: 'Head of Luxury Buying', painPoint: 'test' },
          ],
        },
      },
    };
    const filters = leadResearchService.buildSearchFilters(brandWithTargets);
    expect(filters.personTitles).toContain('Head of Luxury Buying');
    expect(filters.personTitles).toContain('Retail Buyer');
  });

  test('deduplicates merged titles', () => {
    const brandWithDup = {
      businessType: 'perfume',
      agentMemory: { audience: { b2bTargets: [{ decisionMaker: 'CEO' }] } },
    };
    const filters = leadResearchService.buildSearchFilters(brandWithDup);
    const ceoCount = filters.personTitles.filter(t => t === 'CEO').length;
    expect(ceoCount).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// leadResearchService.searchLeads
// ─────────────────────────────────────────────────────────────────────────────
describe('searchLeads', () => {
  beforeEach(() => {
    process.env.QUMAK_APOLO_LEADS_API_KEY = 'test-apollo-key';
    jest.clearAllMocks();
  });

  test('calls Apollo /mixed_people/search with api_key in body', async () => {
    axios.post.mockResolvedValueOnce({
      data: {
        people:     [apolloPerson],
        pagination: { page: 1, per_page: 25, total_entries: 1, total_pages: 1 },
      },
    });

    const result = await leadResearchService.searchLeads('brand123', mockBrand, { count: 25, page: 1 });

    expect(axios.post).toHaveBeenCalledWith(
      expect.stringContaining('/mixed_people/search'),
      expect.objectContaining({
        api_key:          'test-apollo-key',
        per_page:         25,
        page:             1,
        q_person_title:   expect.arrayContaining(['Retail Buyer']),
        person_locations: expect.arrayContaining(['Dubai']),
      }),
      expect.objectContaining({ timeout: 20000 }),
    );

    expect(result.leads).toHaveLength(1);
    expect(result.leads[0].apolloId).toBe('apollo-001');
    expect(result.leads[0].email).toBe('sarah@luxuryretail.ae');
    expect(result.leads[0].emailVerified).toBe(true);
    expect(result.leads[0].company).toBe('Luxury Retail Group');
    expect(result.leads[0].leadStage).toBe('new');
    expect(result.leads[0].id).toBeDefined();
    expect(result.leads[0].source).toBe('apollo');
    expect(result.leads[0].location).toBe('Dubai, United Arab Emirates');
  });

  test('throws when Apollo key is missing', async () => {
    process.env.QUMAK_APOLO_LEADS_API_KEY = '';
    await expect(
      leadResearchService.searchLeads('brand123', mockBrand)
    ).rejects.toThrow('Apollo API key not configured');
  });

  test('handles empty people array from Apollo', async () => {
    axios.post.mockResolvedValueOnce({
      data: { people: [], pagination: {} },
    });

    const result = await leadResearchService.searchLeads('brand123', mockBrand);
    expect(result.leads).toHaveLength(0);
  });

  test('handles Apollo response with missing fields gracefully', async () => {
    axios.post.mockResolvedValueOnce({
      data: {
        people: [{
          id:           'apollo-sparse',
          first_name:   null,
          last_name:    null,
          name:         null,
          email:        null,
          email_status: null,
          title:        null,
          organization: null,
          city:         null,
          country:      null,
        }],
        pagination: {},
      },
    });

    const result = await leadResearchService.searchLeads('brand123', mockBrand);
    expect(result.leads).toHaveLength(1);
    expect(result.leads[0].email).toBeNull();
    expect(result.leads[0].company).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// leadResearchService.revealEmail
// ─────────────────────────────────────────────────────────────────────────────
describe('revealEmail', () => {
  beforeEach(() => {
    process.env.QUMAK_APOLO_LEADS_API_KEY = 'test-apollo-key';
    jest.clearAllMocks();
  });

  test('calls Apollo /people/match and returns email', async () => {
    axios.post.mockResolvedValueOnce({
      data: { person: { email: 'revealed@example.com', email_status: 'verified' } },
    });

    const result = await leadResearchService.revealEmail('apollo-001');
    expect(result.email).toBe('revealed@example.com');
    expect(result.verified).toBe(true);
    expect(axios.post).toHaveBeenCalledWith(
      expect.stringContaining('/people/match'),
      expect.objectContaining({ api_key: 'test-apollo-key', id: 'apollo-001' }),
      expect.any(Object),
    );
  });

  test('returns null email when person not found', async () => {
    axios.post.mockResolvedValueOnce({ data: { person: null } });
    const result = await leadResearchService.revealEmail('nonexistent');
    expect(result.email).toBeNull();
    expect(result.verified).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// leadResearchService.scoreLeads
// ─────────────────────────────────────────────────────────────────────────────
describe('scoreLeads', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('batch-scores leads and returns sorted by score desc', async () => {
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{
        text: JSON.stringify([
          { index: 0, score: 85, rationale: 'Category manager at UAE retailer', painPoint: 'Pricing pressure', angle: 'Value positioning' },
          { index: 1, score: 60, rationale: 'Less relevant industry', painPoint: 'Generic', angle: 'Brand building' },
        ]),
      }],
    });

    const leadsToScore = [
      { ...mockLead, id: 'lead-1', title: 'Category Manager', company: 'Retail Co', industry: 'Retail' },
      { ...mockLead, id: 'lead-2', title: 'IT Manager', company: 'Tech Co', industry: 'Tech' },
    ];

    const scored = await leadResearchService.scoreLeads(leadsToScore, mockBrand);

    expect(scored).toHaveLength(2);
    expect(scored[0].icpScore).toBeGreaterThanOrEqual(scored[1].icpScore);
    expect(scored[0].icpRationale).toBe('Category manager at UAE retailer');
    expect(scored[0].painPointMatched).toBe('Pricing pressure');
    expect(scored[0].uspAngle).toBe('Value positioning');
  });

  test('falls back to score 50 when AI fails', async () => {
    mockAnthropicCreate.mockRejectedValueOnce(new Error('API timeout'));

    const leadsToScore = [{ ...mockLead, id: 'lead-1' }];
    const scored = await leadResearchService.scoreLeads(leadsToScore, mockBrand);

    expect(scored).toHaveLength(1);
    expect(scored[0].icpScore).toBe(50);
    expect(scored[0].icpRationale).toBe('Auto-scored');
  });

  test('returns empty array for empty leads input', async () => {
    const scored = await leadResearchService.scoreLeads([], mockBrand);
    expect(scored).toEqual([]);
    expect(mockAnthropicCreate).not.toHaveBeenCalled();
  });

  test('handles AI returning markdown-wrapped JSON', async () => {
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ text: '```json\n[{"index":0,"score":90,"rationale":"Great","painPoint":"Cost","angle":"ROI"}]\n```' }],
    });

    const scored = await leadResearchService.scoreLeads([mockLead], mockBrand);
    expect(scored[0].icpScore).toBe(90);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// leadResearchService.saveLeadsToDb
// ─────────────────────────────────────────────────────────────────────────────
describe('saveLeadsToDb', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('deduplicates by apolloId and saves only new leads', async () => {
    const existingLead = { apolloId: 'apollo-existing-001', id: 'existing-uuid' };
    BrandProject.findById.mockReturnValueOnce(chainable({ leads: [existingLead] }));
    BrandProject.findByIdAndUpdate.mockResolvedValueOnce({});

    const incomingLeads = [
      { apolloId: 'apollo-existing-001', id: 'dup-uuid', fullName: 'Duplicate' },
      { apolloId: 'apollo-new-002', id: 'new-uuid-1', fullName: 'New One' },
      { apolloId: 'apollo-new-003', id: 'new-uuid-2', fullName: 'New Two' },
    ];

    const result = await leadResearchService.saveLeadsToDb('brand123', incomingLeads);

    expect(result.added).toBe(2);
    expect(result.skipped).toBe(1);

    const updateCall = BrandProject.findByIdAndUpdate.mock.calls[0];
    const pushPayload = updateCall[1].$push.leads.$each;
    expect(pushPayload).toHaveLength(2);
    expect(pushPayload.map(l => l.apolloId)).not.toContain('apollo-existing-001');
  });

  test('saves all leads when no existing leads', async () => {
    BrandProject.findById.mockReturnValueOnce(chainable({ leads: [] }));
    BrandProject.findByIdAndUpdate.mockResolvedValueOnce({});

    const leads = [
      { apolloId: 'new-001', id: 'uuid-1' },
      { apolloId: 'new-002', id: 'uuid-2' },
    ];

    const result = await leadResearchService.saveLeadsToDb('brand123', leads);
    expect(result.added).toBe(2);
    expect(result.skipped).toBe(0);
  });

  test('handles manual leads (no apolloId) without skipping', async () => {
    BrandProject.findById.mockReturnValueOnce(chainable({ leads: [] }));
    BrandProject.findByIdAndUpdate.mockResolvedValueOnce({});

    const leads = [{ apolloId: null, id: 'manual-uuid-1', source: 'manual' }];
    const result = await leadResearchService.saveLeadsToDb('brand123', leads);
    expect(result.added).toBe(1);
  });

  test('does not call update if all leads are duplicates', async () => {
    BrandProject.findById.mockReturnValueOnce(chainable({
      leads: [{ apolloId: 'existing-001', id: 'e1' }],
    }));

    const result = await leadResearchService.saveLeadsToDb('brand123', [
      { apolloId: 'existing-001', id: 'dup' },
    ]);

    expect(result.added).toBe(0);
    expect(result.skipped).toBe(1);
    expect(BrandProject.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  test('throws if brand not found', async () => {
    BrandProject.findById.mockReturnValueOnce(chainable(null));
    await expect(leadResearchService.saveLeadsToDb('nonexistent', [])).rejects.toThrow('Brand not found');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// messageWriterService.writeEmailSequence
// ─────────────────────────────────────────────────────────────────────────────
describe('writeEmailSequence', () => {
  const mockEmailResponse = (subject, body, seq) => ({
    content: [{
      text: JSON.stringify({
        subject,
        body,
        previewText:    'Preview text here',
        sequenceNumber: seq,
        angle:          'Cost-per-use value angle',
      }),
    }],
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('generates sequence 1 email with correct structure', async () => {
    mockAnthropicCreate.mockResolvedValueOnce(
      mockEmailResponse('Exclusive scents for Luxury Retail Group', 'Hi Sarah, ...', 1),
    );

    const msg = await messageWriterService.writeEmailSequence(mockBrand, mockLead, 1);

    expect(msg.subject).toBe('Exclusive scents for Luxury Retail Group');
    expect(msg.sequenceNumber).toBe(1);
    expect(msg.status).toBe('draft');
    expect(msg.aiGenerated).toBe(true);
    expect(msg.id).toBeDefined();
    expect(msg.channel).toBe('email');
    expect(msg.edited).toBe(false);
    expect(msg.body).toBe('Hi Sarah, ...');
    expect(msg.previewText).toBe('Preview text here');
  });

  test('generates sequence 2 follow-up email', async () => {
    mockAnthropicCreate.mockResolvedValueOnce(
      mockEmailResponse('Following up — quick thought', 'Just wanted to add...', 2),
    );

    const msg = await messageWriterService.writeEmailSequence(mockBrand, mockLead, 2);
    expect(msg.sequenceNumber).toBe(2);
    expect(msg.subject).toBe('Following up — quick thought');
  });

  test('generates sequence 3 final email', async () => {
    mockAnthropicCreate.mockResolvedValueOnce(
      mockEmailResponse('One tip for your buyers', 'A useful insight...', 3),
    );

    const msg = await messageWriterService.writeEmailSequence(mockBrand, mockLead, 3);
    expect(msg.sequenceNumber).toBe(3);
    expect(msg.subject).toBe('One tip for your buyers');
  });

  test('passes correct model to Anthropic', async () => {
    mockAnthropicCreate.mockResolvedValueOnce(
      mockEmailResponse('Test', 'Body', 1),
    );

    await messageWriterService.writeEmailSequence(mockBrand, mockLead, 1);

    expect(mockAnthropicCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-haiku-4-5-20251001' }),
    );
  });

  test('falls back to sequence 1 rules for invalid sequence number', async () => {
    mockAnthropicCreate.mockResolvedValueOnce(
      mockEmailResponse('Fallback subject', 'Fallback body', 99),
    );

    const msg = await messageWriterService.writeEmailSequence(mockBrand, mockLead, 99);
    expect(msg).toBeDefined();
    expect(msg.status).toBe('draft');
  });

  test('includes lead pain point and usp angle in prompt', async () => {
    mockAnthropicCreate.mockResolvedValueOnce(
      mockEmailResponse('Subject', 'Body', 1),
    );

    await messageWriterService.writeEmailSequence(mockBrand, mockLead, 1);

    const prompt = mockAnthropicCreate.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain(mockLead.painPointMatched);
    expect(prompt).toContain(mockLead.uspAngle);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// messageWriterService.writeBatchMessages
// ─────────────────────────────────────────────────────────────────────────────
describe('writeBatchMessages', () => {
  beforeEach(() => jest.clearAllMocks());

  test('generates emails for up to 10 leads', async () => {
    mockAnthropicCreate.mockResolvedValue({
      content: [{ text: '{"subject":"Hi","body":"Hello","previewText":"Hey","sequenceNumber":1,"angle":"test"}' }],
    });

    const leads = Array.from({ length: 12 }, (_, i) => ({ ...mockLead, id: `lead-${i}` }));
    const results = await messageWriterService.writeBatchMessages(mockBrand, leads);

    expect(results).toHaveLength(10);
    expect(results.every(r => r.message)).toBe(true);
  });

  test('handles individual failures gracefully', async () => {
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ text: '{"subject":"OK","body":"...","previewText":"","sequenceNumber":1,"angle":"a"}' }] })
      .mockRejectedValueOnce(new Error('API error'));

    const results = await messageWriterService.writeBatchMessages(mockBrand, [
      { ...mockLead, id: 'ok-lead' },
      { ...mockLead, id: 'fail-lead' },
    ]);

    expect(results).toHaveLength(2);
    expect(results[0].message).toBeDefined();
    expect(results[1].error).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// messageWriterService.learnFromReply
// ─────────────────────────────────────────────────────────────────────────────
describe('learnFromReply', () => {
  beforeEach(() => jest.clearAllMocks());

  test('extracts learning from positive reply', async () => {
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{
        text: JSON.stringify({
          learning:             'Personalization on company challenges works',
          whatWorked:            'Specific reference to their expansion plans',
          objection:            null,
          suggestedAdjustment:  'Lead more with market data',
        }),
      }],
    });

    BrandProject.findByIdAndUpdate.mockResolvedValueOnce({});

    const result = await messageWriterService.learnFromReply(
      mockBrand, mockLead, 'Thanks, let\'s schedule a call!', 'positive',
    );

    expect(result.learning).toBe('Personalization on company challenges works');
    expect(result.whatWorked).toContain('expansion');
    expect(BrandProject.findByIdAndUpdate).toHaveBeenCalledWith(
      'brand123',
      expect.objectContaining({
        $push: expect.objectContaining({
          'agentMemory.contentInsights': expect.any(Object),
        }),
      }),
    );
  });

  test('handles AI failure gracefully', async () => {
    mockAnthropicCreate.mockRejectedValueOnce(new Error('timeout'));

    const result = await messageWriterService.learnFromReply(
      mockBrand, mockLead, 'Reply text', 'neutral',
    );

    expect(result.learning).toBe('');
    expect(result.whatWorked).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// emailSendingService.sendOutreachEmail
// ─────────────────────────────────────────────────────────────────────────────
describe('sendOutreachEmail', () => {
  beforeEach(() => {
    process.env.QUMAK_MAILCHIMP_API_KEY = 'test-mandrill-key';
    jest.clearAllMocks();
  });

  const draftMessage = {
    id:             'msg-001',
    subject:        'Exclusive scents',
    body:           'Hi Sarah, I wanted to reach out...',
    sequenceNumber: 1,
    status:         'draft',
  };

  test('sends email via Mandrill and updates lead stage', async () => {
    axios.post.mockResolvedValueOnce({
      data: [{ _id: 'mandrill-msg-123', status: 'sent' }],
    });
    BrandProject.findOneAndUpdate.mockResolvedValue({});

    const result = await emailSendingService.sendOutreachEmail(
      mockBrand, { ...mockLead, outreachMessages: [draftMessage] }, draftMessage,
    );

    expect(result.success).toBe(true);
    expect(result.mandrillId).toBe('mandrill-msg-123');
    expect(result.status).toBe('sent');
    expect(result.sentAt).toBeInstanceOf(Date);

    expect(axios.post).toHaveBeenCalledWith(
      expect.stringContaining('/messages/send'),
      expect.objectContaining({
        key:     'test-mandrill-key',
        message: expect.objectContaining({
          subject:    'Exclusive scents',
          from_email: 'outreach@qumak.io',
          to:         expect.arrayContaining([
            expect.objectContaining({ email: 'sarah@luxuryretail.ae' }),
          ]),
          track_opens: true,
        }),
      }),
      expect.any(Object),
    );
  });

  test('throws when Mandrill key is missing', async () => {
    process.env.QUMAK_MAILCHIMP_API_KEY = '';
    await expect(
      emailSendingService.sendOutreachEmail(mockBrand, mockLead, draftMessage),
    ).rejects.toThrow('Mailchimp API key not configured');
  });

  test('throws when lead has no email', async () => {
    await expect(
      emailSendingService.sendOutreachEmail(mockBrand, { ...mockLead, email: null }, draftMessage),
    ).rejects.toThrow('Lead has no email address');
  });

  test('throws when Mandrill rejects the message', async () => {
    axios.post.mockResolvedValueOnce({
      data: [{ status: 'rejected', reject_reason: 'unsigned' }],
    });

    await expect(
      emailSendingService.sendOutreachEmail(mockBrand, mockLead, draftMessage),
    ).rejects.toThrow(/rejected/i);
  });

  test('converts plain text body to HTML with brand signature', async () => {
    axios.post.mockResolvedValueOnce({
      data: [{ _id: 'msg-1', status: 'sent' }],
    });
    BrandProject.findOneAndUpdate.mockResolvedValue({});

    await emailSendingService.sendOutreachEmail(mockBrand, mockLead, draftMessage);

    const payload = axios.post.mock.calls[0][1];
    expect(payload.message.html).toContain('Desert Bloom Perfume');
    expect(payload.message.html).toContain('qumak.io');
    expect(payload.message.text).toBe(draftMessage.body);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// emailSendingService.handleWebhook
// ─────────────────────────────────────────────────────────────────────────────
describe('handleWebhook', () => {
  beforeEach(() => jest.clearAllMocks());

  test('processes open events', async () => {
    BrandProject.findOneAndUpdate.mockResolvedValue({});

    const event = {
      event: 'open',
      _id:   'mandrill-123',
      msg:   { metadata: { brandId: 'b1', leadId: 'l1' } },
    };

    const result = await emailSendingService.handleWebhook(event);
    expect(result.processed).toBe(1);
    expect(BrandProject.findOneAndUpdate).toHaveBeenCalled();
  });

  test('processes hard_bounce — marks lead as not_fit', async () => {
    BrandProject.findOneAndUpdate.mockResolvedValue({});

    const event = {
      event: 'hard_bounce',
      _id:   'mandrill-456',
      msg:   { metadata: { brandId: 'b1', leadId: 'l1' } },
    };

    const result = await emailSendingService.handleWebhook(event);
    expect(result.processed).toBe(1);
    expect(BrandProject.findOneAndUpdate).toHaveBeenCalledTimes(2);
  });

  test('skips events with missing metadata', async () => {
    const result = await emailSendingService.handleWebhook({
      event: 'open',
      _id:   'mandrill-789',
    });
    expect(result.processed).toBe(0);
  });

  test('handles array of events', async () => {
    BrandProject.findOneAndUpdate.mockResolvedValue({});

    const events = [
      { event: 'open', _id: 'm1', msg: { metadata: { brandId: 'b1', leadId: 'l1' } } },
      { event: 'open', _id: 'm2', msg: { metadata: { brandId: 'b1', leadId: 'l2' } } },
    ];

    const result = await emailSendingService.handleWebhook(events);
    expect(result.processed).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// leadsController — route-level tests
// ─────────────────────────────────────────────────────────────────────────────
describe('leadsController', () => {
  let ctrl;
  let res;

  function makeReq(overrides = {}) {
    return {
      params: {},
      query:  {},
      body:   {},
      user:   { _id: 'user123' },
      ...overrides,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.QUMAK_APOLO_LEADS_API_KEY = 'test-apollo-key';
    process.env.QUMAK_MAILCHIMP_API_KEY   = 'test-mandrill-key';

    ctrl = require('../controllers/brandProject/leadsController');

    const brandWithLead = {
      _id:          'brand123',
      projectName:  'Desert Bloom',
      businessType: 'perfume',
      leads:        [{ ...mockLead, outreachMessages: [] }],
      config:       { brand: {} },
      agentMemory:  {},
      toObject()    { return { ...this }; },
    };
    BrandProject.findOne.mockResolvedValue(brandWithLead);

    res = {
      status: jest.fn().mockReturnThis(),
      json:   jest.fn(),
    };
  });

  describe('getLeads', () => {
    test('returns leads for authenticated user', async () => {
      await ctrl.getLeads(makeReq({ params: { brandId: 'brand123' } }), res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, leads: expect.any(Array), total: 1 }),
      );
    });

    test('returns 404 if brand not found', async () => {
      BrandProject.findOne.mockResolvedValueOnce(null);
      BrandProject.findById.mockReturnValueOnce(chainable(null));

      await ctrl.getLeads(makeReq({ params: { brandId: 'nonexistent' } }), res);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    test('filters leads by stage', async () => {
      BrandProject.findOne.mockResolvedValueOnce({
        _id: 'b1',
        leads: [
          { ...mockLead, id: 'l1', leadStage: 'contacted', icpScore: 80 },
          { ...mockLead, id: 'l2', leadStage: 'new', icpScore: 70 },
        ],
      });

      await ctrl.getLeads(makeReq({
        params: { brandId: 'b1' },
        query:  { stage: 'contacted' },
      }), res);

      const result = res.json.mock.calls[0][0];
      expect(result.success).toBe(true);
      expect(result.leads.every(l => l.leadStage === 'contacted')).toBe(true);
    });

    test('filters leads by minimum score', async () => {
      BrandProject.findOne.mockResolvedValueOnce({
        _id: 'b1',
        leads: [
          { ...mockLead, id: 'l1', icpScore: 90 },
          { ...mockLead, id: 'l2', icpScore: 40 },
        ],
      });

      await ctrl.getLeads(makeReq({
        params: { brandId: 'b1' },
        query:  { minScore: '60' },
      }), res);

      const result = res.json.mock.calls[0][0];
      expect(result.leads).toHaveLength(1);
      expect(result.leads[0].icpScore).toBe(90);
    });

    test('paginates leads', async () => {
      const manyLeads = Array.from({ length: 15 }, (_, i) => ({
        ...mockLead, id: `l${i}`, icpScore: 80 - i,
      }));
      BrandProject.findOne.mockResolvedValueOnce({ _id: 'b1', leads: manyLeads });

      await ctrl.getLeads(makeReq({
        params: { brandId: 'b1' },
        query:  { limit: '5', page: '2' },
      }), res);

      const result = res.json.mock.calls[0][0];
      expect(result.leads).toHaveLength(5);
      expect(result.total).toBe(15);
      expect(result.page).toBe(2);
      expect(result.pages).toBe(3);
    });
  });

  describe('findLeads', () => {
    test('triggers Apollo search and returns results', async () => {
      axios.post.mockResolvedValueOnce({
        data: {
          people:     [apolloPerson],
          pagination: { page: 1, total_entries: 1 },
        },
      });

      mockAnthropicCreate.mockResolvedValueOnce({
        content: [{ text: '[{"index":0,"score":88,"rationale":"Buyer at retail","painPoint":"Margin","angle":"ROI"}]' }],
      });

      BrandProject.findById.mockReturnValueOnce(chainable({ leads: [] }));
      BrandProject.findByIdAndUpdate.mockResolvedValueOnce({});

      await ctrl.findLeads(makeReq({
        params: { brandId: 'brand123' },
        body:   { count: 25, page: 1 },
      }), res);

      const result = res.json.mock.calls[0][0];
      expect(result.success).toBe(true);
      expect(result.found).toBe(1);
      expect(result.leads[0].estimatedDealValueAED).toBeDefined();
    });
  });

  describe('generateMessage', () => {
    test('generates email for a specific lead', async () => {
      mockAnthropicCreate.mockResolvedValueOnce({
        content: [{ text: '{"subject":"Hi Sarah","body":"Hello","previewText":"Hey","sequenceNumber":1,"angle":"value"}' }],
      });
      BrandProject.findOneAndUpdate.mockResolvedValueOnce({});

      await ctrl.generateMessage(makeReq({
        params: { brandId: 'brand123', leadId: 'lead-uuid-001' },
        body:   { sequenceNumber: 1 },
      }), res);

      const result = res.json.mock.calls[0][0];
      expect(result.success).toBe(true);
      expect(result.message.subject).toBe('Hi Sarah');
    });

    test('returns 404 for non-existent lead', async () => {
      await ctrl.generateMessage(makeReq({
        params: { brandId: 'brand123', leadId: 'nonexistent' },
        body:   { sequenceNumber: 1 },
      }), res);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe('sendEmail', () => {
    test('sends email for a lead with draft message', async () => {
      const draftMsg = {
        id: 'msg-1', subject: 'Test', body: 'Body', status: 'draft',
        sequenceNumber: 1, sentAt: null,
      };
      BrandProject.findOne.mockResolvedValueOnce({
        _id: 'brand123', projectName: 'Desert Bloom',
        leads: [{ ...mockLead, outreachMessages: [draftMsg] }],
        config: { brand: {} },
      });

      axios.post.mockResolvedValueOnce({
        data: [{ _id: 'mandrill-1', status: 'sent' }],
      });
      BrandProject.findOneAndUpdate.mockResolvedValue({});

      await ctrl.sendEmail(makeReq({
        params: { brandId: 'brand123', leadId: 'lead-uuid-001' },
        body:   { messageIndex: 0 },
      }), res);

      const result = res.json.mock.calls[0][0];
      expect(result.success).toBe(true);
    });

    test('respects daily send limit', async () => {
      const sentMsgs = Array.from({ length: 50 }, (_, i) => ({
        id: `m${i}`, status: 'sent', sentAt: new Date(),
      }));
      BrandProject.findOne.mockResolvedValueOnce({
        _id: 'brand123',
        leads: [{ ...mockLead, outreachMessages: sentMsgs }],
      });

      await ctrl.sendEmail(makeReq({
        params: { brandId: 'brand123', leadId: 'lead-uuid-001' },
        body:   { messageIndex: 0 },
      }), res);

      expect(res.status).toHaveBeenCalledWith(429);
      const result = res.json.mock.calls[0][0];
      expect(result.message).toContain('Daily send limit');
    });

    test('returns 400 when lead has no email', async () => {
      BrandProject.findOne.mockResolvedValueOnce({
        _id: 'brand123',
        leads: [{ ...mockLead, email: null, outreachMessages: [] }],
      });

      await ctrl.sendEmail(makeReq({
        params: { brandId: 'brand123', leadId: 'lead-uuid-001' },
        body:   {},
      }), res);

      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  describe('updateLeadStage', () => {
    test('updates lead stage', async () => {
      BrandProject.findOneAndUpdate.mockResolvedValueOnce({});

      await ctrl.updateLeadStage(makeReq({
        params: { brandId: 'brand123', leadId: 'lead-uuid-001' },
        body:   { stage: 'contacted' },
      }), res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, stage: 'contacted' }),
      );
    });

    test('rejects invalid stage', async () => {
      await ctrl.updateLeadStage(makeReq({
        params: { brandId: 'brand123', leadId: 'lead-uuid-001' },
        body:   { stage: 'invalid_stage' },
      }), res);

      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  describe('deleteLead', () => {
    test('deletes lead from brand', async () => {
      BrandProject.findByIdAndUpdate.mockResolvedValueOnce({});

      await ctrl.deleteLead(makeReq({
        params: { brandId: 'brand123', leadId: 'lead-uuid-001' },
      }), res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, deleted: true }),
      );
      expect(BrandProject.findByIdAndUpdate).toHaveBeenCalledWith(
        'brand123',
        { $pull: { leads: { id: 'lead-uuid-001' } } },
      );
    });
  });

  describe('getStats', () => {
    test('returns lead pipeline statistics', async () => {
      BrandProject.findOne.mockResolvedValueOnce({
        _id: 'brand123',
        leads: [
          { ...mockLead, id: 'l1', leadStage: 'new', icpScore: 80, outreachMessages: [] },
          { ...mockLead, id: 'l2', leadStage: 'contacted', icpScore: 90, outreachMessages: [
            { status: 'sent', sentAt: new Date() },
          ] },
          { ...mockLead, id: 'l3', leadStage: 'replied', icpScore: 95, outreachMessages: [
            { status: 'replied', sentAt: new Date() },
          ] },
        ],
      });

      await ctrl.getStats(makeReq({ params: { brandId: 'brand123' } }), res);

      const result = res.json.mock.calls[0][0];
      expect(result.success).toBe(true);
      expect(result.stats.totalLeads).toBe(3);
      expect(result.stats.stageCounts.new).toBe(1);
      expect(result.stats.stageCounts.contacted).toBe(1);
      expect(result.stats.avgIcpScore).toBeGreaterThan(0);
      expect(result.stats.daily).toBeDefined();
      expect(result.stats.outreach).toBeDefined();
    });
  });

  describe('handleResendWebhook', () => {
    test('processes Mandrill webhook events', async () => {
      BrandProject.findOneAndUpdate.mockResolvedValue({});

      const req = makeReq({
        body: {
          mandrill_events: JSON.stringify([
            { event: 'open', _id: 'm1', msg: { metadata: { brandId: 'b1', leadId: 'l1' } } },
          ]),
        },
      });

      await ctrl.handleResendWebhook(req, res);

      const result = res.json.mock.calls[0][0];
      expect(result.success).toBe(true);
      expect(result.processed).toBe(1);
    });
  });

  describe('generateBatchMessages', () => {
    test('generates messages for multiple leads', async () => {
      BrandProject.findOne.mockResolvedValueOnce({
        _id: 'brand123',
        leads: [
          { ...mockLead, id: 'l1' },
          { ...mockLead, id: 'l2' },
        ],
        config: { brand: {} },
        agentMemory: {},
      });

      mockAnthropicCreate.mockResolvedValue({
        content: [{ text: '{"subject":"Hi","body":"Hello","previewText":"Hey","sequenceNumber":1,"angle":"a"}' }],
      });
      BrandProject.findOneAndUpdate.mockResolvedValue({});

      await ctrl.generateBatchMessages(makeReq({
        params: { brandId: 'brand123' },
        body:   { maxLeads: 10 },
      }), res);

      const result = res.json.mock.calls[0][0];
      expect(result.success).toBe(true);
      expect(result.generated).toBe(2);
    });
  });

  describe('updateMessage', () => {
    test('updates message subject and body', async () => {
      const msg = { id: 'msg-1', subject: 'Old', body: 'Old body', status: 'draft', sequenceNumber: 1 };
      BrandProject.findOne.mockResolvedValueOnce({
        _id: 'brand123',
        leads: [{ ...mockLead, outreachMessages: [msg] }],
      });
      BrandProject.findOneAndUpdate.mockResolvedValueOnce({});

      await ctrl.updateMessage(makeReq({
        params: { brandId: 'brand123', leadId: 'lead-uuid-001', messageIndex: '0' },
        body:   { subject: 'New Subject', body: 'New body' },
      }), res);

      const result = res.json.mock.calls[0][0];
      expect(result.success).toBe(true);
      expect(BrandProject.findOneAndUpdate).toHaveBeenCalled();
    });

    test('rejects invalid message index', async () => {
      await ctrl.updateMessage(makeReq({
        params: { brandId: 'brand123', leadId: 'lead-uuid-001', messageIndex: '99' },
        body:   { subject: 'X' },
      }), res);

      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  describe('sendBatch', () => {
    test('sends emails in batch', async () => {
      const draftMsg = { id: 'msg-1', subject: 'Hi', body: 'Body', status: 'draft', sequenceNumber: 1, sentAt: null };
      BrandProject.findOne.mockResolvedValueOnce({
        _id: 'brand123', projectName: 'Test',
        leads: [
          { ...mockLead, id: 'l1', outreachMessages: [draftMsg] },
          { ...mockLead, id: 'l2', email: 'test2@test.com', outreachMessages: [{ ...draftMsg, id: 'msg-2' }] },
        ],
        config: { brand: {} },
      });

      axios.post.mockResolvedValue({ data: [{ _id: 'mandrill-x', status: 'sent' }] });
      BrandProject.findOneAndUpdate.mockResolvedValue({});

      await ctrl.sendBatch(makeReq({
        params: { brandId: 'brand123' },
        body:   { leadIds: ['l1', 'l2'] },
      }), res);

      const result = res.json.mock.calls[0][0];
      expect(result.success).toBe(true);
      expect(result.sent).toBe(2);
    });
  });
});
