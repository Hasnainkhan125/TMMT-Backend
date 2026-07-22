const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const ChatMessage = require('../model/schema/chatMessage');
const VisaApplication = require('../model/schema/visaApplication');
const User = require('../model/schema/user');

// Enhanced WebSocket Server with enterprise features
class WebSocketServer {
  constructor(server) {
    this.wss = new WebSocket.Server({ 
      server,
      path: '/ws',
      verifyClient: this.verifyClient.bind(this),
      clientTracking: true,
      perMessageDeflate: {
        zlibDeflateOptions: {
          chunkSize: 1024,
          memLevel: 7,
          level: 3
        },
        zlibInflateOptions: {
          chunkSize: 10 * 1024
        },
        clientNoContextTakeover: true,
        serverNoContextTakeover: true,
        serverMaxWindowBits: 10,
        concurrencyLimit: 10,
        threshold: 1024
      }
    });
    
    // Enhanced client management
    this.clients = new Map(); // userId -> { ws, user, rooms, metrics, limits }
    this.rooms = new Map(); // roomId -> { clients, type, metadata, metrics }
    this.voiceCalls = new Map(); // callId -> { participants, status, metadata }
    
    // Performance monitoring
    this.metrics = {
      totalConnections: 0,
      activeConnections: 0,
      totalMessages: 0,
      totalErrors: 0,
      startTime: new Date(),
      peakConnections: 0
    };
    
    // Rate limiting configuration
    this.rateLimits = {
      messagesPerMinute: 60,
      connectionsPerMinute: 10,
      maxConnectionsPerUser: 3
    };
    
    // Connection tracking for rate limiting
    this.connectionAttempts = new Map(); // IP -> { count, resetTime }
    this.userConnections = new Map(); // userId -> connection count
    
    this.wss.on('connection', this.handleConnection.bind(this));
    
    // Start heartbeat monitoring
    this.startHeartbeat();
    
    console.log('🚀 Enhanced WebSocket server initialized with enterprise features');
  }

  // Enhanced client verification with rate limiting
  verifyClient(info) {
    try {
      const token = new URL(info.req.url, 'http://localhost').searchParams.get('token');
      if (!token) {
        console.log('WebSocket connection rejected: No token provided');
        return false;
      }

      // Rate limiting for connection attempts
      const clientIP = info.req.socket.remoteAddress;
      if (this.isRateLimited(clientIP, 'connection')) {
        console.log(`WebSocket connection rejected: Rate limited for IP ${clientIP}`);
        return false;
      }

      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        info.req.user = decoded;
        return true;
      } catch (error) {
        console.log('WebSocket connection rejected: Invalid token');
        return false;
      }
    } catch (error) {
      console.error('Error in WebSocket client verification:', error.message);
      return false;
    }
  }

  // Rate limiting implementation
  isRateLimited(identifier, type) {
    const now = Date.now();
    const key = `${type}:${identifier}`;
    
    if (!this.connectionAttempts.has(key)) {
      this.connectionAttempts.set(key, { count: 1, resetTime: now + 60000 });
      return false;
    }
    
    const attempt = this.connectionAttempts.get(key);
    if (now > attempt.resetTime) {
      attempt.count = 1;
      attempt.resetTime = now + 60000;
      return false;
    }
    
    if (attempt.count >= this.rateLimits.connectionsPerMinute) {
      return true;
    }
    
    attempt.count++;
    return false;
  }

  // Enhanced connection handling
  async handleConnection(ws, req) {
    try {
      const user = req.user;
      const userId = user.userId;
      
      // Check user connection limits
      if (this.userConnections.get(userId) >= this.rateLimits.maxConnectionsPerUser) {
        ws.close(1008, 'Maximum connections exceeded');
        return;
      }
      
      // Store enhanced client connection
      this.clients.set(userId, {
        ws,
        user,
        rooms: new Set(),
        lastSeen: new Date(),
        status: 'online',
        metrics: {
          messagesSent: 0,
          messagesReceived: 0,
          errors: 0,
          lastActivity: new Date()
        },
        limits: {
          messageCount: 0,
          lastMessageTime: Date.now()
        }
      });
      
      // Update connection counts
      this.userConnections.set(userId, (this.userConnections.get(userId) || 0) + 1);
      this.metrics.totalConnections++;
      this.metrics.activeConnections++;
      this.metrics.peakConnections = Math.max(this.metrics.peakConnections, this.metrics.activeConnections);

      console.log(`🔌 User ${userId} connected via WebSocket (${this.metrics.activeConnections} active)`);

      // Send enhanced welcome message
      this.sendToClient(userId, {
        type: 'connection',
        status: 'connected',
        user: { id: userId, role: user.role },
        server: {
          version: '2.0.0',
          features: ['chat', 'voice', 'rooms', 'ai', 'file_transfer'],
          limits: this.rateLimits
        }
      });

      // Set up enhanced message handlers
      ws.on('message', (data) => this.handleMessage(userId, data));
      ws.on('close', () => this.handleDisconnection(userId));
      ws.on('error', (error) => this.handleError(userId, error));
      ws.on('pong', () => this.handlePong(userId));

      // Auto-join user to their application rooms
      await this.autoJoinUserRooms(userId);

    } catch (error) {
      console.error('Error handling WebSocket connection:', error);
      ws.close(1011, 'Internal server error');
    }
  }

  // Enhanced message handling with rate limiting and validation
  async handleMessage(userId, data) {
    try {
      const client = this.clients.get(userId);
      if (!client) return;

      // Rate limiting for messages
      if (this.isMessageRateLimited(userId)) {
        this.sendToClient(userId, {
          type: 'error',
          message: 'Rate limit exceeded. Please wait before sending more messages.',
          code: 'RATE_LIMIT_EXCEEDED'
        });
        return;
      }

      // Update metrics
      client.metrics.messagesReceived++;
      client.metrics.lastActivity = new Date();
      client.limits.messageCount++;
      client.limits.lastMessageTime = Date.now();

      let message;
      try {
        message = JSON.parse(data);
      } catch (error) {
        this.sendToClient(userId, {
          type: 'error',
          message: 'Invalid JSON format',
          code: 'INVALID_JSON'
        });
        return;
      }

      // Message validation
      if (!message.type) {
        this.sendToClient(userId, {
          type: 'error',
          message: 'Message type is required',
          code: 'MISSING_TYPE'
        });
        return;
      }

      // Route message based on type
      switch (message.type) {
        case 'chat_message':
          await this.handleChatMessage(userId, message);
          break;
        case 'join_room':
          await this.handleJoinRoom(userId, message);
          break;
        case 'leave_room':
          await this.handleLeaveRoom(userId, message);
          break;
        case 'start_voice_call':
          await this.handleStartVoiceCall(userId, message);
          break;
        case 'join_voice_call':
          await this.handleJoinVoiceCall(userId, message);
          break;
        case 'end_voice_call':
          await this.handleEndVoiceCall(userId, message);
          break;
        case 'voice_signal':
          await this.handleVoiceSignal(userId, message);
          break;
        case 'status_update':
          await this.handleStatusUpdate(userId, message);
          break;
        case 'ping':
          this.handlePing(userId);
          break;
        case 'get_rooms':
          this.handleGetRooms(userId);
          break;
        case 'get_metrics':
          this.handleGetMetrics(userId);
          break;
        default:
          this.sendToClient(userId, {
            type: 'error',
            message: `Unknown message type: ${message.type}`,
            code: 'UNKNOWN_TYPE'
          });
      }

      this.metrics.totalMessages++;

    } catch (error) {
      console.error('Error handling WebSocket message:', error);
      this.handleError(userId, error);
    }
  }

  // Message rate limiting
  isMessageRateLimited(userId) {
    const client = this.clients.get(userId);
    if (!client) return true;

    const now = Date.now();
    const timeWindow = 60000; // 1 minute
    
    if (now - client.limits.lastMessageTime > timeWindow) {
      client.limits.messageCount = 1;
      client.limits.lastMessageTime = now;
      return false;
    }
    
    if (client.limits.messageCount >= this.rateLimits.messagesPerMinute) {
      return true;
    }
    
    client.limits.messageCount++;
    return false;
  }

  // Enhanced chat message handling
  async handleChatMessage(userId, message) {
    try {
      const { applicationId, content, language = 'en' } = message;
      
      if (!applicationId || !content) {
        this.sendToClient(userId, {
          type: 'error',
          message: 'Application ID and content are required',
          code: 'MISSING_FIELDS'
        });
        return;
      }

      // Validate application access
      const application = await VisaApplication.findById(applicationId);
      if (!application) {
        this.sendToClient(userId, {
          type: 'error',
          message: 'Application not found',
          code: 'APPLICATION_NOT_FOUND'
        });
        return;
      }

      // Check if user has access to this application
      const client = this.clients.get(userId);
      if (!client.rooms.has(`app_${applicationId}`)) {
        this.sendToClient(userId, {
          type: 'error',
          message: 'Access denied to this application',
          code: 'ACCESS_DENIED'
        });
        return;
      }

      // Save message to database
      const chatMessage = new ChatMessage({
        application: applicationId,
        sender: userId,
        content,
        language,
        isAI: false
      });
      await chatMessage.save();

      // Broadcast message to room
      const roomId = `app_${applicationId}`;
      this.broadcastToRoom(roomId, {
        type: 'new_message',
        message: {
          id: chatMessage._id,
          sender: userId,
          content,
          language,
          timestamp: new Date(),
          isAI: false
        }
      }, [userId]);

      // Trigger AI response if enabled
      if (process.env.OPENAI_API_KEY) {
        this.triggerAIResponse(applicationId, content, language);
      }

      // Update client metrics
      client.metrics.messagesSent++;

    } catch (error) {
      console.error('Error handling chat message:', error);
      this.sendToClient(userId, {
        type: 'error',
        message: 'Failed to process chat message',
        code: 'INTERNAL_ERROR'
      });
    }
  }

  // Enhanced room management
  async handleJoinRoom(userId, message) {
    try {
      const { roomId, roomType = 'application' } = message;
      
      if (!roomId) {
        this.sendToClient(userId, {
          type: 'error',
          message: 'Room ID is required',
          code: 'MISSING_ROOM_ID'
        });
        return;
      }

      await this.joinRoom(userId, roomId, roomType);

    } catch (error) {
      console.error('Error joining room:', error);
      this.sendToClient(userId, {
        type: 'error',
        message: 'Failed to join room',
        code: 'JOIN_ROOM_ERROR'
      });
    }
  }

  // Enhanced room joining logic
  async joinRoom(userId, roomId, roomType = 'application') {
    try {
      const client = this.clients.get(userId);
      if (!client) return;

      // Leave current rooms of the same type
      for (const currentRoom of client.rooms) {
        if (this.getRoomType(currentRoom) === roomType) {
          await this.leaveRoom(userId, currentRoom);
        }
      }

      // Create room if it doesn't exist
      if (!this.rooms.has(roomId)) {
        this.rooms.set(roomId, {
          clients: new Set(),
          type: roomType,
          metadata: {},
          metrics: {
            messagesSent: 0,
            usersJoined: 0,
            createdAt: new Date()
          }
        });
      }

      const room = this.rooms.get(roomId);
      room.clients.add(userId);
      room.metrics.usersJoined++;
      client.rooms.add(roomId);

      // Notify room of new user
      this.broadcastToRoom(roomId, {
        type: 'user_joined_room',
        userId,
        user: { id: userId, role: client.user.role },
        timestamp: new Date()
      }, [userId]);

      // Confirm room join to user
      this.sendToClient(userId, {
        type: 'room_joined',
        roomId,
        roomType,
        roomInfo: {
          clientCount: room.clients.size,
          type: room.type,
          metadata: room.metadata
        }
      });

      console.log(`👥 User ${userId} joined room ${roomId} (${room.clients.size} users)`);

    } catch (error) {
      console.error('Error joining room:', error);
      throw error;
    }
  }

  // Enhanced room leaving logic
  async leaveRoom(userId, roomId) {
    try {
      const client = this.clients.get(userId);
      if (!client) return;

      const room = this.rooms.get(roomId);
      if (!room) return;

      room.clients.delete(userId);
      client.rooms.delete(roomId);

      // Notify room of user departure
      this.broadcastToRoom(roomId, {
        type: 'user_left_room',
        userId,
        timestamp: new Date()
      }, [userId]);

      // Clean up empty rooms
      if (room.clients.size === 0) {
        this.rooms.delete(roomId);
        console.log(`🗑️ Room ${roomId} deleted (no users remaining)`);
      }

      console.log(`👋 User ${userId} left room ${roomId}`);

    } catch (error) {
      console.error('Error leaving room:', error);
      throw error;
    }
  }

  // Enhanced voice call handling
  async handleStartVoiceCall(userId, message) {
    try {
      const { applicationId, callType = 'audio' } = message;
      
      if (!applicationId) {
        this.sendToClient(userId, {
          type: 'error',
          message: 'Application ID is required',
          code: 'MISSING_APPLICATION_ID'
        });
        return;
      }

      const callId = `call_${applicationId}_${Date.now()}`;
      
      this.voiceCalls.set(callId, {
        id: callId,
        applicationId,
        initiator: userId,
        participants: new Set([userId]),
        status: 'initiating',
        type: callType,
        metadata: {
          startTime: new Date(),
          roomId: `app_${applicationId}`
        }
      });

      // Notify room of voice call
      const roomId = `app_${applicationId}`;
      this.broadcastToRoom(roomId, {
        type: 'voice_call_started',
        callId,
        initiator: userId,
        callType,
        timestamp: new Date()
      });

      console.log(`📞 Voice call ${callId} initiated by user ${userId}`);

    } catch (error) {
      console.error('Error starting voice call:', error);
      this.sendToClient(userId, {
        type: 'error',
        message: 'Failed to start voice call',
        code: 'VOICE_CALL_ERROR'
      });
    }
  }

  // Enhanced voice call joining
  async handleJoinVoiceCall(userId, message) {
    try {
      const { callId } = message;
      
      if (!callId) {
        this.sendToClient(userId, {
          type: 'error',
          message: 'Call ID is required',
          code: 'MISSING_CALL_ID'
        });
        return;
      }

      const call = this.voiceCalls.get(callId);
      if (!call) {
        this.sendToClient(userId, {
          type: 'error',
          message: 'Call not found',
          code: 'CALL_NOT_FOUND'
        });
        return;
      }

      call.participants.add(userId);
      call.status = 'active';

      // Notify all participants
      for (const participantId of call.participants) {
        this.sendToClient(participantId, {
          type: 'voice_call_created',
          callId,
          participants: Array.from(call.participants),
          status: call.status,
          timestamp: new Date()
        });
      }

      console.log(`📱 User ${userId} joined voice call ${callId}`);

    } catch (error) {
      console.error('Error joining voice call:', error);
      this.sendToClient(userId, {
        type: 'error',
        message: 'Failed to join voice call',
        code: 'VOICE_CALL_ERROR'
      });
    }
  }

  // Enhanced voice call ending
  async handleEndVoiceCall(userId, message) {
    try {
      const { callId } = message;
      
      if (!callId) {
        this.sendToClient(userId, {
          type: 'error',
          message: 'Call ID is required',
          code: 'MISSING_CALL_ID'
        });
        return;
      }

      const call = this.voiceCalls.get(callId);
      if (!call) return;

      // Notify all participants
      for (const participantId of call.participants) {
        this.sendToClient(participantId, {
          type: 'call_ended',
          callId,
          endedBy: userId,
          timestamp: new Date()
        });
      }

      this.voiceCalls.delete(callId);
      console.log(`📞 Voice call ${callId} ended by user ${userId}`);

    } catch (error) {
      console.error('Error ending voice call:', error);
      this.sendToClient(userId, {
        type: 'error',
        message: 'Failed to end voice call',
        code: 'VOICE_CALL_ERROR'
      });
    }
  }

  // Enhanced voice signaling
  async handleVoiceSignal(userId, message) {
    try {
      const { callId, targetUserId, signal } = message;
      
      if (!callId || !targetUserId || !signal) {
        this.sendToClient(userId, {
          type: 'error',
          message: 'Call ID, target user ID, and signal are required',
          code: 'MISSING_FIELDS'
        });
        return;
      }

      // Forward signal to target user
      this.sendToClient(targetUserId, {
        type: 'voice_signal',
        callId,
        fromUserId: userId,
        signal,
        timestamp: new Date()
      });

    } catch (error) {
      console.error('Error handling voice signal:', error);
      this.sendToClient(userId, {
        type: 'error',
        message: 'Failed to process voice signal',
        code: 'VOICE_SIGNAL_ERROR'
      });
    }
  }

  // Enhanced status updates
  async handleStatusUpdate(userId, message) {
    try {
      const { status } = message;
      
      if (!status) {
        this.sendToClient(userId, {
          type: 'error',
          message: 'Status is required',
          code: 'MISSING_STATUS'
        });
        return;
      }

      const client = this.clients.get(userId);
      if (!client) return;

      const oldStatus = client.status;
      client.status = status;
      client.lastSeen = new Date();

      // Broadcast status change to all rooms user is in
      for (const roomId of client.rooms) {
        this.broadcastToRoom(roomId, {
          type: 'user_status_changed',
          userId,
          oldStatus,
          newStatus: status,
          timestamp: new Date()
        }, [userId]);
      }

      console.log(`📊 User ${userId} status changed: ${oldStatus} → ${status}`);

    } catch (error) {
      console.error('Error updating status:', error);
      this.sendToClient(userId, {
        type: 'error',
        message: 'Failed to update status',
        code: 'STATUS_UPDATE_ERROR'
      });
    }
  }

  // Enhanced ping handling
  handlePing(userId) {
    const client = this.clients.get(userId);
    if (!client) return;

    client.lastSeen = new Date();
    client.ws.pong();
  }

  // Enhanced pong handling
  handlePong(userId) {
    const client = this.clients.get(userId);
    if (!client) return;

    client.lastSeen = new Date();
  }

  // Get user rooms
  handleGetRooms(userId) {
    const client = this.clients.get(userId);
    if (!client) return;

    const userRooms = Array.from(client.rooms).map(roomId => {
      const room = this.rooms.get(roomId);
      return {
        id: roomId,
        type: room.type,
        clientCount: room.clients.size,
        metadata: room.metadata
      };
    });

    this.sendToClient(userId, {
      type: 'user_rooms',
      rooms: userRooms,
      timestamp: new Date()
    });
  }

  // Get user metrics
  handleGetMetrics(userId) {
    const client = this.clients.get(userId);
    if (!client) return;

    this.sendToClient(userId, {
      type: 'user_metrics',
      metrics: {
        ...client.metrics,
        rooms: client.rooms.size,
        status: client.status
      },
      timestamp: new Date()
    });
  }

  // Enhanced AI response triggering
  async triggerAIResponse(applicationId, userMessage, language) {
    try {
      // Import OpenAI service dynamically to avoid circular dependencies
      const openaiService = require('./openaiService');
      
      if (!openaiService.isAvailable()) {
        console.log('OpenAI service not available, skipping AI response');
        return;
      }

      const response = await openaiService.generateAIResponse(userMessage, applicationId, language);
      
      if (response) {
        // Save AI response to database
        const aiMessage = new ChatMessage({
          application: applicationId,
          sender: 'ai',
          content: response,
          language,
          isAI: true
        });
        await aiMessage.save();

        // Broadcast AI response to room
        const roomId = `app_${applicationId}`;
        this.broadcastToRoom(roomId, {
          type: 'ai_response',
          message: {
            id: aiMessage._id,
            sender: 'ai',
            content: response,
            language,
            timestamp: new Date(),
            isAI: true
          }
        });

        console.log(`🤖 AI response sent for application ${applicationId}`);
      }

    } catch (error) {
      console.error('Error triggering AI response:', error);
    }
  }

  // Enhanced auto-join logic
  async autoJoinUserRooms(userId) {
    try {
      const client = this.clients.get(userId);
      if (!client) return;

      // Get user's applications based on role
      let applications = [];
      
      if (client.user.role === 'sponsor') {
        applications = await VisaApplication.find({ sponsor: userId });
      } else if (client.user.role === 'sponsored') {
        applications = await VisaApplication.find({ sponsored: userId });
      } else if (client.user.role === 'amer' || client.user.role === 'admin') {
        applications = await VisaApplication.find({ status: { $in: ['submitted', 'under_review'] } });
      }

      // Auto-join application rooms
      for (const app of applications) {
        await this.joinRoom(userId, `app_${app._id}`, 'application');
      }

      console.log(`🔄 Auto-joined user ${userId} to ${applications.length} application rooms`);

    } catch (error) {
      console.error('Error auto-joining user rooms:', error);
    }
  }

  // Enhanced disconnection handling
  async handleDisconnection(userId) {
    try {
      const client = this.clients.get(userId);
      if (!client) return;

      // Leave all rooms
      for (const roomId of client.rooms) {
        await this.leaveRoom(userId, roomId);
      }

      // End any active voice calls
      for (const [callId, call] of this.voiceCalls.entries()) {
        if (call.participants.has(userId)) {
          call.participants.delete(userId);
          
          if (call.participants.size === 0) {
            this.voiceCalls.delete(callId);
          } else {
            // Notify remaining participants
            for (const participantId of call.participants) {
              this.sendToClient(participantId, {
                type: 'participant_left_call',
                callId,
                userId,
                timestamp: new Date()
              });
            }
          }
        }
      }

      // Update connection counts
      this.userConnections.set(userId, Math.max(0, (this.userConnections.get(userId) || 1) - 1));
      this.metrics.activeConnections--;

      // Clean up client
      this.clients.delete(userId);

      console.log(`🔌 User ${userId} disconnected (${this.metrics.activeConnections} active)`);

    } catch (error) {
      console.error('Error handling disconnection:', error);
    }
  }

  // Enhanced error handling
  handleError(userId, error) {
    try {
      const client = this.clients.get(userId);
      if (!client) return;

      client.metrics.errors++;
      this.metrics.totalErrors++;

      console.error(`WebSocket error for user ${userId}:`, error);

      // Send error notification to client
      this.sendToClient(userId, {
        type: 'error',
        message: 'An error occurred. Please reconnect if the problem persists.',
        code: 'INTERNAL_ERROR',
        timestamp: new Date()
      });

    } catch (err) {
      console.error('Error in error handler:', err);
    }
  }

  // Enhanced message sending with error handling
  sendToClient(userId, data) {
    try {
      const client = this.clients.get(userId);
      if (!client || client.ws.readyState !== WebSocket.OPEN) {
        return false;
      }

      const message = JSON.stringify({
        ...data,
        timestamp: data.timestamp || new Date()
      });

      client.ws.send(message);
      client.metrics.messagesSent++;
      client.metrics.lastActivity = new Date();

      return true;

    } catch (error) {
      console.error(`Error sending message to user ${userId}:`, error);
      return false;
    }
  }

  // Enhanced room broadcasting
  broadcastToRoom(roomId, data, excludeUsers = []) {
    try {
      const room = this.rooms.get(roomId);
      if (!room) return;

      const message = JSON.stringify({
        ...data,
        timestamp: data.timestamp || new Date()
      });

      let sentCount = 0;
      for (const userId of room.clients) {
        if (!excludeUsers.includes(userId)) {
          if (this.sendToClient(userId, data)) {
            sentCount++;
          }
        }
      }

      room.metrics.messagesSent += sentCount;
      return sentCount;

    } catch (error) {
      console.error(`Error broadcasting to room ${roomId}:`, error);
      return 0;
    }
  }

  // Enhanced room type detection
  getRoomType(roomId) {
    const room = this.rooms.get(roomId);
    return room ? room.type : null;
  }

  // Heartbeat monitoring system
  startHeartbeat() {
    setInterval(() => {
      const now = Date.now();
      const heartbeatInterval = 30000; // 30 seconds

      for (const [userId, client] of this.clients.entries()) {
        try {
          if (now - client.lastSeen.getTime() > heartbeatInterval) {
            // Send ping to check connection
            if (client.ws.readyState === WebSocket.OPEN) {
              client.ws.ping();
            }
          }

          // Check for stale connections (no activity for 2 minutes)
          if (now - client.lastSeen.getTime() > 120000) {
            console.log(`🔄 Closing stale connection for user ${userId}`);
            client.ws.close(1000, 'Connection timeout');
          }
        } catch (error) {
          console.error(`Error in heartbeat for user ${userId}:`, error);
        }
      }

      // Clean up rate limiting data
      const rateLimitCleanup = 300000; // 5 minutes
      for (const [key, attempt] of this.connectionAttempts.entries()) {
        if (now - attempt.resetTime > rateLimitCleanup) {
          this.connectionAttempts.delete(key);
        }
      }

    }, 30000); // Check every 30 seconds
  }

  // Enhanced statistics and monitoring
  getStats() {
    const now = Date.now();
    const uptime = now - this.metrics.startTime.getTime();
    
    return {
      ...this.metrics,
      uptime: Math.floor(uptime / 1000), // seconds
      uptimeFormatted: this.formatUptime(uptime),
      activeRooms: this.rooms.size,
      activeVoiceCalls: this.voiceCalls.size,
      totalUsers: this.clients.size,
      rateLimits: this.rateLimits,
      memoryUsage: process.memoryUsage(),
      timestamp: new Date()
    };
  }

  // Format uptime for display
  formatUptime(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  }

  // Get active users list
  getActiveUsers() {
    const activeUsers = [];
    
    for (const [userId, client] of this.clients.entries()) {
      activeUsers.push({
        id: userId,
        role: client.user.role,
        status: client.status,
        lastSeen: client.lastSeen,
        rooms: Array.from(client.rooms),
        metrics: client.metrics
      });
    }

    return activeUsers;
  }

  // Graceful shutdown
  async shutdown() {
    console.log('🔄 Shutting down WebSocket server...');
    
    // Close all connections gracefully
    for (const [userId, client] of this.clients.entries()) {
      try {
        client.ws.close(1001, 'Server shutdown');
      } catch (error) {
        console.error(`Error closing connection for user ${userId}:`, error);
      }
    }

    // Close WebSocket server
    this.wss.close(() => {
      console.log('✅ WebSocket server shutdown complete');
    });
  }
}

module.exports = WebSocketServer; 