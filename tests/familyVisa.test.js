const request = require('supertest');
const mongoose = require('mongoose');
const { expect } = require('chai');
const app = require('../index');
const FamilyVisaLead = require('../model/schema/familyVisaLead');

// Test data
const validSpouseSponsor = {
  fullName: 'Test User',
  contactMethod: 'whatsapp',
  contactValue: '+971501234567',
  sponsorSalary: '8000',
  visaStatus: 'employment',
  nationality: 'indian',
  dependentType: 'spouse',
  numberOfDependents: 1
};

const lowSalarySponsor = {
  fullName: 'Low Salary User',
  contactMethod: 'email',
  contactValue: 'test@example.com',
  sponsorSalary: '3000',
  visaStatus: 'employment',
  nationality: 'pakistani',
  dependentType: 'spouse',
  numberOfDependents: 1
};

const parentSponsor = {
  fullName: 'Parent Sponsor',
  contactMethod: 'whatsapp',
  contactValue: '+971507654321',
  sponsorSalary: '25000',
  visaStatus: 'employment',
  nationality: 'british',
  dependentType: 'parent',
  numberOfDependents: 2
};

const lowSalaryParentSponsor = {
  fullName: 'Low Parent Sponsor',
  contactMethod: 'whatsapp',
  contactValue: '+971509876543',
  sponsorSalary: '15000',
  visaStatus: 'employment',
  nationality: 'american',
  dependentType: 'parent',
  numberOfDependents: 1
};

describe('Family Visa Eligibility API', function() {
  this.timeout(10000);
  
  before(async function() {
    // Connect to test database if not already connected
    const testDbUrl = process.env.TEST_DB_URL || 'mongodb://127.0.0.1:27017/qumak_test';
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(testDbUrl);
    }
  });

  after(async function() {
    // Clean up test data
    try {
      await FamilyVisaLead.deleteMany({ fullName: /^Test|^Low|^Parent/ });
    } catch (e) {
      // Ignore cleanup errors
    }
  });

  beforeEach(async function() {
    // Clean up before each test
    try {
      await FamilyVisaLead.deleteMany({ fullName: /^Test|^Low|^Parent/ });
    } catch (e) {
      // Ignore cleanup errors
    }
  });

  // ==========================================
  // GET /api/v1/family-visa/requirements
  // ==========================================
  describe('GET /api/v1/family-visa/requirements', function() {
    it('should return salary requirements', async function() {
      const res = await request(app)
        .get('/api/v1/family-visa/requirements');
      
      expect(res.status).to.equal(200);
      expect(res.body.success).to.equal(true);
      expect(res.body.data.requirements).to.exist;
      expect(res.body.data.requirements.spouse).to.equal(4000);
      expect(res.body.data.requirements.child).to.equal(4000);
      expect(res.body.data.requirements.parent).to.equal(20000);
    });
  });

  // ==========================================
  // POST /api/v1/family-visa/check-eligibility
  // ==========================================
  describe('POST /api/v1/family-visa/check-eligibility', function() {
    
    it('should approve eligible spouse sponsor', async function() {
      const res = await request(app)
        .post('/api/v1/family-visa/check-eligibility')
        .send(validSpouseSponsor);
      
      expect(res.status).to.equal(201);
      expect(res.body.success).to.equal(true);
      expect(res.body.data.eligible).to.equal(true);
      expect(res.body.data.referenceNumber).to.match(/^FVE-/);
      expect(res.body.data.requirements.meetsRequirement).to.equal(true);
    });

    it('should reject low salary spouse sponsor', async function() {
      const res = await request(app)
        .post('/api/v1/family-visa/check-eligibility')
        .send(lowSalarySponsor);
      
      expect(res.status).to.equal(201);
      expect(res.body.success).to.equal(true);
      expect(res.body.data.eligible).to.equal(false);
      expect(res.body.data.requirements.meetsRequirement).to.equal(false);
      expect(res.body.data.reasons.some(r => r.includes('Minimum salary'))).to.equal(true);
    });

    it('should approve eligible parent sponsor with high salary', async function() {
      const res = await request(app)
        .post('/api/v1/family-visa/check-eligibility')
        .send(parentSponsor);
      
      expect(res.status).to.equal(201);
      expect(res.body.success).to.equal(true);
      expect(res.body.data.eligible).to.equal(true);
      expect(res.body.data.requirements.minimumSalary).to.equal(20000);
    });

    it('should reject parent sponsor with insufficient salary', async function() {
      const res = await request(app)
        .post('/api/v1/family-visa/check-eligibility')
        .send(lowSalaryParentSponsor);
      
      expect(res.status).to.equal(201);
      expect(res.body.success).to.equal(true);
      expect(res.body.data.eligible).to.equal(false);
      expect(res.body.data.reasons.some(r => r.includes('20,000'))).to.equal(true);
    });

    it('should reject request with missing required fields', async function() {
      const res = await request(app)
        .post('/api/v1/family-visa/check-eligibility')
        .send({
          fullName: 'Test',
          // Missing other required fields
        });
      
      expect(res.status).to.equal(400);
      expect(res.body.success).to.equal(false);
      expect(res.body.message).to.include('required');
    });

    it('should create lead in database', async function() {
      await request(app)
        .post('/api/v1/family-visa/check-eligibility')
        .send(validSpouseSponsor);
      
      const lead = await FamilyVisaLead.findOne({ fullName: 'Test User' });
      expect(lead).to.exist;
      expect(lead.sponsorSalary).to.equal(8000);
      expect(lead.dependentType).to.equal('spouse');
      expect(lead.status).to.equal('new');
    });
  });

  // ==========================================
  // Model Unit Tests
  // ==========================================
  describe('FamilyVisaLead Model', function() {
    
    it('should generate unique reference number', async function() {
      const lead1 = await FamilyVisaLead.create({
        ...validSpouseSponsor,
        fullName: 'Test Lead 1',
        eligibilityResult: { eligible: true, reasons: ['Eligible'] }
      });
      
      const lead2 = await FamilyVisaLead.create({
        ...validSpouseSponsor,
        contactValue: '+971509999999',
        fullName: 'Test Lead 2',
        eligibilityResult: { eligible: true, reasons: ['Eligible'] }
      });
      
      expect(lead1.referenceNumber).to.match(/^FVE-/);
      expect(lead2.referenceNumber).to.match(/^FVE-/);
      expect(lead1.referenceNumber).to.not.equal(lead2.referenceNumber);
    });

    it('should correctly check spouse eligibility', function() {
      const result = FamilyVisaLead.checkEligibility({
        sponsorSalary: '5000',
        visaStatus: 'employment',
        nationality: 'indian',
        dependentType: 'spouse'
      });
      
      expect(result.eligible).to.equal(true);
    });

    it('should correctly reject low salary for spouse', function() {
      const result = FamilyVisaLead.checkEligibility({
        sponsorSalary: '3500',
        visaStatus: 'employment',
        nationality: 'indian',
        dependentType: 'spouse'
      });
      
      expect(result.eligible).to.equal(false);
      expect(result.reasons[0]).to.include('Minimum salary');
    });

    it('should correctly check parent eligibility with high salary', function() {
      const result = FamilyVisaLead.checkEligibility({
        sponsorSalary: '22000',
        visaStatus: 'employment',
        nationality: 'british',
        dependentType: 'parent'
      });
      
      expect(result.eligible).to.equal(true);
    });

    it('should reject parent sponsorship with low salary', function() {
      const result = FamilyVisaLead.checkEligibility({
        sponsorSalary: '18000',
        visaStatus: 'employment',
        nationality: 'british',
        dependentType: 'parent'
      });
      
      expect(result.eligible).to.equal(false);
      expect(result.reasons[0]).to.include('20,000');
    });

    it('should warn about partner visa parent sponsorship', function() {
      const result = FamilyVisaLead.checkEligibility({
        sponsorSalary: '25000',
        visaStatus: 'partner',
        nationality: 'american',
        dependentType: 'parent'
      });
      
      expect(result.reasons.some(r => r.includes('Partner visa holders'))).to.equal(true);
    });
  });
});

// ==========================================
// Eligibility Logic Unit Tests
// ==========================================
describe('Eligibility Logic', function() {
  
  describe('Spouse sponsorship', function() {
    it('AED 4000 salary should be eligible', function() {
      const result = FamilyVisaLead.checkEligibility({
        sponsorSalary: '4000',
        visaStatus: 'employment',
        nationality: 'indian',
        dependentType: 'spouse'
      });
      expect(result.eligible).to.equal(true);
    });

    it('AED 3999 salary should not be eligible', function() {
      const result = FamilyVisaLead.checkEligibility({
        sponsorSalary: '3999',
        visaStatus: 'employment',
        nationality: 'indian',
        dependentType: 'spouse'
      });
      expect(result.eligible).to.equal(false);
    });
  });

  describe('Child sponsorship', function() {
    it('AED 4000 salary should be eligible', function() {
      const result = FamilyVisaLead.checkEligibility({
        sponsorSalary: '4000',
        visaStatus: 'employment',
        nationality: 'pakistani',
        dependentType: 'child'
      });
      expect(result.eligible).to.equal(true);
    });
  });

  describe('Parent sponsorship', function() {
    it('AED 20000 salary should be eligible', function() {
      const result = FamilyVisaLead.checkEligibility({
        sponsorSalary: '20000',
        visaStatus: 'employment',
        nationality: 'british',
        dependentType: 'parent'
      });
      expect(result.eligible).to.equal(true);
    });

    it('AED 19999 salary should not be eligible', function() {
      const result = FamilyVisaLead.checkEligibility({
        sponsorSalary: '19999',
        visaStatus: 'employment',
        nationality: 'british',
        dependentType: 'parent'
      });
      expect(result.eligible).to.equal(false);
    });
  });
});
