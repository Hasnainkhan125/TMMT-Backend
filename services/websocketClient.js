/**
 * QUMAK WebSocket Client Library
 * Enterprise-grade WebSocket client for real-time communication
 * 
 * Features:
 * - Automatic reconnection with exponential backoff
 * - Event-driven architecture
 * - Rate limiting and error handling
 * - Connection health monitoring
 * - Type-safe message handling
 * - Built-in authentication
 */

class QumakWebSocketClient {
  constructor(config = {}) {
    this.config = {
      url: config.url || 'ws://localhost:3000/ws',
      token: config.token || null,
      autoReconnect: config.autoReconnect !== false,
      reconnectAttempts: config.reconnectAttempts || 10,
      reconnectInterval: config.reconnectInterval || 1000,
      heartbeatInterval: config.heartbeatInterval || 30000,
      connectionTimeout: config.connectionTimeout || 10000,
      ...config
    };

    // Connection state
    this.ws = null;
    this.connected = false;
    this.connecting = false;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.connectionTimer = null;

    // Event system
    this.events = new Map();
    this.messageQueue = [];
    this.maxQueueSize = 100;

    // Connection metrics
    this.metrics = {
      messagesSent: 0,
      messagesReceived: 0,
      errors: 0,
      reconnections: 0,
      lastActivity: null,
      connectionStartTime: null
    };

    // Rate limiting
    this.rateLimits = {
      messagesPerMinute: 60,
      messageCount: 0,
      lastMessageTime: Date.now()
    };

    // Room management
    this.rooms = new Set();
    this.currentVoiceCall = null;

    // Bind methods
    this.handleMessage = this.handleMessage.bind(this);
    this.handleOpen = this.handleOpen.bind(this);
    this.handleClose = this.handleClose.bind(this);
    this.handleError = this.handleError.bind(this);
    this.startHeartbeat = this.startHeartbeat.bind(this);
    this.stopHeartbeat = this.stopHeartbeat.bind(this);
    this.sendHeartbeat = this.sendHeartbeat.bind(this);
    this.checkRateLimit = this.checkRateLimit.bind(this);
    this.queueMessage = this.queueMessage.bind(this);
    this.processQueue = this.processQueue.bind(this);

    // Auto-connect if token is provided
    if (this.config.token) {
      this.connect();
    }
  }

  /**
   * Connect to WebSocket server
   */
  connect() {
    if (this.connected || this.connecting) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      try {
        this.connecting = true;
        this.connectionTimer = setTimeout(() => {
          this.connecting = false;
          reject(new Error('Connection timeout'));
        }, this.config.connectionTimeout);

        const url = `${this.config.url}?token=${encodeURIComponent(this.config.token)}`;
        this.ws = new WebSocket(url);

        this.ws.onopen = () => {
          this.handleOpen();
          resolve();
        };

        this.ws.onclose = this.handleClose;
        this.ws.onerror = this.handleError;
        this.ws.onmessage = this.handleMessage;

      } catch (error) {
        this.connecting = false;
        reject(error);
      }
    });
  }

  /**
   * Disconnect from WebSocket server
   */
  disconnect() {
    this.config.autoReconnect = false;
    
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.connectionTimer) {
      clearTimeout(this.connectionTimer);
      this.connectionTimer = null;
    }

    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }

    this.connected = false;
    this.connecting = false;
    this.rooms.clear();
    this.currentVoiceCall = null;
  }

  /**
   * Handle connection open
   */
  handleOpen() {
    this.connected = true;
    this.connecting = false;
    this.reconnectAttempts = 0;
    this.metrics.connectionStartTime = Date.now();
    this.metrics.lastActivity = Date.now();

    if (this.connectionTimer) {
      clearTimeout(this.connectionTimer);
      this.connectionTimer = null;
    }

    // Start heartbeat
    this.startHeartbeat();

    // Process queued messages
    this.processQueue();

    // Emit connection event
    this.emit('connected', {
      timestamp: new Date(),
      url: this.config.url
    });

    console.log('🔌 WebSocket connected successfully');
  }

  /**
   * Handle connection close
   */
  handleClose(event) {
    this.connected = false;
    this.connecting = false;
    this.stopHeartbeat();

    // Emit disconnection event
    this.emit('disconnected', {
      code: event.code,
      reason: event.reason,
      wasClean: event.wasClean,
      timestamp: new Date()
    });

    console.log(`🔌 WebSocket disconnected: ${event.code} - ${event.reason}`);

    // Auto-reconnect if enabled
    if (this.config.autoReconnect && event.code !== 1000) {
      this.scheduleReconnect();
    }
  }

  /**
   * Handle connection errors
   */
  handleError(error) {
    this.metrics.errors++;
    
    this.emit('error', {
      error: error.message || 'Unknown error',
      timestamp: new Date()
    });

    console.error('WebSocket error:', error);
  }

  /**
   * Schedule reconnection attempt
   */
  scheduleReconnect() {
    if (this.reconnectAttempts >= this.config.reconnectAttempts) {
      this.emit('reconnect_failed', {
        attempts: this.reconnectAttempts,
        timestamp: new Date()
      });
      return;
    }

    const delay = this.config.reconnectInterval * Math.pow(2, this.reconnectAttempts);
    this.reconnectAttempts++;

    this.emit('reconnecting', {
      attempt: this.reconnectAttempts,
      delay,
      timestamp: new Date()
    });

    this.reconnectTimer = setTimeout(() => {
      this.connect().catch(error => {
        console.error('Reconnection failed:', error);
        this.scheduleReconnect();
      });
    }, delay);
  }

  /**
   * Start heartbeat monitoring
   */
  startHeartbeat() {
    this.heartbeatTimer = setInterval(() => {
      if (this.connected) {
        this.sendHeartbeat();
      }
    }, this.config.heartbeatInterval);
  }

  /**
   * Stop heartbeat monitoring
   */
  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Send heartbeat ping
   */
  sendHeartbeat() {
    this.send({
      type: 'ping',
      timestamp: Date.now()
    });
  }

  /**
   * Check rate limiting
   */
  checkRateLimit() {
    const now = Date.now();
    const timeWindow = 60000; // 1 minute

    if (now - this.rateLimits.lastMessageTime > timeWindow) {
      this.rateLimits.messageCount = 1;
      this.rateLimits.lastMessageTime = now;
      return true;
    }

    if (this.rateLimits.messageCount >= this.rateLimits.messagesPerMinute) {
      return false;
    }

    this.rateLimits.messageCount++;
    return true;
  }

  /**
   * Queue message for later sending
   */
  queueMessage(message) {
    if (this.messageQueue.length >= this.maxQueueSize) {
      this.messageQueue.shift(); // Remove oldest message
    }
    this.messageQueue.push(message);
  }

  /**
   * Process queued messages
   */
  processQueue() {
    while (this.messageQueue.length > 0 && this.connected) {
      const message = this.messageQueue.shift();
      this.sendRaw(message);
    }
  }

  /**
   * Send message to server
   */
  send(data) {
    if (!this.checkRateLimit()) {
      this.emit('rate_limit_exceeded', {
        message: 'Rate limit exceeded. Please wait before sending more messages.',
        timestamp: new Date()
      });
      return false;
    }

    if (this.connected) {
      return this.sendRaw(data);
    } else {
      this.queueMessage(data);
      return false;
    }
  }

  /**
   * Send raw message to server
   */
  sendRaw(data) {
    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        const message = JSON.stringify({
          ...data,
          timestamp: data.timestamp || Date.now()
        });

        this.ws.send(message);
        this.metrics.messagesSent++;
        this.metrics.lastActivity = Date.now();

        return true;
      }
    } catch (error) {
      this.metrics.errors++;
      this.emit('error', {
        error: 'Failed to send message',
        details: error.message,
        timestamp: new Date()
      });
    }

    return false;
  }

  /**
   * Handle incoming messages
   */
  handleMessage(event) {
    try {
      const data = JSON.parse(event.data);
      this.metrics.messagesReceived++;
      this.metrics.lastActivity = Date.now();

      // Handle system messages
      switch (data.type) {
        case 'connection':
          this.handleConnectionMessage(data);
          break;
        case 'room_joined':
          this.handleRoomJoined(data);
          break;
        case 'room_left':
          this.handleRoomLeft(data);
          break;
        case 'voice_call_started':
          this.handleVoiceCallStarted(data);
          break;
        case 'voice_call_created':
          this.handleVoiceCallCreated(data);
          break;
        case 'call_ended':
          this.handleCallEnded(data);
          break;
        case 'pong':
          this.handlePong(data);
          break;
        case 'error':
          this.handleServerError(data);
          break;
        default:
          // Emit custom message event
          this.emit('message', data);
      }

      // Emit type-specific events
      this.emit(data.type, data);

    } catch (error) {
      this.metrics.errors++;
      this.emit('error', {
        error: 'Failed to parse message',
        details: error.message,
        timestamp: new Date()
      });
    }
  }

  /**
   * Handle connection message
   */
  handleConnectionMessage(data) {
    if (data.server && data.server.limits) {
      this.rateLimits.messagesPerMinute = data.server.limits.messagesPerMinute;
    }
  }

  /**
   * Handle room joined message
   */
  handleRoomJoined(data) {
    this.rooms.add(data.roomId);
    this.emit('room_joined', data);
  }

  /**
   * Handle room left message
   */
  handleRoomLeft(data) {
    this.rooms.delete(data.roomId);
    this.emit('room_left', data);
  }

  /**
   * Handle voice call started
   */
  handleVoiceCallStarted(data) {
    this.emit('voice_call_started', data);
  }

  /**
   * Handle voice call created
   */
  handleVoiceCallCreated(data) {
    this.currentVoiceCall = {
      id: data.callId,
      participants: data.participants,
      status: data.status
    };
    this.emit('voice_call_created', data);
  }

  /**
   * Handle call ended
   */
  handleCallEnded(data) {
    this.currentVoiceCall = null;
    this.emit('call_ended', data);
  }

  /**
   * Handle pong response
   */
  handlePong(data) {
    this.emit('pong', data);
  }

  /**
   * Handle server errors
   */
  handleServerError(data) {
    this.emit('server_error', data);
  }

  // ===== HIGH-LEVEL API METHODS =====

  /**
   * Join a room
   */
  joinRoom(roomId, roomType = 'application') {
    return this.send({
      type: 'join_room',
      roomId,
      roomType
    });
  }

  /**
   * Leave a room
   */
  leaveRoom(roomId) {
    return this.send({
      type: 'leave_room',
      roomId
    });
  }

  /**
   * Send chat message
   */
  sendChatMessage(applicationId, content, language = 'en') {
    return this.send({
      type: 'chat_message',
      applicationId,
      content,
      language
    });
  }

  /**
   * Start voice call
   */
  startVoiceCall(applicationId, callType = 'audio') {
    return this.send({
      type: 'start_voice_call',
      applicationId,
      callType
    });
  }

  /**
   * Join voice call
   */
  joinVoiceCall(callId) {
    return this.send({
      type: 'join_voice_call',
      callId
    });
  }

  /**
   * End voice call
   */
  endVoiceCall(callId) {
    return this.send({
      type: 'end_voice_call',
      callId
    });
  }

  /**
   * Send voice signal (WebRTC)
   */
  sendVoiceSignal(callId, targetUserId, signal) {
    return this.send({
      type: 'voice_signal',
      callId,
      targetUserId,
      signal
    });
  }

  /**
   * Update user status
   */
  updateStatus(status) {
    return this.send({
      type: 'status_update',
      status
    });
  }

  /**
   * Get user rooms
   */
  getRooms() {
    return this.send({
      type: 'get_rooms'
    });
  }

  /**
   * Get user metrics
   */
  getMetrics() {
    return this.send({
      type: 'get_metrics'
    });
  }

  /**
   * Ping server
   */
  ping() {
    return this.send({
      type: 'ping'
    });
  }

  // ===== EVENT SYSTEM =====

  /**
   * Add event listener
   */
  on(event, callback) {
    if (!this.events.has(event)) {
      this.events.set(event, []);
    }
    this.events.get(event).push(callback);
  }

  /**
   * Remove event listener
   */
  off(event, callback) {
    if (this.events.has(event)) {
      const callbacks = this.events.get(event);
      const index = callbacks.indexOf(callback);
      if (index > -1) {
        callbacks.splice(index, 1);
      }
    }
  }

  /**
   * Emit event
   */
  emit(event, data) {
    if (this.events.has(event)) {
      this.events.get(event).forEach(callback => {
        try {
          callback(data);
        } catch (error) {
          console.error(`Error in event handler for ${event}:`, error);
        }
      });
    }
  }

  // ===== UTILITY METHODS =====

  /**
   * Check if connected
   */
  isConnected() {
    return this.connected && this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Get connection state
   */
  getConnectionState() {
    if (!this.ws) return 'disconnected';
    
    switch (this.ws.readyState) {
      case WebSocket.CONNECTING: return 'connecting';
      case WebSocket.OPEN: return 'connected';
      case WebSocket.CLOSING: return 'closing';
      case WebSocket.CLOSED: return 'disconnected';
      default: return 'unknown';
    }
  }

  /**
   * Get metrics
   */
  getMetrics() {
    return {
      ...this.metrics,
      connected: this.connected,
      connecting: this.connecting,
      rooms: this.rooms.size,
      currentVoiceCall: this.currentVoiceCall,
      rateLimits: { ...this.rateLimits },
      connectionState: this.getConnectionState()
    };
  }

  /**
   * Get rooms
   */
  getRoomsList() {
    return Array.from(this.rooms);
  }

  /**
   * Check if in room
   */
  isInRoom(roomId) {
    return this.rooms.has(roomId);
  }

  /**
   * Check if in voice call
   */
  isInVoiceCall() {
    return this.currentVoiceCall !== null;
  }

  /**
   * Get current voice call
   */
  getCurrentVoiceCall() {
    return this.currentVoiceCall;
  }
}

// Export for different module systems
if (typeof module !== 'undefined' && module.exports) {
  module.exports = QumakWebSocketClient;
} else if (typeof define === 'function' && define.amd) {
  define(() => QumakWebSocketClient);
} else if (typeof window !== 'undefined') {
  window.QumakWebSocketClient = QumakWebSocketClient;
}

export default QumakWebSocketClient; 