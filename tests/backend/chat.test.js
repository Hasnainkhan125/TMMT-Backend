const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const app = require('../../index');
const db = require('../../db/config');
const jwt = require('jsonwebtoken');

let mongoServer;

function authToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET || 'secret_key');
}

describe('Chat API', function () {
  this.timeout(20000);
  let userId;
  let applicationId = new mongoose.Types.ObjectId().toString();

  before(async () => {
    mongoServer = await MongoMemoryServer.create();
    const uri = mongoServer.getUri();
    await db(uri, 'qumak_test');
    userId = new mongoose.Types.ObjectId().toString();
  });

  after(async () => {
    await mongoose.disconnect();
    if (mongoServer) await mongoServer.stop();
  });

  it('should send a chat message with service context', async () => {
    const token = authToken({ userId, role: 'sponsor' });
    const list = await request(app).get('/api/services/services').expect(200);
    const any = list.body.services[0];
    const res = await request(app)
      .post(`/api/v1/chat/applications/${applicationId}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send({ content: 'What documents are needed?', serviceId: any.id })
      .expect(201);
    if (!res.body.message || !res.body.message.content) throw new Error('Message not saved');
  });
}); 