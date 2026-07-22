const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

// Chat room management
const chatRooms = new Map();
const onlineOfficers = new Map();
const userSessions = new Map();

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, '../uploads/chat-files');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${uuidv4()}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'application/pdf', 'text/plain'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type'), false);
    }
  }
});

// Get available immigration officers
router.get('/officers', async (req, res) => {
  try {
    const officers = [
      {
        id: 'immigration-officer-001',
        name: 'Officer Ahmed Al-Rashid',
        avatar: '/api/avatars/officer-ahmed.jpg',
        specialization: 'Family Visa Specialist',
        experience: '8 years',
        languages: ['English', 'Arabic', 'Urdu'],
        rating: 4.9,
        isOnline: true,
        currentQueue: 2,
        estimatedWaitTime: '5-10 minutes'
      },
      {
        id: 'immigration-officer-002',
        name: 'Officer Sarah Johnson',
        avatar: '/api/avatars/officer-sarah.jpg',
        specialization: 'Business Visa Expert',
        experience: '6 years',
        languages: ['English', 'Arabic', 'French'],
        rating: 4.8,
        isOnline: true,
        currentQueue: 1,
        estimatedWaitTime: '3-5 minutes'
      },
      {
        id: 'immigration-officer-003',
        name: 'Officer Mohammed Khan',
        avatar: '/api/avatars/officer-mohammed.jpg',
        specialization: 'Employment Visa Specialist',
        experience: '10 years',
        languages: ['English', 'Arabic', 'Hindi'],
        rating: 4.9,
        isOnline: false,
        currentQueue: 0,
        estimatedWaitTime: 'Offline'
      }
    ];

    res.json({
      success: true,
      data: officers,
      message: 'Immigration officers retrieved successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Failed to retrieve immigration officers'
    });
  }
});

// Create or join a chat room
router.post('/rooms', async (req, res) => {
  try {
    const { userId, officerId, serviceType, applicationId } = req.body;

    if (!userId || !officerId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields',
        message: 'User ID and Officer ID are required'
      });
    }

    // Check if officer is online
    const officer = onlineOfficers.get(officerId);
    if (!officer || !officer.isOnline) {
      return res.status(400).json({
        success: false,
        error: 'Officer unavailable',
        message: 'Selected officer is currently offline'
      });
    }

    // Create room ID
    const roomId = `room_${userId}_${officerId}_${Date.now()}`;

    // Create chat room
    const chatRoom = {
      id: roomId,
      userId,
      officerId,
      serviceType,
      applicationId,
      status: 'active',
      createdAt: new Date(),
      messages: [],
      participants: [userId, officerId],
      metadata: {
        serviceType,
        applicationId,
        startTime: new Date()
      }
    };

    chatRooms.set(roomId, chatRoom);

    // Add user to officer's queue
    if (!officer.queue) {
      officer.queue = [];
    }
    officer.queue.push({
      userId,
      roomId,
      joinedAt: new Date(),
      serviceType
    });

    res.json({
      success: true,
      data: {
        roomId,
        officer: {
          id: officer.id,
          name: officer.name,
          avatar: officer.avatar,
          specialization: officer.specialization,
          estimatedWaitTime: '2-3 minutes'
        }
      },
      message: 'Chat room created successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Failed to create chat room'
    });
  }
});

// Get chat room messages
router.get('/rooms/:roomId/messages', async (req, res) => {
  try {
    const { roomId } = req.params;
    const { page = 1, limit = 50 } = req.query;

    const chatRoom = chatRooms.get(roomId);
    if (!chatRoom) {
      return res.status(404).json({
        success: false,
        error: 'Room not found',
        message: 'Chat room does not exist'
      });
    }

    const startIndex = (page - 1) * limit;
    const endIndex = startIndex + parseInt(limit);
    const messages = chatRoom.messages.slice(startIndex, endIndex);

    res.json({
      success: true,
      data: {
        messages,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: chatRoom.messages.length,
          totalPages: Math.ceil(chatRoom.messages.length / limit)
        }
      },
      message: 'Messages retrieved successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Failed to retrieve messages'
    });
  }
});

// Send message to chat room
router.post('/rooms/:roomId/messages', upload.single('file'), async (req, res) => {
  try {
    const { roomId } = req.params;
    const { content, type = 'text', metadata } = req.body;

    const chatRoom = chatRooms.get(roomId);
    if (!chatRoom) {
      return res.status(404).json({
        success: false,
        error: 'Room not found',
        message: 'Chat room does not exist'
      });
    }

    const message = {
      id: uuidv4(),
      content: content || 'File shared',
      type: type,
      sender: req.user?.id || 'anonymous',
      timestamp: new Date(),
      status: 'sent',
      metadata: {
        ...metadata,
        fileUrl: req.file ? `/uploads/chat-files/${req.file.filename}` : null,
        fileName: req.file ? req.file.originalname : null,
        fileSize: req.file ? req.file.size : null,
        fileType: req.file ? req.file.mimetype : null
      }
    };

    // Add message to room
    chatRoom.messages.push(message);

    // Update room last activity
    chatRoom.lastActivity = new Date();

    // Emit to WebSocket if available
    if (req.app.locals.io) {
      req.app.locals.io.to(roomId).emit('new_message', message);
    }

    res.json({
      success: true,
      data: message,
      message: 'Message sent successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Failed to send message'
    });
  }
});

// Update message status (delivered, read)
router.patch('/rooms/:roomId/messages/:messageId', async (req, res) => {
  try {
    const { roomId, messageId } = req.params;
    const { status } = req.body;

    const chatRoom = chatRooms.get(roomId);
    if (!chatRoom) {
      return res.status(404).json({
        success: false,
        error: 'Room not found',
        message: 'Chat room does not exist'
      });
    }

    const message = chatRoom.messages.find(msg => msg.id === messageId);
    if (!message) {
      return res.status(404).json({
        success: false,
        error: 'Message not found',
        message: 'Message does not exist'
      });
    }

    message.status = status;
    message.updatedAt = new Date();

    // Emit status update to WebSocket
    if (req.app.locals.io) {
      req.app.locals.io.to(roomId).emit('message_status_update', {
        messageId,
        status,
        timestamp: new Date()
      });
    }

    res.json({
      success: true,
      data: message,
      message: 'Message status updated successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Failed to update message status'
    });
  }
});

// Get user's active chat rooms
router.get('/users/:userId/rooms', async (req, res) => {
  try {
    const { userId } = req.params;
    const { status = 'active' } = req.query;

    const userRooms = Array.from(chatRooms.values()).filter(room => 
      room.userId === userId && room.status === status
    );

    // Enrich room data with officer information
    const enrichedRooms = userRooms.map(room => {
      const officer = onlineOfficers.get(room.officerId);
      return {
        ...room,
        officer: officer ? {
          id: officer.id,
          name: officer.name,
          avatar: officer.avatar,
          specialization: officer.specialization,
          isOnline: officer.isOnline
        } : null,
        unreadCount: room.messages.filter(msg => 
          msg.sender !== userId && msg.status !== 'read'
        ).length
      };
    });

    res.json({
      success: true,
      data: enrichedRooms,
      message: 'User chat rooms retrieved successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Failed to retrieve user chat rooms'
    });
  }
});

// End chat room
router.patch('/rooms/:roomId/end', async (req, res) => {
  try {
    const { roomId } = req.params;
    const { reason, rating, feedback } = req.body;

    const chatRoom = chatRooms.get(roomId);
    if (!chatRoom) {
      return res.status(404).json({
        success: false,
        error: 'Room not found',
        message: 'Chat room does not exist'
      });
    }

    chatRoom.status = 'ended';
    chatRoom.endedAt = new Date();
    chatRoom.endReason = reason;
    chatRoom.rating = rating;
    chatRoom.feedback = feedback;

    // Remove from officer's queue
    const officer = onlineOfficers.get(chatRoom.officerId);
    if (officer && officer.queue) {
      officer.queue = officer.queue.filter(item => item.roomId !== roomId);
    }

    // Emit room end to WebSocket
    if (req.app.locals.io) {
      req.app.locals.io.to(roomId).emit('room_ended', {
        roomId,
        reason,
        timestamp: new Date()
      });
    }

    res.json({
      success: true,
      data: chatRoom,
      message: 'Chat room ended successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Failed to end chat room'
    });
  }
});

// Get chat room statistics
router.get('/rooms/:roomId/stats', async (req, res) => {
  try {
    const { roomId } = req.params;

    const chatRoom = chatRooms.get(roomId);
    if (!chatRoom) {
      return res.status(404).json({
        success: false,
        error: 'Room not found',
        message: 'Chat room does not exist'
      });
    }

    const stats = {
      totalMessages: chatRoom.messages.length,
      userMessages: chatRoom.messages.filter(msg => msg.sender === chatRoom.userId).length,
      officerMessages: chatRoom.messages.filter(msg => msg.sender === chatRoom.officerId).length,
      filesShared: chatRoom.messages.filter(msg => msg.type === 'file').length,
      averageResponseTime: calculateAverageResponseTime(chatRoom.messages),
      sessionDuration: chatRoom.endedAt ? 
        Math.round((chatRoom.endedAt - chatRoom.createdAt) / 1000 / 60) : 
        Math.round((Date.now() - chatRoom.createdAt) / 1000 / 60)
    };

    res.json({
      success: true,
      data: stats,
      message: 'Chat room statistics retrieved successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Failed to retrieve chat room statistics'
    });
  }
});

// Helper function to calculate average response time
function calculateAverageResponseTime(messages) {
  if (messages.length < 2) return 0;

  let totalResponseTime = 0;
  let responseCount = 0;

  for (let i = 1; i < messages.length; i++) {
    const currentMessage = messages[i];
    const previousMessage = messages[i - 1];

    if (currentMessage.sender !== previousMessage.sender) {
      const responseTime = currentMessage.timestamp - previousMessage.timestamp;
      totalResponseTime += responseTime;
      responseCount++;
    }
  }

  return responseCount > 0 ? Math.round(totalResponseTime / responseCount / 1000) : 0;
}

// WebSocket connection handler (to be used in main app)
function setupWebSocket(io) {
  io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Join chat room
    socket.on('join_room', (roomId) => {
      socket.join(roomId);
      console.log(`User ${socket.id} joined room: ${roomId}`);
    });

    // Leave chat room
    socket.on('leave_room', (roomId) => {
      socket.leave(roomId);
      console.log(`User ${socket.id} left room: ${roomId}`);
    });

    // Typing indicator
    socket.on('typing_start', (data) => {
      socket.to(data.roomId).emit('user_typing', {
        userId: data.userId,
        isTyping: true
      });
    });

    socket.on('typing_stop', (data) => {
      socket.to(data.roomId).emit('user_typing', {
        userId: data.userId,
        isTyping: false
      });
    });

    // Disconnect
    socket.on('disconnect', () => {
      console.log('User disconnected:', socket.id);
    });
  });
}

module.exports = { router, setupWebSocket, chatRooms, onlineOfficers }; 