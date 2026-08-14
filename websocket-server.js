const { Server } = require('socket.io');
const http = require('http');
const jwt = require('jsonwebtoken');

class WebSocketServer {
  constructor(server, options = {}) {
    this.io = new Server(server, {
      cors: {
        origin: [
          process.env.FRONTEND_URL || "http://localhost:5173",
          "http://127.0.0.1:5173",
          "http://localhost:3000",
          "http://127.0.0.1:3000"
        ],
        methods: ["GET", "POST"],
        credentials: true
      },
      ...options
    });

    this.connectedUsers = new Map();
    this.connectedOfficers = new Map();
    this.chatRooms = new Map();
    this.setupMiddleware();
    this.setupEventHandlers();
  }

  setupMiddleware() {
    // Authentication middleware
    this.io.use(async (socket, next) => {
      try {
        let token = socket.handshake.auth?.token || socket.handshake.headers?.authorization;
        
        // Allow test connections without authentication
        if (process.env.NODE_ENV === 'test' || !token) {
          socket.userId = socket.id;
          socket.userType = 'user';
          socket.userData = { id: socket.id, role: 'user' };
          return next();
        }

        // Support 'Bearer <token>' format
        if (typeof token === 'string' && token.startsWith('Bearer ')) {
          token = token.slice(7).trim();
        }

        // Verify JWT token
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key-change-in-production');
        socket.userId = decoded.userId || decoded.id || decoded._id;
        const role = decoded.role || decoded.userType || 'user';
        socket.userType = role === 'amer' ? 'officer' : role;
        socket.userData = decoded;
        
        next();
      } catch (error) {
        console.error('WebSocket authentication error:', error.message);
        next(new Error('Authentication failed'));
      }
    });
  }

  setupEventHandlers() {
    this.io.on('connection', (socket) => {
      console.log(`User connected: ${socket.userId} (${socket.userType})`);
      
      // Store user connection
      this.connectedUsers.set(socket.userId, {
        socketId: socket.id,
        userType: socket.userType,
        userData: socket.userData,
        connectedAt: new Date(),
        lastActivity: new Date()
      });

      // If Amer officer, mark available by default
      if (socket.userType === 'officer' || socket.userData?.role === 'amer') {
        this.connectedOfficers.set(socket.userId, {
          socketId: socket.id,
          status: 'available',
          lastUpdate: new Date(),
          userId: socket.userId,
          userData: socket.userData
        });
      }

      // Set up auction room handlers
      this.setupAuctionHandlers(socket);

      // ─── Studio session room ────────────────────────────────────────────
      // The Studio frontend joins `studio:<sessionId>` so that Redis-bridged
      // job updates (queued/progress/complete/failed) can fan out to the
      // exact browser that triggered the generation.
      socket.on('join:session', (data) => {
        try {
          const sessionId = data?.sessionId;
          if (!sessionId || typeof sessionId !== 'string') return;
          const room = `studio:${sessionId}`;
          socket.join(room);
          socket.emit('session:joined', { sessionId, room });
        } catch (err) {
          console.warn('[ws] join:session failed:', err.message);
        }
      });

      socket.on('leave:session', (data) => {
        try {
          const sessionId = data?.sessionId;
          if (!sessionId) return;
          socket.leave(`studio:${sessionId}`);
        } catch {/* noop */}
      });

      // Handle AI chat messages
      socket.on('ai_chat_message', async (data) => {
        try {
          const response = await fetch('http://localhost:5001/api/v1/chat/process', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${socket.handshake.auth.token}`
            },
            body: JSON.stringify({
              message: data.message,
              context: data.context
            })
          });

          const result = await response.json();
          
          if (result.status === 'success') {
            socket.emit('ai_chat_response', {
              response: result.response,
              actions: result.actions
            });

            // If AI suggests connecting to Amer officer
            if (result.actions?.some(action => action.type === 'CONNECT_AMER')) {
              this.handleAmerConnection(socket, data.context?.service);
            }
          } else {
            socket.emit('ai_chat_error', {
              message: 'Failed to process message'
            });
          }
        } catch (error) {
          console.error('Error processing AI chat message:', error);
          socket.emit('ai_chat_error', {
            message: 'Internal server error'
          });
        }
      });

      // Direct Amer connection request
      socket.on('request_amer_connection', (data) => {
        this.handleAmerConnection(socket, data?.service);
      });

      // User starts conversation with initial message (queue + invite)
      socket.on('user_start_conversation', (data) => {
        try {
          const { service, initialMessage } = data || {};
          // Find available officer
          const availableOfficer = Array.from(this.connectedOfficers.values())
            .find(officer => officer.status === 'available');

          const roomId = `amer_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
          // Create room and join user
          this.chatRooms.set(roomId, {
            id: roomId,
            userId: socket.userId,
            officerId: availableOfficer?.userId,
            service,
            status: 'waiting',
            createdAt: new Date(),
            lastActivity: new Date(),
            messages: []
          });
          socket.join(roomId);

          // Queue initial message in room history for later retrieval
          if (initialMessage && String(initialMessage).trim().length > 0) {
            const queuedMsg = {
              id: Date.now().toString(),
              content: String(initialMessage),
              type: 'text',
              sender: socket.userId,
              timestamp: new Date(),
              status: 'sent',
              metadata: { roomId }
            };
            this.chatRooms.get(roomId).messages.push(queuedMsg);
            this.io.to(roomId).emit('new_message', queuedMsg);
          }

          // Notify user of queue + room id
          socket.emit('conversation_queued', { roomId });

          // Invite officer if available
          if (availableOfficer) {
            const invitePayload = {
              roomId,
              userId: socket.userId,
              userName: socket.userData?.name,
              service
            };
            this.io.to(availableOfficer.socketId).emit('amer_invite', invitePayload);
          } else {
            socket.emit('amer_unavailable', {
              message: 'All Amer officers are currently busy. Please wait a moment or continue with AI assistance.',
              roomId
            });
          }
        } catch (error) {
          console.error('Error starting conversation:', error);
          socket.emit('amer_connection_error', { message: 'Failed to start conversation' });
        }
      });

      // Officer accepts invite to join a user's room
      socket.on('amer_accept_invite', (data) => {
        try {
          const { roomId } = data || {};
          if (!roomId || !this.chatRooms.has(roomId)) {
            return socket.emit('amer_connection_error', { message: 'Invalid room' });
          }
          const room = this.chatRooms.get(roomId);
          // Ensure this socket is an officer
          const officerId = socket.userId;
          const officerRecord = this.connectedOfficers.get(officerId);
          if (!officerRecord) {
            return socket.emit('amer_connection_error', { message: 'Officer not available' });
          }
          // Join officer to room
          socket.join(roomId);
          room.officerId = officerId;
          room.status = 'active';
          room.lastActivity = new Date();
          this.chatRooms.set(roomId, room);
          // Notify both parties
          this.io.to(roomId).emit('amer_connected', {
            roomId,
            officerName: socket.userData?.name || 'Amer Officer'
          });

          // Send room snapshot to officer (history)
          this.io.to(socket.id).emit('room_snapshot', {
            roomId,
            messages: room.messages || []
          });
        } catch (error) {
          console.error('Error accepting Amer invite:', error);
          socket.emit('amer_connection_error', { message: 'Failed to accept invite' });
        }
      });

      // Handle user joining chat room
      socket.on('join_chat_room', (data) => {
        this.handleJoinChatRoom(socket, data);
      });

      // Handle user leaving chat room
      socket.on('leave_chat_room', (data) => {
        this.handleLeaveChatRoom(socket, data);
      });

      // Handle new message
      socket.on('send_message', (data) => {
        this.handleNewMessage(socket, data);
      });

      // Handle typing indicators
      socket.on('typing_start', (data) => {
        this.handleTypingStart(socket, data);
      });

      socket.on('typing_stop', (data) => {
        this.handleTypingStop(socket, data);
      });

      // Handle file sharing
      socket.on('file_upload_start', (data) => {
        this.handleFileUploadStart(socket, data);
      });

      socket.on('file_upload_complete', (data) => {
        this.handleFileUploadComplete(socket, data);
      });

      // Handle voice call requests
      socket.on('voice_call_request', (data) => {
        this.handleVoiceCallRequest(socket, data);
      });

      socket.on('voice_call_answer', (data) => {
        this.handleVoiceCallAnswer(socket, data);
      });

      socket.on('voice_call_reject', (data) => {
        this.handleVoiceCallReject(socket, data);
      });

      // Handle video call requests
      socket.on('video_call_request', (data) => {
        this.handleVideoCallRequest(socket, data);
      });

      socket.on('video_call_answer', (data) => {
        this.handleVideoCallAnswer(socket, data);
      });

      socket.on('video_call_reject', (data) => {
        this.handleVideoCallReject(socket, data);
      });

      // Handle call end
      socket.on('call_end', (data) => {
        this.handleCallEnd(socket, data);
      });

      // Handle officer status updates
      socket.on('officer_status_update', (data) => {
        this.handleOfficerStatusUpdate(socket, data);
      });

      // Handle user presence
      socket.on('user_presence', (data) => {
        this.handleUserPresence(socket, data);
      });

      // Handle disconnect
      socket.on('disconnect', () => {
        this.handleDisconnect(socket);
      });

      // Handle errors
      socket.on('error', (error) => {
        console.error('Socket error:', error);
      });
    });
  }

  handleJoinChatRoom(socket, data) {
    const { roomId, userId, officerId } = data;
    
    try {
      // Join the room
      socket.join(roomId);
      
      // Update user's current room
      const userConnection = this.connectedUsers.get(userId);
      if (userConnection) {
        userConnection.currentRoom = roomId;
        userConnection.lastActivity = new Date();
      }

      // Create or update chat room
      if (!this.chatRooms.has(roomId)) {
        this.chatRooms.set(roomId, {
          id: roomId,
          userId,
          officerId,
          participants: [userId, officerId],
          status: 'active',
          createdAt: new Date(),
          lastActivity: new Date()
        });
      }

      // Notify other participants
      socket.to(roomId).emit('user_joined_room', {
        userId,
        roomId,
        timestamp: new Date()
      });

      // Send room info to the user
      socket.emit('room_joined', {
        roomId,
        participants: this.chatRooms.get(roomId).participants,
        timestamp: new Date()
      });

      console.log(`User ${userId} joined chat room: ${roomId}`);
    } catch (error) {
      console.error('Error joining chat room:', error);
      socket.emit('error', { message: 'Failed to join chat room' });
    }
  }

  handleLeaveChatRoom(socket, data) {
    const { roomId, userId } = data;
    
    try {
      socket.leave(roomId);
      
      // Update user's current room
      const userConnection = this.connectedUsers.get(userId);
      if (userConnection) {
        userConnection.currentRoom = null;
        userConnection.lastActivity = new Date();
      }

      // Notify other participants
      socket.to(roomId).emit('user_left_room', {
        userId,
        roomId,
        timestamp: new Date()
      });

      console.log(`User ${userId} left chat room: ${roomId}`);
    } catch (error) {
      console.error('Error leaving chat room:', error);
      socket.emit('error', { message: 'Failed to leave chat room' });
    }
  }

  handleNewMessage(socket, data) {
    const { roomId, message, userId } = data;
    
    try {
      // Broadcast message to room
      const messageData = {
        id: Date.now().toString(),
        content: message.content,
        type: message.type || 'text',
        sender: userId,
        timestamp: new Date(),
        status: 'sent',
        metadata: { ...(message.metadata || {}), roomId }
      };

      // Update room activity
      if (this.chatRooms.has(roomId)) {
        const room = this.chatRooms.get(roomId);
        room.lastActivity = new Date();
        room.messages = room.messages || [];
        room.messages.push(messageData);
      }

      // Emit to all users in the room
      this.io.to(roomId).emit('new_message', messageData);

      // Update user activity
      const userConnection = this.connectedUsers.get(userId);
      if (userConnection) {
        userConnection.lastActivity = new Date();
      }

      console.log(`Message sent in room ${roomId} by user ${userId}`);
    } catch (error) {
      console.error('Error sending message:', error);
      socket.emit('error', { message: 'Failed to send message' });
    }
  }

  handleTypingStart(socket, data) {
    const { roomId, userId } = data;
    
    try {
      socket.to(roomId).emit('user_typing', {
        userId,
        roomId,
        isTyping: true,
        timestamp: new Date()
      });
    } catch (error) {
      console.error('Error handling typing start:', error);
    }
  }

  handleTypingStop(socket, data) {
    const { roomId, userId } = data;
    
    try {
      socket.to(roomId).emit('user_typing', {
        userId,
        roomId,
        isTyping: false,
        timestamp: new Date()
      });
    } catch (error) {
      console.error('Error handling typing stop:', error);
    }
  }

  handleFileUploadStart(socket, data) {
    const { roomId, userId, fileName, fileSize } = data;
    
    try {
      socket.to(roomId).emit('file_upload_start', {
        userId,
        fileName,
        fileSize,
        timestamp: new Date()
      });
    } catch (error) {
      console.error('Error handling file upload start:', error);
    }
  }

  handleFileUploadComplete(socket, data) {
    const { roomId, userId, fileUrl, fileName, fileSize } = data;
    
    try {
      const messageData = {
        id: Date.now().toString(),
        content: 'File shared',
        type: 'file',
        sender: userId,
        timestamp: new Date(),
        status: 'sent',
        metadata: {
          roomId,
          fileUrl,
          fileName,
          fileSize
        }
      };

      // Update room messages
      if (this.chatRooms.has(roomId)) {
        const room = this.chatRooms.get(roomId);
        room.messages = room.messages || [];
        room.messages.push(messageData);
        room.lastActivity = new Date();
      }

      // Broadcast to room
      this.io.to(roomId).emit('file_upload_complete', messageData);
      this.io.to(roomId).emit('new_message', messageData);
    } catch (error) {
      console.error('Error handling file upload complete:', error);
    }
  }

  handleVoiceCallRequest(socket, data) {
    const { roomId, userId, targetUserId } = data;
    
    try {
      // Find target user's socket
      const targetConnection = this.connectedUsers.get(targetUserId);
      if (targetConnection) {
        this.io.to(targetConnection.socketId).emit('voice_call_request', {
          from: userId,
          roomId,
          timestamp: new Date()
        });
      }
    } catch (error) {
      console.error('Error handling voice call request:', error);
    }
  }

  handleVoiceCallAnswer(socket, data) {
    const { roomId, userId, accepted, targetUserId } = data;
    
    try {
      const targetConnection = this.connectedUsers.get(targetUserId);
      if (targetConnection) {
        this.io.to(targetConnection.socketId).emit('voice_call_answered', {
          by: userId,
          accepted,
          roomId,
          timestamp: new Date()
        });
      }

      if (accepted) {
        // Notify room participants about active call
        this.io.to(roomId).emit('voice_call_active', {
          participants: [userId, targetUserId],
          roomId,
          timestamp: new Date()
        });
      }
    } catch (error) {
      console.error('Error handling voice call answer:', error);
    }
  }

  handleVoiceCallReject(socket, data) {
    const { roomId, userId, targetUserId } = data;
    
    try {
      const targetConnection = this.connectedUsers.get(targetUserId);
      if (targetConnection) {
        this.io.to(targetConnection.socketId).emit('voice_call_rejected', {
          by: userId,
          roomId,
          timestamp: new Date()
        });
      }
    } catch (error) {
      console.error('Error handling voice call reject:', error);
    }
  }

  handleVideoCallRequest(socket, data) {
    const { roomId, userId, targetUserId } = data;
    
    try {
      const targetConnection = this.connectedUsers.get(targetUserId);
      if (targetConnection) {
        this.io.to(targetConnection.socketId).emit('video_call_request', {
          from: userId,
          roomId,
          timestamp: new Date()
        });
      }
    } catch (error) {
      console.error('Error handling video call request:', error);
    }
  }

  handleVideoCallAnswer(socket, data) {
    const { roomId, userId, accepted, targetUserId } = data;
    
    try {
      const targetConnection = this.connectedUsers.get(targetUserId);
      if (targetConnection) {
        this.io.to(targetConnection.socketId).emit('video_call_answered', {
          by: userId,
          accepted,
          roomId,
          timestamp: new Date()
        });
      }

      if (accepted) {
        // Notify room participants about active call
        this.io.to(roomId).emit('video_call_active', {
          participants: [userId, targetUserId],
          roomId,
          timestamp: new Date()
        });
      }
    } catch (error) {
      console.error('Error handling video call answer:', error);
    }
  }

  handleVideoCallReject(socket, data) {
    const { roomId, userId, targetUserId } = data;
    
    try {
      const targetConnection = this.connectedUsers.get(targetUserId);
      if (targetConnection) {
        this.io.to(targetConnection.socketId).emit('video_call_rejected', {
          by: userId,
          roomId,
          timestamp: new Date()
        });
      }
    } catch (error) {
      console.error('Error handling video call reject:', error);
    }
  }

  handleCallEnd(socket, data) {
    const { roomId, userId, callType } = data;
    
    try {
      // Notify room participants about call end
      this.io.to(roomId).emit('call_ended', {
        by: userId,
        callType,
        roomId,
        timestamp: new Date()
      });
    } catch (error) {
      console.error('Error handling call end:', error);
    }
  }

  handleOfficerStatusUpdate(socket, data) {
    const { officerId, status, isOnline } = data;
    
    try {
      // Update officer status
      if (isOnline) {
        this.connectedOfficers.set(officerId, {
          socketId: socket.id,
          status,
          lastUpdate: new Date(),
          userId: officerId
        });
      } else {
        this.connectedOfficers.delete(officerId);
      }

      // Broadcast status update to all users
      this.io.emit('officer_status_updated', {
        officerId,
        status,
        isOnline,
        timestamp: new Date()
      });
    } catch (error) {
      console.error('Error handling officer status update:', error);
    }
  }

  handleUserPresence(socket, data) {
    const { userId, status } = data;
    
    try {
      const userConnection = this.connectedUsers.get(userId);
      if (userConnection) {
        userConnection.status = status;
        userConnection.lastActivity = new Date();
      }

      // Broadcast presence update to user's current room
      if (userConnection && userConnection.currentRoom) {
        socket.to(userConnection.currentRoom).emit('user_presence_updated', {
          userId,
          status,
          timestamp: new Date()
        });
      }
    } catch (error) {
      console.error('Error handling user presence:', error);
    }
  }

  handleDisconnect(socket) {
    try {
      const userId = socket.userId;
      console.log(`User disconnected: ${userId}`);

      // Remove from connected users
      this.connectedUsers.delete(userId);

      // Remove from connected officers if applicable
      if (socket.userType === 'officer' || socket.userData?.role === 'amer') {
        this.connectedOfficers.delete(userId);
      }

      // Notify room participants if user was in a room
      const userConnection = this.connectedUsers.get(userId);
      if (userConnection && userConnection.currentRoom) {
        socket.to(userConnection.currentRoom).emit('user_disconnected', {
          userId,
          roomId: userConnection.currentRoom,
          timestamp: new Date()
        });
      }
    } catch (error) {
      console.error('Error handling disconnect:', error);
    }
  }

  // Public methods for external use
  getConnectedUsers() {
    return Array.from(this.connectedUsers.entries());
  }

  getConnectedOfficers() {
    return Array.from(this.connectedOfficers.entries());
  }

  getChatRooms() {
    return Array.from(this.chatRooms.entries());
  }

  sendToUser(userId, event, data) {
    const userConnection = this.connectedUsers.get(userId);
    if (userConnection) {
      this.io.to(userConnection.socketId).emit(event, data);
    }
  }

  /**
   * sendToClient — compatibility with acquisitionController which calls wsServer.sendToClient(userId, payload)
   * The acquisition controller uses { type, ...data } as a single object (ws-style), so we emit on 'message'.
   */
  sendToClient(userId, payload) {
    const userConnection = this.connectedUsers.get(userId?.toString());
    if (userConnection) {
      this.io.to(userConnection.socketId).emit(payload.type || 'message', payload);
    }
  }

  /**
   * broadcastToRoom — compatibility shim for acquisitionController which calls wsServer.broadcastToRoom(roomId, payload).
   */
  broadcastToRoom(roomId, payload, excludeUsers = []) {
    const room = this.io.sockets.adapter.rooms.get(roomId);
    if (!room) {
      // Use socket.io's built-in room broadcast
      this.io.to(roomId).emit(payload.type || 'message', payload);
      return;
    }
    this.io.to(roomId).emit(payload.type || 'message', payload);
  }

  sendToRoom(roomId, event, data) {
    this.io.to(roomId).emit(event, data);
  }

  broadcastToAll(event, data) {
    this.io.emit(event, data);
  }

  /* ═══════════════════════════════════════════════════════
     AUCTION ROOM MANAGEMENT
  ═══════════════════════════════════════════════════════ */

  setupAuctionHandlers(socket) {
    /* Client joins the live auction room for a specific listing */
    socket.on('auction:join', (data) => {
      const roomId = `auction_${data.listingId}`;
      socket.join(roomId);
      socket.emit('auction:joined', { roomId, listingId: data.listingId });
      // Notify others a new watcher joined
      socket.to(roomId).emit('auction:watcher_joined', {
        listingId: data.listingId,
        watcherCount: this.io.sockets.adapter.rooms.get(roomId)?.size || 0,
      });
    });

    socket.on('auction:leave', (data) => {
      const roomId = `auction_${data.listingId}`;
      socket.leave(roomId);
      socket.to(roomId).emit('auction:watcher_left', {
        listingId: data.listingId,
        watcherCount: Math.max(0, (this.io.sockets.adapter.rooms.get(roomId)?.size || 1) - 1),
      });
    });

    /* Acquisition room */
    socket.on('acquisition:join', (data) => {
      const roomId = `acquisition_${data.acquisitionId}`;
      socket.join(roomId);
      socket.emit('acquisition:joined', { roomId });
    });
  }

  handleAmerConnection(socket, service) {
    try {
      // Find available Amer officer
      const availableOfficer = Array.from(this.connectedOfficers.values())
        .find(officer => officer.status === 'available');

      if (availableOfficer) {
        // Create a unique room ID
        const roomId = `amer_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        // Add room to chat rooms
        this.chatRooms.set(roomId, {
          id: roomId,
          userId: socket.userId,
          officerId: availableOfficer.userId,
          service,
          status: 'active',
          createdAt: new Date(),
          lastActivity: new Date(),
          messages: []
        });

        // Update officer status
        availableOfficer.status = 'busy';
        availableOfficer.currentRoom = roomId;
        this.connectedOfficers.set(availableOfficer.userId, availableOfficer);

        // Join only the user now; officer will join on accept
        socket.join(roomId);

        // Do NOT emit amer_connected yet; wait for officer to accept invite

        const invitePayload = {
          roomId,
          userId: socket.userId,
          userName: socket.userData?.name,
          service
        };
        this.io.to(availableOfficer.socketId).emit('new_application', invitePayload);
        this.io.to(availableOfficer.socketId).emit('amer_invite', invitePayload);

        // Add system message to chat
        const systemMessage = {
          id: Date.now().toString(),
          type: 'system',
          content: 'Connected to Amer Officer. You can now discuss your application directly.',
          timestamp: new Date()
        };

        this.chatRooms.get(roomId).messages.push(systemMessage);
        this.io.to(roomId).emit('new_message', { ...systemMessage, metadata: { roomId } });

      } else {
        // No officers available
        socket.emit('amer_unavailable', {
          message: 'All Amer officers are currently busy. Please try again later or continue with AI assistance.'
        });
      }
    } catch (error) {
      console.error('Error connecting to Amer officer:', error);
      socket.emit('amer_connection_error', {
        message: 'Failed to connect to Amer officer'
      });
    }
  }
}

module.exports = WebSocketServer; 