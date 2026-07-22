const OpenAI = require('openai');
const { chatComplete } = require('../../services/openaiService');
const catchAsync = require('../../utills/catchAsync');
const AppError = require('../../utills/appError');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const VisaApplication = require('../../model/schema/visaApplication');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Helper function to save chat message to database
const saveChatMessage = async (chatSession, messageData) => {
  try {
    // For now, we'll use the user ID from the chat session to find the application
    // In the future, we could store applicationId in the chat session
    const userSocketId = chatSession.user;
    
    // Skip saving if we don't have a valid user ID (socket IDs are not valid ObjectIds)
    if (!chatSession.userId || chatSession.userId.length !== 24) {
      console.log(`[CHAT HISTORY] Skipping save - invalid user ID: ${chatSession.userId}`);
      return;
    }
    
    // Find the most recent application for this user (this is a simplified approach)
    // In production, you'd want to associate chat sessions with specific applications
    const application = await VisaApplication.findOne({ 
      'sponsor.userId': chatSession.userId 
    }).sort({ createdAt: -1 });
    
    if (application) {
      application.metadata.chatHistory.push({
        type: messageData.sender === 'user' ? 'user' : 'amer',
        content: messageData.content,
        timestamp: new Date(messageData.timestamp),
        userId: messageData.sender === 'user' ? chatSession.userId : chatSession.officerId
      });
      
      await application.save();
      console.log(`[CHAT HISTORY] Saved message to application ${application._id}`);
    } else {
      console.log(`[CHAT HISTORY] No application found for user ${chatSession.userId || userSocketId}`);
    }
  } catch (error) {
    console.error('[CHAT HISTORY] Error saving message:', error);
    // Don't throw error to avoid breaking chat functionality
  }
};

// Helper function to load chat history for a user
const loadChatHistory = async (userId) => {
  try {
    const application = await VisaApplication.findOne({ 
      'sponsor.userId': userId 
    }).sort({ createdAt: -1 });
    
    if (application && application.metadata.chatHistory) {
      return application.metadata.chatHistory.map(msg => ({
        id: msg._id?.toString() || Date.now().toString(),
        type: msg.type,
        content: msg.content,
        sender: msg.type === 'user' ? 'user' : 'amer',
        timestamp: msg.timestamp.toISOString(),
        chatId: 'history'
      }));
    }
    
    return [];
  } catch (error) {
    console.error('[CHAT HISTORY] Error loading history:', error);
    return [];
  }
};

exports.processMessage = catchAsync(async (req, res, next) => {
  const { message, context } = req.body;

  if (!message) {
    return next(new AppError('Message is required', 400));
  }

  // Construct system message based on context
  let systemMessage = 'You are a helpful AI assistant for UAE visa applications. ';
  
  if (context.service) {
    systemMessage += `The user is currently applying for a ${context.service.name}. `;
  }

  if (context.step === 1) {
    systemMessage += 'The user is at the document upload stage. Help them understand which documents are required and guide them through the process. ';
  } else if (context.step === 2) {
    systemMessage += 'The user is providing personal information. Help them understand what information is needed and why. ';
  }

  if (context.documents?.length > 0) {
    systemMessage += `The user has already uploaded: ${context.documents.join(', ')}. `;
  }

  try {
    const { content: response } = await chatComplete([
      { role: 'system', content: systemMessage },
      { role: 'user', content: message }
    ], { model: 'gpt-4-turbo-preview', temperature: 0.7, max_tokens: 500 });

    // Extract potential actions from AI response
    const actions = [];
    const safeResponse = response || 'I am temporarily unavailable. Please try again shortly.';

    // Check for document requests in the response
    if (safeResponse.toLowerCase().includes('upload') || safeResponse.toLowerCase().includes('document')) {
      actions.push({ type: 'REQUEST_DOCUMENT' });
    }

    // Check for Amer officer requests
    if (safeResponse.toLowerCase().includes('amer officer') || safeResponse.toLowerCase().includes('human assistance')) {
      actions.push({ type: 'CONNECT_AMER' });
    }

    res.status(200).json({
      status: 'success',
      response: safeResponse,
      actions
    });
  } catch (error) {
    console.error('OpenAI API Error:', error);
    return next(new AppError('AI is temporarily unavailable. Please try again shortly.', 503));
  }
});

// Streaming AI chat endpoint
exports.streamMessage = catchAsync(async (req, res, next) => {
  const { message, context, chatHistory = [] } = req.body;

  if (!message) {
    return next(new AppError('Message is required', 400));
  }

  // Set headers for Server-Sent Events
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Cache-Control');

  // Construct system message based on context
  let systemMessage = 'You are a helpful AI assistant for UAE visa applications. You provide accurate, helpful information about visa processes, document requirements, and application procedures. ';

  if (context?.service) {
    systemMessage += `The user is currently applying for a ${context.service.name}. `;
  }

  if (context?.step === 1) {
    systemMessage += 'The user is at the document upload stage. Help them understand which documents are required and guide them through the process. ';
  } else if (context?.step === 2) {
    systemMessage += 'The user is providing personal information. Help them understand what information is needed and why. ';
  }

  if (context?.documents?.length > 0) {
    systemMessage += `The user has already uploaded: ${context.documents.join(', ')}. `;
  }

  try {
    // Prepare messages for OpenAI
    const messages = [
      { role: 'system', content: systemMessage }
    ];

    // Add chat history
    if (chatHistory && chatHistory.length > 0) {
      chatHistory.forEach(msg => {
        messages.push({
          role: msg.type === 'user' ? 'user' : 'assistant',
          content: msg.content
        });
      });
    }

    // Add current message
    messages.push({ role: 'user', content: message });

    // Send connected event
    res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);

    // Create streaming response
    const stream = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: messages,
      stream: true,
      temperature: 0.7,
      max_tokens: 1000
    });

    let fullResponse = '';
    let actions = [];

    // Process streaming chunks
    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        fullResponse += content;

        // Send content chunk
        res.write(`data: ${JSON.stringify({
          type: 'content',
          content: content,
          timestamp: new Date().toISOString()
        })}\n\n`);
      }
    }

    // Check for actions in the full response
    if (fullResponse.toLowerCase().includes('upload') || fullResponse.toLowerCase().includes('document')) {
      actions.push({ type: 'REQUEST_DOCUMENT' });
    }

    if (fullResponse.toLowerCase().includes('amer officer') || fullResponse.toLowerCase().includes('human assistance')) {
      actions.push({ type: 'CONNECT_AMER' });
    }

    // Send completion event
    res.write(`data: ${JSON.stringify({
      type: 'complete',
      fullResponse: fullResponse,
      actions: actions,
      timestamp: new Date().toISOString()
    })}\n\n`);

    // End the stream
    res.write(`data: [DONE]\n\n`);
    res.end();

  } catch (error) {
    console.error('Streaming AI Error:', error);

    // Send error event
    res.write(`data: ${JSON.stringify({
      type: 'error',
      error: 'AI is temporarily unavailable. Please try again shortly.',
      timestamp: new Date().toISOString()
    })}\n\n`);

    res.end();
  }
});

// Chat file upload (store server-side and return URL)
const chatStorage = multer.diskStorage({
  destination: function(req, file, cb) {
    try {
      const roomId = req.body.roomId || req.query.roomId || 'general'
      const dest = path.join(__dirname, '../../uploads/chat', roomId)
      fs.mkdirSync(dest, { recursive: true })
      cb(null, dest)
    } catch (e) {
      cb(e)
    }
  },
  filename: function(req, file, cb) {
    const unique = Date.now() + '-' + Math.round(Math.random()*1e9)
    const safeBase = (file.originalname || 'file').replace(/[^a-zA-Z0-9_.-]/g, '_')
    cb(null, unique + '-' + safeBase)
  }
})

const chatFileFilter = (req, file, cb) => {
  if (file.mimetype.startsWith('image/') || file.mimetype === 'application/pdf' || file.mimetype === 'text/plain') {
    cb(null, true)
  } else {
    cb(new AppError('Unsupported file type', 400), false)
  }
}

const chatUpload = multer({ storage: chatStorage, fileFilter: chatFileFilter, limits: { fileSize: 20 * 1024 * 1024 } })

exports.chatUploadMiddleware = chatUpload.single('file')

exports.uploadChatFile = catchAsync(async (req, res, next) => {
  if (!req.file) {
    return next(new AppError('No file uploaded', 400))
  }
  const roomId = req.query.roomId || 'general'
  const fileUrl = `/uploads/chat/${roomId}/${req.file.filename}`
  res.status(200).json({ status: 'success', data: { fileUrl, fileName: req.file.originalname, size: req.file.size } })
})

exports.handleWebSocket = (io) => {
  // Store available Amer officers
  const amerOfficers = new Map();
  // Store active chats
  const activeChats = new Map();
  // Store user connections
  const userConnections = new Map();
  
  // Debug function
  const debugLog = (message, data = null) => {
    console.log(`[WEBSOCKET DEBUG] ${message}`, data ? JSON.stringify(data, null, 2) : '');
  };

  io.on('connection', (socket) => {
    console.log('New client connected:', socket.id);

    // Handle Amer officer registration
    socket.on('register_amer', (data) => {
      debugLog('Officer registering', data);
      amerOfficers.set(socket.id, {
        id: socket.id,
        name: data.name || 'Amer Officer',
        available: true,
        userId: data.userId || socket.id,
        userData: data.userData || {}
      });
      
      // Notify all users that an officer is available
      io.emit('officer_available', {
        officerId: socket.id,
        name: data.name || 'Amer Officer',
        timestamp: new Date().toISOString()
      });
      
      debugLog('Officer registered successfully', { officerId: socket.id, name: data.name });
    });

    // Handle Amer officer connection requests
    socket.on('request_amer_connection', async (data) => {
      debugLog('User requesting Amer officer connection', data);
      
      // Store user connection info
      userConnections.set(socket.id, {
        id: socket.id,
        userId: data.userId || socket.id,
        userData: data.userData || {},
        service: data.service,
        connectedAt: new Date()
      });
      
      // Find available officers
      const availableOfficers = Array.from(amerOfficers.values())
        .filter(officer => officer.available);

      if (availableOfficers.length === 0) {
        debugLog('No officers available');
        socket.emit('no_officers_available', { 
          message: 'No Amer officers are currently available. Please try again later.',
          timestamp: new Date().toISOString()
        });
        return;
      }

      // Create a pending request
      const requestId = Date.now().toString();
      const request = {
        id: requestId,
        userId: socket.id,
        service: data.service,
        timestamp: new Date().toISOString(),
        status: 'pending',
        userData: data.userData || {}
      };

      // Send request to all available officers
      availableOfficers.forEach(officer => {
        debugLog(`Sending request to officer ${officer.id}`, { requestId, officerName: officer.name });
        io.to(officer.id).emit('officer_request', {
          requestId,
          userInfo: {
            id: socket.id,
            userId: data.userId || socket.id,
            service: data.service,
            userName: data.userData?.name || 'User',
            timestamp: request.timestamp
          },
          message: `New assistance request for ${data.service || 'visa application'}`
        });
      });

      // Notify user that request was sent
      socket.emit('request_sent', {
        requestId,
        message: 'Request sent to available officers. Please wait for an officer to accept.',
        officersCount: availableOfficers.length,
        timestamp: request.timestamp
      });

      // Store the pending request
      if (!socket.pendingRequests) socket.pendingRequests = new Map();
      socket.pendingRequests.set(requestId, request);
      
      debugLog('Request sent to officers', { requestId, officersCount: availableOfficers.length });
    });

    // Handle officer accepting a request
    socket.on('officer_accept_request', async (data) => {
      const { requestId } = data;
      debugLog('Officer accepting request', { requestId, officerId: socket.id });

      // Find the user who made the request
      let requestingSocket = null;
      let request = null;

      for (const [socketId, clientSocket] of io.sockets.sockets) {
        if (clientSocket.pendingRequests && clientSocket.pendingRequests.has(requestId)) {
          requestingSocket = clientSocket;
          request = clientSocket.pendingRequests.get(requestId);
          break;
        }
      }

      if (!requestingSocket || !request) {
        debugLog('Request not found or expired', { requestId });
        socket.emit('request_expired', { 
          message: 'This request is no longer available.',
          requestId 
        });
        return;
      }

        // Create chat session
      const chatId = `chat_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const officerInfo = amerOfficers.get(socket.id);
      
      if (!officerInfo) {
        debugLog('Officer not registered', { socketId: socket.id });
        socket.emit('officer_not_registered', { 
          message: 'Please register as an officer first.' 
        });
        return;
      }

      // Create active chat
      const chatSession = {
        id: chatId,
        user: requestingSocket.id,
        officer: socket.id,
        userId: request.userId,
        officerId: officerInfo.userId,
        service: request.service,
        startTime: new Date().toISOString(),
        requestId,
        messages: []
      };
      activeChats.set(chatId, chatSession);
      
      debugLog('Chat session created and stored', { 
        chatId, 
        storedChatId: activeChats.get(chatId)?.id,
        totalActiveChats: activeChats.size,
        allChatIds: Array.from(activeChats.keys())
      });

      // Load chat history for the user
      try {
        const chatHistory = await loadChatHistory(request.userId);
        if (chatHistory.length > 0) {
          chatSession.messages = [...chatHistory, ...chatSession.messages];
          
          // Send chat history to both parties
          const historyPayload = {
            chatId,
            history: chatHistory,
            message: `Previous chat history loaded (${chatHistory.length} messages)`
          };
          
          requestingSocket.emit('chat_history_loaded', historyPayload);
          socket.emit('chat_history_loaded', historyPayload);
          
          debugLog(`Loaded ${chatHistory.length} messages from chat history for user ${request.userId}`);
        }
      } catch (error) {
        debugLog('Error loading chat history:', error);
      }

      // Mark officer as busy
      amerOfficers.get(socket.id).available = false;

      // Join both parties to the chat room
      requestingSocket.join(chatId);
      socket.join(chatId);

      // Notify user that officer accepted
      requestingSocket.emit('amer_connected', { 
        chatId, 
        officerName: officerInfo.name,
        officerId: socket.id,
        message: `${officerInfo.name} has joined the conversation`,
        timestamp: new Date().toISOString()
      });

      // Notify officer that chat started
      socket.emit('chat_session_started', { 
        chatId, 
        userService: request.service,
        userId: requestingSocket.id,
        userName: request.userData?.name || 'User',
        timestamp: new Date().toISOString()
      });

      // Notify other officers that request was accepted
      const otherOfficers = Array.from(amerOfficers.keys()).filter(id => id !== socket.id);
      otherOfficers.forEach(officerId => {
        io.to(officerId).emit('request_taken', { 
          requestId,
          takenBy: officerInfo.name 
        });
      });

      // Clean up pending request
      requestingSocket.pendingRequests.delete(requestId);

      debugLog('Chat session started', { 
        chatId, 
        userId: requestingSocket.id, 
        officerId: socket.id,
        officerName: officerInfo.name 
      });
    });

    // Handle officer declining a request
    socket.on('officer_decline_request', async (data) => {
      const { requestId, reason } = data;
      console.log('Officer declining request:', requestId, reason);

      socket.emit('request_declined', { 
        requestId,
        message: 'Request declined successfully.',
        timestamp: new Date().toISOString()
      });
    });

    // Legacy support for direct chat requests
    socket.on('request_amer', async (data) => {
      // Redirect to new flow
      socket.emit('use_new_flow', { 
        message: 'Please use the updated officer request system.',
        action: 'request_amer_connection'
      });
    });

    // Handle chat messages
    socket.on('chat_message', async (data) => {
      debugLog('Received chat message', data);
      debugLog('Active chats available', Array.from(activeChats.keys()));
      debugLog('Socket ID', socket.id);
      
      const { message, chatId, type = 'text' } = data;
      
      if (!message || !chatId) {
        debugLog('Invalid message data', { message, chatId });
        socket.emit('message_error', { 
          error: 'Message and chatId are required',
          chatId 
        });
        return;
      }
      
      // Find the chat session
      const chat = activeChats.get(chatId);
      
      if (!chat) {
        // Try alternative lookup by socket ID
        const chatBySocket = Array.from(activeChats.values())
          .find(chat => chat.user === socket.id || chat.officer === socket.id);
          
        debugLog('Chat lookup failed', { 
          chatId, 
          availableChats: Array.from(activeChats.keys()),
          socketId: socket.id,
          foundBySocket: chatBySocket ? chatBySocket.id : null
        });
        
        socket.emit('message_error', { 
          error: 'No active chat session found',
          chatId,
          availableChats: Array.from(activeChats.keys())
        });
        return;
      }

      // Verify the sender is part of this chat
      if (chat.user !== socket.id && chat.officer !== socket.id) {
        debugLog('Sender not authorized for this chat', { senderId: socket.id, chatId });
        socket.emit('message_error', { 
          error: 'Not authorized for this chat session',
          chatId 
        });
        return;
      }

      // Determine message type and target
      const isUser = socket.id === chat.user;
      const targetId = isUser ? chat.officer : chat.user;
      const messageType = isUser ? 'user' : 'amer';

      debugLog(`Routing message from ${isUser ? 'user' : 'officer'} to ${isUser ? 'officer' : 'user'}`, { 
        chatId, 
        senderId: socket.id, 
        targetId, 
        messageType 
      });

      // Create message data
      const messageData = {
        id: Date.now().toString(),
        type: messageType,
        content: message,
        sender: isUser ? 'user' : 'amer',
        timestamp: new Date().toISOString(),
        chatId: chatId,
        metadata: { roomId: chatId }
      };

      // Store message in chat session
      chat.messages = chat.messages || [];
      chat.messages.push(messageData);

      // Save message to database for history
      await saveChatMessage(chat, messageData);

      // Send message to the other party
      if (targetId) {
        debugLog(`Sending message to ${targetId}`, messageData);
        io.to(targetId).emit('new_message', messageData);
      }

      // Send confirmation back to sender
      socket.emit('message_sent', {
        id: messageData.id,
        type: messageType,
        content: message,
        timestamp: messageData.timestamp,
        chatId: chatId
      });

      debugLog(`Message delivered from ${socket.id} to ${targetId}`, { messageId: messageData.id });
    });

    // Handle legacy send_message for backward compatibility
    socket.on('send_message', (data) => {
      console.log('Received legacy send_message:', data);
      
      // Convert to new format
      const { roomId, message, userId } = data;
      
      // Find chat by roomId or create a simple mapping
      const chat = activeChats.get(roomId) || 
        Array.from(activeChats.values())
        .find(chat => chat.user === socket.id || chat.officer === socket.id);

      if (chat) {
        // Forward to new handler
        socket.emit('chat_message', {
          message: message,
          chatId: roomId || chat.id,
          type: 'text'
        });
      } else {
        console.log('No chat found for legacy message');
        socket.emit('message_error', { 
          error: 'No active chat session found',
          roomId 
        });
      }
    });

    // Handle request cancellation
    socket.on('cancel_request', (data) => {
      const { requestId } = data;
      console.log('User cancelling request:', requestId);

      if (socket.pendingRequests && socket.pendingRequests.has(requestId)) {
        socket.pendingRequests.delete(requestId);
        
        // Notify all officers that request was cancelled
        Array.from(amerOfficers.keys()).forEach(officerId => {
          io.to(officerId).emit('request_cancelled', { requestId });
        });

        socket.emit('request_cancelled_confirmed', { 
          requestId,
          message: 'Request cancelled successfully.' 
        });
      }
    });

    // Handle file uploads
    socket.on('file_upload_complete', async (data) => {
      debugLog('File upload complete', data);
      
      const { chatId, fileUrl, fileName, fileSize, fileType } = data;
      
      // Find the chat session
      const chat = activeChats.get(chatId) || 
        Array.from(activeChats.values())
          .find(chat => chat.user === socket.id || chat.officer === socket.id);

      if (!chat) {
        debugLog('No active chat found for file upload', { chatId });
        socket.emit('message_error', { 
          error: 'No active chat session found',
          chatId 
        });
        return;
      }

      // Verify the sender is part of this chat
      if (chat.user !== socket.id && chat.officer !== socket.id) {
        debugLog('Sender not authorized for file upload', { senderId: socket.id, chatId });
        socket.emit('message_error', { 
          error: 'Not authorized for this chat session',
          chatId 
        });
        return;
      }

      // Determine message type and target
      const isUser = socket.id === chat.user;
      const targetId = isUser ? chat.officer : chat.user;
      const messageType = isUser ? 'user' : 'amer';

      // Create file message data
      const messageData = {
        id: Date.now().toString(),
        type: 'file',
        content: 'File shared',
        sender: isUser ? 'user' : 'amer',
        timestamp: new Date().toISOString(),
        chatId: chatId,
        metadata: { 
          roomId: chatId,
          fileUrl,
          fileName,
          fileSize,
          fileType
        }
      };

      // Store message in chat session
      chat.messages = chat.messages || [];
      chat.messages.push(messageData);

      // Save message to database for history
      await saveChatMessage(chat, messageData);

      // Send file message to the other party
      if (targetId) {
        debugLog(`Sending file message to ${targetId}`, messageData);
        io.to(targetId).emit('new_message', messageData);
      }

      // Send confirmation back to sender
      socket.emit('message_sent', {
        id: messageData.id,
        type: messageType,
        content: 'File shared',
        timestamp: messageData.timestamp,
        chatId: chatId
      });

      debugLog(`File message delivered from ${socket.id} to ${targetId}`, { messageId: messageData.id });
    });

    // Handle fast OTP sharing
    socket.on('share_otp', (data) => {
      const { roomId, otp, expiresIn, recipientType } = data;
      debugLog('OTP shared', { roomId, expiresIn, recipientType });
      
      // Find the chat session
      const chat = activeChats.get(roomId) || 
        Array.from(activeChats.values())
          .find(chat => chat.user === socket.id || chat.officer === socket.id);

      if (chat) {
        const isUser = socket.id === chat.user;
        const targetId = isUser ? chat.officer : chat.user;
        
        // Send OTP to the target
        if (targetId) {
          io.to(targetId).emit('otp_received', {
            otp,
            expiresIn,
            fromType: isUser ? 'user' : 'officer',
            roomId,
            timestamp: new Date().toISOString()
          });
          
          // Send confirmation to sender
          socket.emit('otp_shared', {
            success: true,
            roomId,
            timestamp: new Date().toISOString()
          });
          
          debugLog('OTP delivered', { fromSocket: socket.id, toSocket: targetId });
        }
      } else {
        socket.emit('otp_share_error', { 
          error: 'No active chat session found',
          roomId 
        });
      }
    });

    // Handle UAE Pass integration requests
    socket.on('request_uae_pass_access', (data) => {
      const { service, permissions, roomId } = data;
      debugLog('UAE Pass access requested', { service, permissions, roomId });
      
      // For now, emit a placeholder response
      // In production, this would integrate with UAE Pass API
      socket.emit('uae_pass_response', {
        status: 'pending',
        service,
        permissions,
        authUrl: 'https://uaepass.ae/auth', // Placeholder
        message: 'UAE Pass integration coming soon',
        timestamp: new Date().toISOString()
      });
    });

    // Handle typing indicators
    socket.on('typing_start', (data) => {
      const { roomId, userId } = data;
      
      // Find the chat session
      const chat = activeChats.get(roomId) || 
        Array.from(activeChats.values())
          .find(chat => chat.user === socket.id || chat.officer === socket.id);

      if (chat) {
        const isUser = socket.id === chat.user;
        const targetId = isUser ? chat.officer : chat.user;
        
        if (targetId) {
          io.to(targetId).emit('user_typing', {
            roomId,
            isTyping: true,
            userId: isUser ? 'user' : 'officer',
            timestamp: new Date().toISOString()
          });
        }
      }
    });

    socket.on('typing_stop', (data) => {
      const { roomId, userId } = data;
      
      // Find the chat session
      const chat = activeChats.get(roomId) || 
        Array.from(activeChats.values())
          .find(chat => chat.user === socket.id || chat.officer === socket.id);

      if (chat) {
        const isUser = socket.id === chat.user;
        const targetId = isUser ? chat.officer : chat.user;
        
        if (targetId) {
          io.to(targetId).emit('user_typing', {
            roomId,
            isTyping: false,
            userId: isUser ? 'user' : 'officer',
            timestamp: new Date().toISOString()
          });
        }
      }
    });

    // Handle government portal access requests
    socket.on('request_portal_access', (data) => {
      const { portal, requestType, roomId } = data;
      debugLog('Government portal access requested', { portal, requestType, roomId });
      
      // Placeholder for government portal integration
      const supportedPortals = {
        'mohre': 'Ministry of Human Resources and Emiratisation',
        'gdrfa': 'General Directorate of Residency and Foreigners Affairs',
        'ica': 'Immigration and Checkpoints Authority',
        'dubai_police': 'Dubai Police',
        'adnic': 'Abu Dhabi National Insurance Company'
      };
      
      if (supportedPortals[portal]) {
        socket.emit('portal_access_response', {
          status: 'authorized',
          portal,
          portalName: supportedPortals[portal],
          accessToken: 'temp_token_' + Date.now(), // Placeholder
          expiresIn: 3600,
          message: `Access granted to ${supportedPortals[portal]}`,
          timestamp: new Date().toISOString()
        });
      } else {
        socket.emit('portal_access_error', {
          error: 'Unsupported portal',
          portal,
          supportedPortals: Object.keys(supportedPortals),
          timestamp: new Date().toISOString()
        });
      }
    });

    // Handle disconnections
    socket.on('disconnect', async () => {
      debugLog('Client disconnected', { socketId: socket.id });

      // Clean up officer registration
      if (amerOfficers.has(socket.id)) {
        const officerInfo = amerOfficers.get(socket.id);
        debugLog('Officer disconnected', { officerName: officerInfo?.name });
        amerOfficers.delete(socket.id);
        
        // Notify all users that officer is no longer available
        io.emit('officer_unavailable', {
          officerId: socket.id,
          message: 'Officer is no longer available',
          timestamp: new Date().toISOString()
        });
      }

      // Clean up user connection
      if (userConnections.has(socket.id)) {
        userConnections.delete(socket.id);
      }

      // Clean up pending requests
      if (socket.pendingRequests) {
        for (const [requestId] of socket.pendingRequests) {
          // Notify officers that request is no longer valid
          Array.from(amerOfficers.keys()).forEach(officerId => {
            io.to(officerId).emit('request_cancelled', { requestId, reason: 'User disconnected' });
          });
        }
        socket.pendingRequests.clear();
      }

      // Clean up active chats but preserve chat history
      for (const [chatId, chat] of activeChats.entries()) {
        if (chat.user === socket.id || chat.officer === socket.id) {
          // Save a disconnection message to chat history
          const disconnectionMessage = {
            id: Date.now().toString(),
            type: 'system',
            content: socket.id === chat.user ? 'User disconnected from chat' : 'Officer disconnected from chat',
            sender: 'system',
            timestamp: new Date().toISOString(),
            chatId: chatId
          };
          
          // Save disconnection message to database
          await saveChatMessage(chat, disconnectionMessage);
          
          // Notify other party
          const otherId = socket.id === chat.user ? chat.officer : chat.user;
          io.to(otherId).emit('chat_ended', { 
            chatId, 
            reason: socket.id === chat.user ? 'User disconnected' : 'Officer disconnected',
            timestamp: new Date().toISOString(),
            canReconnect: true,
            message: 'The other party has disconnected. Chat history has been saved.'
          });

          // Free up officer if they were in this chat (but keep them registered)
          if (chat.officer === socket.id && amerOfficers.has(chat.officer)) {
            amerOfficers.get(chat.officer).available = true;
          }

          // Remove from active chats (but history is preserved in database)
          activeChats.delete(chatId);
          debugLog(`Chat session ended due to disconnection`, { 
            chatId, 
            reason: socket.id === chat.user ? 'User disconnected' : 'Officer disconnected',
            messagesSaved: chat.messages?.length || 0
          });
        }
      }
    });
  });
};