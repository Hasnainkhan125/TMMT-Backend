const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const app = require('../../index');
const db = require('../../db/config');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const chai = require('chai');
const should = chai.should();

let mongoServer;

function authToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET || 'secret_key');
}

describe('Services API', function () {
  this.timeout(30000);
  let adminToken, amerToken, userToken;

  before(async () => {
    mongoServer = await MongoMemoryServer.create();
    const uri = mongoServer.getUri();
    await db(uri, 'qumak_test');

    // Create auth tokens
    adminToken = authToken({ userId: 'admin1', role: 'admin' });
    amerToken = authToken({ userId: 'amer1', role: 'amer' });
    userToken = authToken({ userId: 'user1', role: 'sponsor' });
  });

  after(async () => {
    await mongoose.disconnect();
    if (mongoServer) await mongoServer.stop();
  });

  describe('GET /api/services/categories', () => {
    it('should list all categories', async () => {
      const res = await request(app)
        .get('/api/services/categories')
        .expect(200);

      res.body.should.have.property('success', true);
      res.body.should.have.property('data');
      res.body.data.should.have.property('categories');
      res.body.data.categories.should.be.an('array');
      
      if (res.body.data.categories.length > 0) {
        const category = res.body.data.categories[0];
        category.should.have.property('slug');
        category.should.have.property('name');
        category.should.have.property('position');
      }
    });
  });

  describe('GET /api/services/subcategories', () => {
    it('should list subcategories for a category', async () => {
      const res = await request(app)
        .get('/api/services/subcategories')
        .query({ category: 'immigration' })
        .expect(200);

      res.body.should.have.property('success', true);
      res.body.should.have.property('data');
      res.body.data.should.have.property('subcategories');
      res.body.data.subcategories.should.be.an('array');
    });

    it('should list all subcategories when no category specified', async () => {
      const res = await request(app)
        .get('/api/services/subcategories')
        .expect(200);

      res.body.should.have.property('success', true);
      res.body.data.subcategories.should.be.an('array');
    });
  });

  describe('GET /api/services/services', () => {
    it('should require subcategory parameter', async () => {
      const res = await request(app)
        .get('/api/services/services')
        .expect(400);

      res.body.should.have.property('success', false);
      res.body.message.should.include('Subcategory parameter is required');
    });

    it('should list services for a subcategory', async () => {
      const res = await request(app)
        .get('/api/services/services')
        .query({ subcategory: 'NEP', category: 'immigration' })
        .expect(200);

      res.body.should.have.property('success', true);
      res.body.should.have.property('data');
      res.body.data.should.have.property('services');
      res.body.data.should.have.property('pagination');
      res.body.data.services.should.be.an('array');
    });

    it('should support pagination', async () => {
      const res = await request(app)
        .get('/api/services/services')
        .query({ subcategory: 'NEP', limit: 2, offset: 0 })
        .expect(200);

      res.body.data.pagination.should.have.property('limit', 2);
      res.body.data.pagination.should.have.property('offset', 0);
      res.body.data.pagination.should.have.property('total');
      res.body.data.pagination.should.have.property('hasMore');
    });
  });

  describe('GET /api/services/services/:id', () => {
    it('should return service by ID', async () => {
      const res = await request(app)
        .get('/api/services/services/1')
        .expect(200);

      res.body.should.have.property('success', true);
      res.body.should.have.property('data');
      res.body.data.should.have.property('service');
      
      const service = res.body.data.service;
      service.should.have.property('id');
      service.should.have.property('name');
      service.should.have.property('prices');
      service.should.have.property('requiredDocuments');
    });

    it('should return 404 for non-existent service', async () => {
      const res = await request(app)
        .get('/api/services/services/99999')
        .expect(404);

      res.body.should.have.property('success', false);
      res.body.message.should.include('Service not found');
    });
  });

  describe('GET /api/services/search', () => {
    it('should require minimum query length', async () => {
      const res = await request(app)
        .get('/api/services/search')
        .query({ q: 'ab' })
        .expect(400);

      res.body.should.have.property('success', false);
      res.body.message.should.include('at least 3 characters');
    });

    it('should search services successfully', async () => {
      const res = await request(app)
        .get('/api/services/search')
        .query({ q: 'visa', limit: 5 })
        .expect(200);

      res.body.should.have.property('success', true);
      res.body.should.have.property('data');
      res.body.data.should.have.property('services');
      res.body.data.should.have.property('query', 'visa');
      res.body.data.should.have.property('total');
      res.body.data.services.should.be.an('array');
    });

    it('should limit search results', async () => {
      const res = await request(app)
        .get('/api/services/search')
        .query({ q: 'residence', limit: 3 })
        .expect(200);

      res.body.data.services.length.should.be.at.most(3);
    });
  });

  describe('GET /api/services/stats', () => {
    it('should return catalog statistics', async () => {
      const res = await request(app)
        .get('/api/services/stats')
        .expect(200);

      res.body.should.have.property('success', true);
      res.body.should.have.property('data');
      res.body.data.should.have.property('stats');
      
      const stats = res.body.data.stats;
      stats.should.have.property('totalCategories');
      stats.should.have.property('totalSubcategories');
      stats.should.have.property('totalServices');
      stats.should.have.property('lastUpdated');
    });
  });

  describe('POST /api/services/services', () => {
    it('should require authentication', async () => {
      const res = await request(app)
        .post('/api/services/services')
        .send({ serviceName: 'Test Service' })
        .expect(401);

      res.body.message.should.include('Authentication failed');
    });

    it('should require admin or amer role', async () => {
      const res = await request(app)
        .post('/api/services/services')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ serviceName: 'Test Service' })
        .expect(403);

      res.body.message.should.include('Insufficient permissions');
    });

    it('should require category and subcategory slugs', async () => {
      const res = await request(app)
        .post('/api/services/services')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ serviceName: 'Test Service' })
        .expect(400);

      res.body.message.should.include('Category and subcategory slugs are required');
    });

    it('should require mandatory fields', async () => {
      const res = await request(app)
        .post('/api/services/services')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ categorySlug: 'immigration', subcategorySlug: 'NEP' })
        .send({ incompleteData: true })
        .expect(400);

      res.body.message.should.include('Missing required fields');
    });

    it('should create service successfully (admin)', async () => {
      const serviceData = {
        serviceName: 'Test Service Creation',
        outsideDescription: 'This is a test service for automated testing',
        insideDescription: 'Detailed description for testing',
        prices: [
          { PriceType: 'Normal', PriceAmount: 500, PriceCurrency: 'AED' }
        ],
        FormDescription: '<ul><li>Test Document 1</li><li>Test Document 2</li></ul>'
      };

      const res = await request(app)
        .post('/api/services/services')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ categorySlug: 'immigration', subcategorySlug: 'NEP' })
        .send(serviceData)
        .expect(201);

      res.body.should.have.property('success', true);
      res.body.should.have.property('data');
      res.body.data.should.have.property('service');
      
      const service = res.body.data.service;
      service.should.have.property('serviceName', serviceData.serviceName);
      service.should.have.property('Recordid');
    });

    it('should create service successfully (amer)', async () => {
      const serviceData = {
        serviceName: 'Amer Test Service',
        outsideDescription: 'Service created by Amer professional',
        prices: [{ PriceType: 'Normal', PriceAmount: 300, PriceCurrency: 'AED' }]
      };

      const res = await request(app)
        .post('/api/services/services')
        .set('Authorization', `Bearer ${amerToken}`)
        .query({ categorySlug: 'immigration', subcategorySlug: 'VS' })
        .send(serviceData)
        .expect(201);

      res.body.should.have.property('success', true);
    });
  });

  describe('PUT /api/services/services/:id', () => {
    it('should require authentication', async () => {
      const res = await request(app)
        .put('/api/services/services/1')
        .send({ serviceName: 'Updated Name' })
        .expect(401);
    });

    it('should require admin or amer role', async () => {
      const res = await request(app)
        .put('/api/services/services/1')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ serviceName: 'Updated Name' })
        .expect(403);
    });

    it('should update existing service', async () => {
      const updateData = {
        serviceName: 'Updated Test Service',
        outsideDescription: 'Updated description for testing'
      };

      const res = await request(app)
        .put('/api/services/services/1')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(updateData)
        .expect(200);

      res.body.should.have.property('success', true);
      res.body.data.service.should.have.property('serviceName', updateData.serviceName);
    });

    it('should return 404 for non-existent service', async () => {
      const res = await request(app)
        .put('/api/services/services/99999')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ serviceName: 'Non-existent' })
        .expect(404);

      res.body.message.should.include('Service not found');
    });
  });

  describe('DELETE /api/services/services/:id', () => {
    it('should require authentication', async () => {
      const res = await request(app)
        .delete('/api/services/services/1')
        .expect(401);
    });

    it('should require admin role only', async () => {
      const res = await request(app)
        .delete('/api/services/services/1')
        .set('Authorization', `Bearer ${amerToken}`)
        .expect(403);
    });

    it('should delete service successfully', async () => {
      const res = await request(app)
        .delete('/api/services/services/1')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      res.body.should.have.property('success', true);
      res.body.message.should.include('deleted successfully');
    });

    it('should return 404 for non-existent service', async () => {
      const res = await request(app)
        .delete('/api/services/services/99999')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(404);
    });
  });

  describe('POST /api/services/reload', () => {
    it('should require admin role', async () => {
      const res = await request(app)
        .post('/api/services/reload')
        .set('Authorization', `Bearer ${amerToken}`)
        .expect(403);
    });

    it('should reload services successfully', async () => {
      const res = await request(app)
        .post('/api/services/reload')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      res.body.should.have.property('success', true);
      res.body.message.should.include('reloaded successfully');
      res.body.data.should.have.property('stats');
    });
  });

  describe('POST /api/services/backup', () => {
    it('should require admin role', async () => {
      const res = await request(app)
        .post('/api/services/backup')
        .set('Authorization', `Bearer ${userToken}`)
        .expect(403);
    });

    it('should create backup successfully', async () => {
      const res = await request(app)
        .post('/api/services/backup')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      res.body.should.have.property('success', true);
      res.body.message.should.include('Backup created successfully');
      res.body.data.should.have.property('backupFile');
      res.body.data.should.have.property('timestamp');

      // Verify backup file exists
      const backupPath = path.join(process.cwd(), 'backups', res.body.data.backupFile);
      fs.existsSync(backupPath).should.be.true;
    });
  });

  describe('POST /api/services/restore', () => {
    it('should require admin role', async () => {
      const res = await request(app)
        .post('/api/services/restore')
        .set('Authorization', `Bearer ${amerToken}`)
        .send({ backupFile: 'test-backup.json' })
        .expect(403);
    });

    it('should require backup file parameter', async () => {
      const res = await request(app)
        .post('/api/services/restore')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({})
        .expect(400);

      res.body.message.should.include('Backup file name is required');
    });

    it('should return 404 for non-existent backup', async () => {
      const res = await request(app)
        .post('/api/services/restore')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ backupFile: 'non-existent-backup.json' })
        .expect(404);

      res.body.message.should.include('Backup file not found');
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid service data gracefully', async () => {
      const invalidData = {
        serviceName: '', // Empty name
        outsideDescription: 'Valid description'
      };

      const res = await request(app)
        .post('/api/services/services')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ categorySlug: 'immigration', subcategorySlug: 'NEP' })
        .send(invalidData)
        .expect(400);

      res.body.should.have.property('success', false);
    });

    it('should handle invalid category/subcategory', async () => {
      const serviceData = {
        serviceName: 'Test Service',
        outsideDescription: 'Test description'
      };

      const res = await request(app)
        .post('/api/services/services')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ categorySlug: 'invalid-category', subcategorySlug: 'invalid-subcategory' })
        .send(serviceData)
        .expect(500);

      res.body.should.have.property('success', false);
    });
  });

  describe('Response Format Validation', () => {
    it('should follow standardized response format', async () => {
      const res = await request(app)
        .get('/api/services/categories')
        .expect(200);

      // Check response structure
      res.body.should.have.property('success');
      res.body.should.have.property('message');
      res.body.should.have.property('data');
      res.body.should.have.property('meta');
      
      res.body.meta.should.have.property('timestamp');
      res.body.meta.should.have.property('requestId');
    });

    it('should include proper error format', async () => {
      const res = await request(app)
        .get('/api/services/services/99999')
        .expect(404);

      res.body.should.have.property('success', false);
      res.body.should.have.property('message');
      res.body.should.have.property('data', null);
      res.body.should.have.property('meta');
    });
  });
}); 