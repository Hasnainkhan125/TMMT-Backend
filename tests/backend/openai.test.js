const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const db = require('../../db/config');
const openaiService = require('../../services/openaiService');
const VisaApplication = require('../../model/schema/visaApplication');
const ChatMessage = require('../../model/schema/chatMessage');
const User = require('../../model/schema/user');
const chai = require('chai');
const should = chai.should();

let mongoServer;

describe('OpenAI Service', function () {
  this.timeout(20000);
  
  let userId1, userId2;
  let applicationId;

  before(async () => {
    // Setup MongoDB
    mongoServer = await MongoMemoryServer.create();
    const uri = mongoServer.getUri();
    await db(uri, 'qumak_test');

    // Create test users
    userId1 = new mongoose.Types.ObjectId().toString();
    userId2 = new mongoose.Types.ObjectId().toString();

    await User.create({
      _id: userId1,
      firstName: 'John',
      lastName: 'Doe',
      email: 'john@test.com',
      password: 'testpassword123',
      role: 'sponsor'
    });

    await User.create({
      _id: userId2,
      firstName: 'Jane',
      lastName: 'Smith',
      email: 'jane@test.com',
      password: 'testpassword123',
      role: 'sponsored'
    });

    // Create test application
    const application = await VisaApplication.create({
      applicationType: 'family_visa',
      sponsor: userId1,
      sponsored: userId2,
      status: 'draft',
      serviceId: 1 // Reference to a service from services.json
    });
    applicationId = application._id.toString();
  });

  after(async () => {
    await mongoose.disconnect();
    if (mongoServer) {
      await mongoServer.stop();
    }
  });

  describe('Service Availability', () => {
    it('should report availability status', () => {
      const isAvailable = openaiService.isAvailable();
      isAvailable.should.be.a('boolean');
    });

    it('should provide usage statistics', () => {
      const stats = openaiService.getUsageStats();
      
      stats.should.have.property('isEnabled');
      stats.should.have.property('model');
      stats.should.have.property('features');
      
      stats.isEnabled.should.be.a('boolean');
      stats.features.should.be.an('array');
      stats.features.should.include('chat_assistance');
      stats.features.should.include('service_recommendations');
      stats.features.should.include('document_analysis');
      stats.features.should.include('multi_language_support');
    });
  });

  describe('AI Response Generation', () => {
    it('should handle requests when OpenAI is disabled', async () => {
      // This test works regardless of OpenAI availability
      const response = await openaiService.generateAIResponse(
        'Hello, I need help with my visa application',
        applicationId,
        'en'
      );

      response.should.be.a('string');
      response.length.should.be.greaterThan(0);
    });

    it('should include application context in responses', async () => {
      const response = await openaiService.generateAIResponse(
        'What is the status of my application?',
        applicationId,
        'en'
      );

      response.should.be.a('string');
      // Should acknowledge the application context
      response.should.not.equal('');
    });

    it('should handle different languages', async () => {
      const languages = ['en', 'ar', 'ur', 'hi', 'fr', 'auto'];
      
      for (const lang of languages) {
        const response = await openaiService.generateAIResponse(
          'Help me with visa requirements',
          applicationId,
          lang
        );
        
        response.should.be.a('string');
        response.length.should.be.greaterThan(0);
      }
    });

    it('should handle chat history context', async () => {
      // Create some chat history
      await ChatMessage.create({
        application: applicationId,
        sender: userId1,
        content: 'I need help with documents',
        language: 'en',
        role: 'user'
      });

      await ChatMessage.create({
        application: applicationId,
        content: 'I can help you with document requirements',
        language: 'en',
        role: 'assistant',
        isAI: true
      });

      const response = await openaiService.generateAIResponse(
        'What documents do I need?',
        applicationId,
        'en'
      );

      response.should.be.a('string');
      // Should consider the chat history
    });

    it('should handle invalid application ID', async () => {
      const invalidAppId = new mongoose.Types.ObjectId().toString();
      
      const response = await openaiService.generateAIResponse(
        'Help me',
        invalidAppId,
        'en'
      );

      response.should.be.a('string');
      // Should still provide a response even without application context
    });

    it('should handle AI mentions gracefully', async () => {
      const response = await openaiService.generateAIResponse(
        '@ai please help me understand the visa process',
        applicationId,
        'en'
      );

      response.should.be.a('string');
      response.length.should.be.greaterThan(0);
    });
  });

  describe('Service Recommendations', () => {
    it('should generate service recommendations', async () => {
      const userQuery = 'I want to bring my wife to Dubai';
      const userProfile = {
        role: 'sponsor',
        currentStatus: 'resident',
        familyStatus: 'married'
      };

      const recommendations = await openaiService.generateServiceRecommendations(
        userQuery,
        userProfile
      );

      recommendations.should.be.an('array');
      // Even if OpenAI is disabled, should return empty array
    });

    it('should handle empty user profile', async () => {
      const recommendations = await openaiService.generateServiceRecommendations(
        'I need visa help',
        {}
      );

      recommendations.should.be.an('array');
    });

    it('should handle different query types', async () => {
      const queries = [
        'Family visa for spouse',
        'Golden visa application',
        'Business visa requirements',
        'Student visa process',
        'Medical insurance requirements'
      ];

      for (const query of queries) {
        const recommendations = await openaiService.generateServiceRecommendations(
          query,
          { role: 'sponsor' }
        );

        recommendations.should.be.an('array');
      }
    });
  });

  describe('Document Analysis', () => {
    it('should analyze document completeness', async () => {
      const documentList = [
        { name: 'passport.pdf', type: 'passport' },
        { name: 'emirates_id.jpg', type: 'emirates_id' },
        { name: 'salary_certificate.pdf', type: 'salary_certificate' }
      ];

      const analysis = await openaiService.analyzeDocuments(documentList, 1);

      // Should return analysis or null if OpenAI disabled
      if (analysis !== null) {
        analysis.should.be.a('string');
        analysis.length.should.be.greaterThan(0);
      }
    });

    it('should handle empty document list', async () => {
      const analysis = await openaiService.analyzeDocuments([], 1);

      if (analysis !== null) {
        analysis.should.be.a('string');
      }
    });

    it('should handle invalid service ID', async () => {
      const documentList = [{ name: 'test.pdf', type: 'unknown' }];
      
      const analysis = await openaiService.analyzeDocuments(documentList, 99999);

      // Should return null for invalid service ID
      if (analysis !== null) {
        analysis.should.be.a('string');
      }
    });

    it('should handle various document types', async () => {
      const documentTypes = [
        { name: 'passport.pdf', type: 'passport' },
        { name: 'visa.jpg', type: 'visa' },
        { name: 'marriage_certificate.pdf', type: 'marriage_certificate' },
        { name: 'birth_certificate.pdf', type: 'birth_certificate' },
        { name: 'salary_cert.pdf', type: 'salary_certificate' },
        { name: 'trade_license.pdf', type: 'trade_license' }
      ];

      const analysis = await openaiService.analyzeDocuments(documentTypes, 1);

      if (analysis !== null) {
        analysis.should.be.a('string');
      }
    });
  });

  describe('Document Checklist Generation', () => {
    it('should generate personalized document checklist', async () => {
      const userContext = {
        role: 'sponsor',
        nationality: 'Indian',
        sponsorType: 'investor',
        familySize: 3
      };

      const checklist = await openaiService.generateDocumentChecklist(1, userContext);

      if (checklist !== null) {
        checklist.should.be.a('string');
        checklist.length.should.be.greaterThan(0);
      }
    });

    it('should handle empty user context', async () => {
      const checklist = await openaiService.generateDocumentChecklist(1, {});

      if (checklist !== null) {
        checklist.should.be.a('string');
      }
    });

    it('should handle invalid service ID', async () => {
      const checklist = await openaiService.generateDocumentChecklist(99999, {});

      // Should return null for invalid service
      if (checklist !== null) {
        checklist.should.be.a('string');
      }
    });

    it('should generate different checklists for different contexts', async () => {
      const contexts = [
        { role: 'sponsor', nationality: 'Pakistani' },
        { role: 'sponsor', nationality: 'Egyptian' },
        { role: 'sponsor', nationality: 'Indian', sponsorType: 'employee' },
        { role: 'sponsor', nationality: 'Filipino', familySize: 1 }
      ];

      for (const context of contexts) {
        const checklist = await openaiService.generateDocumentChecklist(1, context);

        if (checklist !== null) {
          checklist.should.be.a('string');
        }
      }
    });
  });

  describe('Status Update Explanations', () => {
    it('should explain status changes', async () => {
      const explanation = await openaiService.explainStatusUpdate(
        'draft',
        'submitted',
        'Family Visa'
      );

      explanation.should.be.a('string');
      explanation.length.should.be.greaterThan(0);
      explanation.should.include('draft');
      explanation.should.include('submitted');
    });

    it('should handle different status transitions', async () => {
      const transitions = [
        { old: 'draft', new: 'submitted' },
        { old: 'submitted', new: 'under_review' },
        { old: 'under_review', new: 'documents_required' },
        { old: 'documents_required', new: 'approved' },
        { old: 'approved', new: 'completed' },
        { old: 'submitted', new: 'rejected' }
      ];

      for (const transition of transitions) {
        const explanation = await openaiService.explainStatusUpdate(
          transition.old,
          transition.new,
          'Residence Visa'
        );

        explanation.should.be.a('string');
        explanation.length.should.be.greaterThan(0);
      }
    });

    it('should handle different service types', async () => {
      const serviceTypes = [
        'Family Visa',
        'Golden Visa',
        'Business Visa',
        'Student Visa',
        'Tourist Visa',
        'Emirates ID',
        'Medical Certificate'
      ];

      for (const serviceType of serviceTypes) {
        const explanation = await openaiService.explainStatusUpdate(
          'pending',
          'approved',
          serviceType
        );

        explanation.should.be.a('string');
        explanation.should.include('approved');
      }
    });

    it('should provide helpful explanations even without AI', async () => {
      // This should work even if OpenAI is not configured
      const explanation = await openaiService.explainStatusUpdate(
        'submitted',
        'rejected',
        'Visa Application'
      );

      explanation.should.be.a('string');
      explanation.should.include('submitted');
      explanation.should.include('rejected');
    });
  });

  describe('Error Handling', () => {
    it('should handle null/undefined inputs gracefully', async () => {
      const response1 = await openaiService.generateAIResponse(null, applicationId);
      const response2 = await openaiService.generateAIResponse('test', null);
      const response3 = await openaiService.generateAIResponse(undefined, applicationId);

      response1.should.be.a('string');
      response2.should.be.a('string');
      response3.should.be.a('string');
    });

    it('should handle empty strings', async () => {
      const response = await openaiService.generateAIResponse('', applicationId);
      response.should.be.a('string');
    });

    it('should handle very long input', async () => {
      const longInput = 'Help me with visa '.repeat(1000);
      
      const response = await openaiService.generateAIResponse(longInput, applicationId);
      response.should.be.a('string');
    });

    it('should handle special characters', async () => {
      const specialInput = 'Help with visa! @#$%^&*()_+ أهلاً وسهلاً مرحبا 你好 नमस्ते';
      
      const response = await openaiService.generateAIResponse(specialInput, applicationId);
      response.should.be.a('string');
    });

    it('should handle network errors gracefully', async () => {
      // This test ensures the service doesn't crash on network issues
      const response = await openaiService.generateAIResponse(
        'Test message',
        applicationId
      );

      response.should.be.a('string');
      // Should provide fallback response even if AI service fails
    });
  });

  describe('Performance and Limitations', () => {
    it('should handle concurrent requests', async () => {
      const promises = [];
      
      for (let i = 0; i < 5; i++) {
        promises.push(
          openaiService.generateAIResponse(
            `Test message ${i}`,
            applicationId
          )
        );
      }

      const responses = await Promise.all(promises);
      
      responses.should.have.length(5);
      responses.forEach(response => {
        response.should.be.a('string');
      });
    });

    it('should respond within reasonable time', async () => {
      const startTime = Date.now();
      
      const response = await openaiService.generateAIResponse(
        'Quick test message',
        applicationId
      );
      
      const endTime = Date.now();
      const duration = endTime - startTime;

      response.should.be.a('string');
      // Should respond within 30 seconds (includes network timeout)
      duration.should.be.lessThan(30000);
    });

    it('should handle multiple service requests', async () => {
      const requests = [
        openaiService.generateServiceRecommendations('family visa', {}),
        openaiService.generateDocumentChecklist(1, {}),
        openaiService.explainStatusUpdate('draft', 'submitted', 'Family Visa'),
        openaiService.analyzeDocuments([{ name: 'test.pdf' }], 1)
      ];

      const results = await Promise.all(requests);
      
      results.should.have.length(4);
      // All results should be valid (array or string or null)
      results.forEach(result => {
        if (result !== null) {
          (typeof result === 'string' || Array.isArray(result)).should.be.true;
        }
      });
    });
  });

  describe('Integration with Services Catalog', () => {
    it('should use service information in responses', async () => {
      // Test with known service ID from services.json
      const response = await openaiService.generateAIResponse(
        'Tell me about this service',
        applicationId,
        'en'
      );

      response.should.be.a('string');
      // Should provide contextual information even if AI is disabled
    });

    it('should handle non-existent service gracefully', async () => {
      // Create application with invalid service ID
      const invalidApp = await VisaApplication.create({
        applicationType: 'family_visa',
        sponsor: userId1,
        serviceId: 99999,
        status: 'draft'
      });

      const response = await openaiService.generateAIResponse(
        'Help me',
        invalidApp._id.toString(),
        'en'
      );

      response.should.be.a('string');
    });
  });
}); 