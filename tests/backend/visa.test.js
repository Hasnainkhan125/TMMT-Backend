const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const app = require('../../index');
const db = require('../../db/config');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');

let mongoServer;

function authToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET || 'secret_key');
}

describe('Visa Applications API', function () {
  this.timeout(20000);
  let sponsorId;

  before(async () => {
    mongoServer = await MongoMemoryServer.create();
    const uri = mongoServer.getUri();
    await db(uri, 'qumak_test');
    sponsorId = new mongoose.Types.ObjectId().toString();
  });

  after(async () => {
    await mongoose.disconnect();
    if (mongoServer) await mongoServer.stop();
  });

  it('should create an application as sponsor', async () => {
    const token = authToken({ userId: sponsorId, role: 'sponsor' });
    const res = await request(app)
      .post('/api/v1/visa/applications')
      .set('Authorization', `Bearer ${token}`)
      .send({ applicationType: 'family_visa' })
      .expect(201);
    if (!res.body.application || res.body.application.status !== 'draft') throw new Error('Application not created');
  });

  it('should list applications for sponsor', async () => {
    const token = authToken({ userId: sponsorId, role: 'sponsor' });
    const res = await request(app)
      .get('/api/v1/visa/applications')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    if (!Array.isArray(res.body.applications)) throw new Error('Applications not listed');
  });

  it('should upload documents to an application', async () => {
    const token = authToken({ userId: sponsorId, role: 'sponsor' });
    const createRes = await request(app)
      .post('/api/v1/visa/applications')
      .set('Authorization', `Bearer ${token}`)
      .send({ applicationType: 'residence_visa' })
      .expect(201);
    const appId = createRes.body.application._id;

    const tmpFile = path.join(__dirname, 'tmp.txt');
    fs.writeFileSync(tmpFile, 'test');

    const uploadRes = await request(app)
      .post(`/api/v1/visa/applications/${appId}/upload`)
      .set('Authorization', `Bearer ${token}`)
      .attach('files', tmpFile)
      .expect(200);

    fs.unlinkSync(tmpFile);

    if (!uploadRes.body.application || uploadRes.body.application.attachments.length === 0) throw new Error('Upload failed');
  });
}); 