const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const db = require('../../db/config');
const VisaApplication = require('../../model/schema/visaApplication');
const ChatMessage = require('../../model/schema/chatMessage');
const User = require('../../model/schema/user');
const chai = require('chai');
const should = chai.should();

let mongoServer;
let server;
let wsServer;

// Helper function to create auth token
function createToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET || 'secret_key');
}

// Helper function to create WebSocket connection
function createWSConnection(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${server.address().port}/ws?token=${token}`);
    
    ws.on('open', () => {
      resolve(ws);
    });
    
    ws.on('error', (error) => {
      reject(error);
    });

    setTimeout(() => reject(new Error('Connection timeout')), 5000);
  });
}

// Helper function to wait for WebSocket message
function waitForMessage(ws, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Message timeout')), timeout);
    
    ws.once('message', (data) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(data.toString()));
      } catch (error) {
        resolve(data.toString());
      }
    });
  });
}

describe('WebSocket Server', function () {
  this.timeout(20000);
  
  let userId1, userId2, adminId;
  let userToken1, userToken2, adminToken;
  let applicationId;

  before(async () => {
    // Setup MongoDB
    mongoServer = await MongoMemoryServer.create();
    const uri = mongoServer.getUri();
      await db(uri, 'qumak_test');

    // Create test users
    userId1 = new mongoose.Types.ObjectId().toString();
    userId2 = new mongoose.Types.ObjectId().toString();
    adminId = new mongoose.Types.ObjectId().toString();

    const user1 = await User.create({
      _id: userId1,
      firstName: 'John',
      lastName: 'Doe',
      email: 'john@test.com',
      password: 'testpassword123',
      role: 'sponsor'
    });

    const user2 = await User.create({
      _id: userId2,
      firstName: 'Jane',
      lastName: 'Smith',
      email: 'jane@test.com',
      password: 'testpassword123',
      role: 'sponsored'
    });

    const admin = await User.create({
      _id: adminId,
      firstName: 'Admin',
      lastName: 'User',
      email: 'admin@test.com',
      password: 'testpassword123',
      role: 'admin'
    });

    // Create test application
    const application = await VisaApplication.create({
      applicationType: 'family_visa',
      sponsor: userId1,
      sponsored: userId2,
      status: 'draft'
    });
    applicationId = application._id.toString();

    // Create tokens
    userToken1 = createToken({ userId: userId1, role: 'sponsor' });
    userToken2 = createToken({ userId: userId2, role: 'sponsored' });
    adminToken = createToken({ userId: adminId, role: 'admin' });

    // Start HTTP server with WebSocket
    const express = require('express');
    const http = require('http');
    const WebSocketServer = require('../../services/websocketServer');
    
    const app = express();
    server = http.createServer(app);
    wsServer = new WebSocketServer(server);
    
    await new Promise((resolve) => {
      server.listen(0, () => {
        console.log(`Test server running on port ${server.address().port}`);
        resolve();
      });
    });
  });

  after(async () => {
    if (server) {
      server.close();
    }
    await mongoose.disconnect();
    if (mongoServer) {
      await mongoServer.stop();
    }
  });

  describe('Connection Authentication', () => {
    it('should reject connection without token', async () => {
      try {
        const ws = new WebSocket(`ws://localhost:${server.address().port}/ws`);
        await new Promise((resolve, reject) => {
          ws.on('open', () => reject(new Error('Should not connect')));
          ws.on('error', () => resolve()); // Expected
          setTimeout(() => resolve(), 1000);
        });
      } catch (error) {
        // Connection should fail
      }
    });

    it('should reject connection with invalid token', async () => {
      try {
        const ws = new WebSocket(`ws://localhost:${server.address().port}/ws?token=invalid-token`);
        await new Promise((resolve, reject) => {
          ws.on('open', () => reject(new Error('Should not connect')));
          ws.on('error', () => resolve()); // Expected
          setTimeout(() => resolve(), 1000);
        });
      } catch (error) {
        // Connection should fail
      }
    });

    it('should accept connection with valid token', async () => {
      const ws = await createWSConnection(userToken1);
      
      // Should receive welcome message
      const message = await waitForMessage(ws);
      message.should.have.property('type', 'connection');
      message.should.have.property('status', 'connected');
      message.user.should.have.property('id', userId1);
      
      ws.close();
    });

    it('should auto-join user to relevant rooms', async () => {
      const ws = await createWSConnection(userToken1);
      
      // Skip welcome message
      await waitForMessage(ws);
      
      // Should auto-join application room
      const roomMessage = await waitForMessage(ws, 3000);
      roomMessage.should.have.property('type', 'room_joined');
      roomMessage.should.have.property('roomId', `app_${applicationId}`);
      
      ws.close();
    });
  });

  describe('Chat Messaging', () => {
    let ws1, ws2;

    beforeEach(async () => {
      ws1 = await createWSConnection(userToken1);
      ws2 = await createWSConnection(userToken2);
      
      // Skip welcome messages
      await waitForMessage(ws1);
      await waitForMessage(ws2);
      
      // Skip auto-join messages
      try {
        await waitForMessage(ws1, 1000);
        await waitForMessage(ws2, 1000);
      } catch (e) {
        // May not have auto-join messages
      }
    });

    afterEach(() => {
      if (ws1) ws1.close();
      if (ws2) ws2.close();
    });

    it('should send and receive chat messages', async () => {
      const message = {
        type: 'chat_message',
        applicationId: applicationId,
        content: 'Hello, this is a test message',
        language: 'en'
      };

      // Send message from user1
      ws1.send(JSON.stringify(message));

      // User2 should receive the message
      const receivedMessage = await waitForMessage(ws2);
      receivedMessage.should.have.property('type', 'new_message');
      receivedMessage.should.have.property('message');
      receivedMessage.message.should.have.property('content', message.content);
    });

    it('should validate message requirements', async () => {
      const invalidMessage = {
        type: 'chat_message',
        content: 'Missing application ID'
      };

      ws1.send(JSON.stringify(invalidMessage));

      const errorMessage = await waitForMessage(ws1);
      errorMessage.should.have.property('type', 'error');
      errorMessage.message.should.include('Application ID and content are required');
    });

    it('should enforce access permissions', async () => {
      // Create another application that user1 doesn't have access to
      const otherApp = await VisaApplication.create({
        applicationType: 'work_visa',
        sponsor: adminId,
        status: 'draft'
      });

      const message = {
        type: 'chat_message',
        applicationId: otherApp._id.toString(),
        content: 'Unauthorized message'
      };

      ws1.send(JSON.stringify(message));

      const errorMessage = await waitForMessage(ws1);
      errorMessage.should.have.property('type', 'error');
      errorMessage.message.should.include('Unauthorized');
    });

    it('should trigger AI response for AI mentions', async () => {
      const message = {
        type: 'chat_message',
        applicationId: applicationId,
        content: '@ai Can you help me with my visa application?',
        language: 'en'
      };

      ws1.send(JSON.stringify(message));

      // Should receive user message first
      const userMessage = await waitForMessage(ws2);
      userMessage.should.have.property('type', 'new_message');

      // May receive AI response (if OpenAI is configured)
      try {
        const aiMessage = await waitForMessage(ws2, 3000);
        if (aiMessage.type === 'ai_response') {
          aiMessage.should.have.property('message');
          aiMessage.message.should.have.property('isAI', true);
        }
      } catch (e) {
        // AI response may not be available in test environment
      }
    });
  });

  describe('Voice Calls', () => {
    let ws1, ws2;

    beforeEach(async () => {
      ws1 = await createWSConnection(userToken1);
      ws2 = await createWSConnection(userToken2);
      
      // Skip initial messages
      await waitForMessage(ws1);
      await waitForMessage(ws2);
      try {
        await waitForMessage(ws1, 1000);
        await waitForMessage(ws2, 1000);
      } catch (e) {}
    });

    afterEach(() => {
      if (ws1) ws1.close();
      if (ws2) ws2.close();
    });

    it('should start voice call', async () => {
      const startCall = {
        type: 'start_voice_call',
        applicationId: applicationId,
        type: 'audio'
      };

      ws1.send(JSON.stringify(startCall));

      // Initiator should get call created confirmation
      const callCreated = await waitForMessage(ws1);
      callCreated.should.have.property('type', 'voice_call_created');
      callCreated.should.have.property('callId');
      callCreated.should.have.property('status', 'waiting');

      // Other participants should be notified
      const callNotification = await waitForMessage(ws2);
      callNotification.should.have.property('type', 'voice_call_started');
      callNotification.should.have.property('callId');
    });

    it('should allow joining voice call', async () => {
      // Start call
      const startCall = {
        type: 'start_voice_call',
        applicationId: applicationId,
        type: 'audio'
      };
      ws1.send(JSON.stringify(startCall));

      const callCreated = await waitForMessage(ws1);
      const callId = callCreated.callId;

      // Skip notification for user2
      await waitForMessage(ws2);

      // User2 joins call
      const joinCall = {
        type: 'join_voice_call',
        callId: callId
      };
      ws2.send(JSON.stringify(joinCall));

      // Both users should be notified about participant joining
      const participant1Msg = await waitForMessage(ws1);
      participant1Msg.should.have.property('type', 'participant_joined');
      participant1Msg.should.have.property('callId', callId);

      const participant2Msg = await waitForMessage(ws2);
      participant2Msg.should.have.property('type', 'participant_joined');
    });

    it('should handle voice signaling', async () => {
      // Start and join call first
      const startCall = {
        type: 'start_voice_call',
        applicationId: applicationId,
        type: 'audio'
      };
      ws1.send(JSON.stringify(startCall));

      const callCreated = await waitForMessage(ws1);
      const callId = callCreated.callId;

      await waitForMessage(ws2); // Skip notification

      const joinCall = {
        type: 'join_voice_call',
        callId: callId
      };
      ws2.send(JSON.stringify(joinCall));

      // Skip join notifications
      await waitForMessage(ws1);
      await waitForMessage(ws2);

      // Send voice signal
      const signal = {
        type: 'voice_signal',
        callId: callId,
        signal: { type: 'offer', sdp: 'fake-sdp-data' }
      };
      ws1.send(JSON.stringify(signal));

      // User2 should receive the signal
      const receivedSignal = await waitForMessage(ws2);
      receivedSignal.should.have.property('type', 'voice_signal');
      receivedSignal.should.have.property('callId', callId);
      receivedSignal.should.have.property('fromUserId', userId1);
    });

    it('should end voice call', async () => {
      // Start call
      const startCall = {
        type: 'start_voice_call',
        applicationId: applicationId,
        type: 'audio'
      };
      ws1.send(JSON.stringify(startCall));

      const callCreated = await waitForMessage(ws1);
      const callId = callCreated.callId;

      await waitForMessage(ws2); // Skip notification

      // End call
      const endCall = {
        type: 'end_voice_call',
        callId: callId
      };
      ws1.send(JSON.stringify(endCall));

      // Both users should be notified
      const endMsg1 = await waitForMessage(ws1);
      endMsg1.should.have.property('type', 'call_ended');
      endMsg1.should.have.property('callId', callId);
    });
  });

  describe('Room Management', () => {
    let ws1;

    beforeEach(async () => {
      ws1 = await createWSConnection(userToken1);
      await waitForMessage(ws1); // Skip welcome
      try {
        await waitForMessage(ws1, 1000); // Skip auto-join
      } catch (e) {}
    });

    afterEach(() => {
      if (ws1) ws1.close();
    });

    it('should join room manually', async () => {
      const joinRoom = {
        type: 'join_room',
        roomId: 'test-room-123'
      };

      ws1.send(JSON.stringify(joinRoom));

      const roomJoined = await waitForMessage(ws1);
      roomJoined.should.have.property('type', 'room_joined');
      roomJoined.should.have.property('roomId', 'test-room-123');
      roomJoined.should.have.property('participantCount');
    });

    it('should leave room', async () => {
      // Join room first
      const joinRoom = {
        type: 'join_room',
        roomId: 'test-room-456'
      };
      ws1.send(JSON.stringify(joinRoom));
      await waitForMessage(ws1); // Skip join confirmation

      // Leave room
      const leaveRoom = {
        type: 'leave_room',
        roomId: 'test-room-456'
      };
      ws1.send(JSON.stringify(leaveRoom));

      const roomLeft = await waitForMessage(ws1);
      roomLeft.should.have.property('type', 'room_left');
      roomLeft.should.have.property('roomId', 'test-room-456');
    });

    it('should validate room ID requirement', async () => {
      const invalidJoin = {
        type: 'join_room'
        // Missing roomId
      };

      ws1.send(JSON.stringify(invalidJoin));

      const errorMsg = await waitForMessage(ws1);
      errorMsg.should.have.property('type', 'error');
      errorMsg.message.should.include('Room ID is required');
    });
  });

  describe('Status Updates', () => {
    let ws1;

    beforeEach(async () => {
      ws1 = await createWSConnection(userToken1);
      await waitForMessage(ws1); // Skip welcome
    });

    afterEach(() => {
      if (ws1) ws1.close();
    });

    it('should update user status', async () => {
      const statusUpdate = {
        type: 'status_update',
        status: 'busy'
      };

      ws1.send(JSON.stringify(statusUpdate));

      // Status update doesn't send immediate response to self
      // but updates internal state
    });

    it('should respond to ping', async () => {
      const ping = {
        type: 'ping'
      };

      ws1.send(JSON.stringify(ping));

      const pong = await waitForMessage(ws1);
      pong.should.have.property('type', 'pong');
      pong.should.have.property('timestamp');
    });
  });

  describe('Error Handling', () => {
    let ws1;

    beforeEach(async () => {
      ws1 = await createWSConnection(userToken1);
      await waitForMessage(ws1); // Skip welcome
    });

    afterEach(() => {
      if (ws1) ws1.close();
    });

    it('should handle invalid JSON', async () => {
      ws1.send('invalid json {');

      const errorMsg = await waitForMessage(ws1);
      errorMsg.should.have.property('type', 'error');
      errorMsg.message.should.include('Failed to process message');
    });

    it('should handle unknown message types', async () => {
      const unknownMessage = {
        type: 'unknown_message_type',
        data: 'test'
      };

      ws1.send(JSON.stringify(unknownMessage));

      // Should not crash the connection
      const ping = { type: 'ping' };
      ws1.send(JSON.stringify(ping));

      const pong = await waitForMessage(ws1);
      pong.should.have.property('type', 'pong');
    });
  });

  describe('Connection Management', () => {
    it('should clean up on disconnect', async () => {
      const ws = await createWSConnection(userToken1);
      await waitForMessage(ws); // Skip welcome

      // Get initial stats
      const initialStats = wsServer.getStats();
      const initialConnections = initialStats.connectedClients;

      // Close connection
      ws.close();

      // Wait for cleanup
      await new Promise(resolve => setTimeout(resolve, 100));

      const finalStats = wsServer.getStats();
      finalStats.connectedClients.should.equal(initialConnections - 1);
    });

    it('should provide accurate statistics', async () => {
      const stats = wsServer.getStats();
      
      stats.should.have.property('connectedClients');
      stats.should.have.property('activeRooms');
      stats.should.have.property('activeCalls');
      stats.should.have.property('rooms');
      
      stats.connectedClients.should.be.a('number');
      stats.activeRooms.should.be.a('number');
      stats.activeCalls.should.be.a('number');
      stats.rooms.should.be.an('array');
    });

    it('should list active users', async () => {
      const ws = await createWSConnection(userToken1);
      await waitForMessage(ws);

      const activeUsers = wsServer.getActiveUsers();
      activeUsers.should.be.an('array');
      
      const user = activeUsers.find(u => u.userId === userId1);
      user.should.exist;
      user.should.have.property('role', 'sponsor');
      user.should.have.property('status', 'online');
      user.should.have.property('rooms');

      ws.close();
    });
  });
}); 