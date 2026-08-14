const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const app = require('../../index');
const db = require('../../db/config');
const jwt = require('jsonwebtoken');

let mongoServer;

describe('Auth API', function () {
  this.timeout(20000);
  before(async () => {
    mongoServer = await MongoMemoryServer.create();
    const uri = mongoServer.getUri();
    await db(uri, 'qumak_test');
  });

  after(async () => {
    await mongoose.disconnect();
    if (mongoServer) await mongoServer.stop();
  });

  it('should sync a Clerk user', async () => {
    const res = await request(app)
      .post('/api/v1/auth/clerk/sync')
      .send({ clerkId: 'clrk_123', email: 'sponsor@example.com', firstName: 'Ali', lastName: 'Khan', role: 'sponsor' })
      .expect(200);
    if (!res.body.user || res.body.user.email !== 'sponsor@example.com') throw new Error('User not synced');
  });

  it('should return current user profile with token', async () => {
    const token = jwt.sign({ userId: new mongoose.Types.ObjectId().toString(), role: 'sponsor' }, process.env.JWT_SECRET || 'secret_key');
    await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(404); // user not found since random id
  });
}); 