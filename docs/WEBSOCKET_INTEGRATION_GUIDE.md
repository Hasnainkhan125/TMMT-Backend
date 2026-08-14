# QUMAK WebSocket Integration Guide

## 🚀 Overview

The QUMAK WebSocket system provides enterprise-grade real-time communication for visa services, including chat, voice calls, and status updates. This guide covers everything you need to integrate WebSocket functionality into your frontend application.

## ✨ Features

- **Real-time Chat**: Instant messaging between users and professionals
- **Voice Calling**: WebRTC-based voice communication
- **Room Management**: Application-based communication rooms
- **AI Integration**: Automatic AI responses for common queries
- **Status Updates**: Real-time user presence and status
- **Auto-reconnection**: Robust connection management
- **Rate Limiting**: Built-in protection against abuse
- **Event-driven**: Clean, intuitive event system

## 📦 Installation

### Browser (ES6 Module)
```html
<script type="module">
  import QUMAKWebSocketClient from './services/websocketClient.js';
</script>
```

### Browser (Global)
```html
<script src="./services/websocketClient.js"></script>
<script>
  const client = new QUMAKWebSocketClient({ token: 'your-jwt-token' });
</script>
```

### Node.js
```javascript
const QUMAKWebSocketClient = require('./services/websocketClient');
```

## 🔌 Basic Setup

### 1. Initialize Client
```javascript
const wsClient = new QUMAKWebSocketClient({
  url: 'ws://localhost:3000/ws',
  token: 'your-jwt-token',
  autoReconnect: true,
  reconnectAttempts: 10,
  heartbeatInterval: 30000
});
```

### 2. Connect to Server
```javascript
// Connect immediately
wsClient.connect();

// Or connect with error handling
try {
  await wsClient.connect();
  console.log('Connected successfully!');
} catch (error) {
  console.error('Connection failed:', error);
}
```

### 3. Listen for Events
```javascript
// Connection events
wsClient.on('connected', (data) => {
  console.log('Connected to WebSocket server');
});

wsClient.on('disconnected', (data) => {
  console.log('Disconnected from server:', data.reason);
});

// Error handling
wsClient.on('error', (data) => {
  console.error('WebSocket error:', data.error);
});
```

## 💬 Chat Functionality

### Send Chat Message
```javascript
// Send a message to an application room
wsClient.sendChatMessage(
  'application123',           // Application ID
  'Hello, I need help with my visa application', // Message content
  'en'                       // Language (en, ar, ur, hi, fr, es, ru, de)
);
```

### Receive Chat Messages
```javascript
// Listen for new messages
wsClient.on('new_message', (data) => {
  const { message } = data;
  console.log(`New message from ${message.sender}:`, message.content);
  
  // Update your UI here
  displayMessage(message);
});

// Listen for AI responses
wsClient.on('ai_response', (data) => {
  const { message } = data;
  console.log('AI response:', message.content);
  
  // Display AI message in your chat
  displayAIMessage(message);
});
```

### Join Application Room
```javascript
// Join a specific application room
wsClient.joinRoom('app_application123', 'application');

// Listen for room join confirmation
wsClient.on('room_joined', (data) => {
  console.log(`Joined room: ${data.roomId}`);
  console.log(`Room type: ${data.roomType}`);
  console.log(`Users in room: ${data.roomInfo.clientCount}`);
});
```

## 📞 Voice Calling

### Start Voice Call
```javascript
// Start a voice call for an application
wsClient.startVoiceCall('application123', 'audio');

// Listen for call creation
wsClient.on('voice_call_started', (data) => {
  console.log(`Voice call started: ${data.callId}`);
  console.log(`Call type: ${data.callType}`);
  console.log(`Initiator: ${data.initiator}`);
});
```

### Join Voice Call
```javascript
// Join an existing voice call
wsClient.joinVoiceCall('call_application123_1234567890');

// Listen for call details
wsClient.on('voice_call_created', (data) => {
  console.log(`Joined call: ${data.callId}`);
  console.log(`Participants:`, data.participants);
  console.log(`Call status: ${data.status}`);
  
  // Initialize WebRTC here
  initializeWebRTC(data.callId, data.participants);
});
```

### End Voice Call
```javascript
// End the current voice call
wsClient.endVoiceCall('call_application123_1234567890');

// Listen for call end
wsClient.on('call_ended', (data) => {
  console.log(`Call ended by: ${data.endedBy}`);
  
  // Clean up WebRTC connections
  cleanupWebRTC();
});
```

### WebRTC Signaling
```javascript
// Send WebRTC signal to specific user
wsClient.sendVoiceSignal(
  'call_application123_1234567890', // Call ID
  'targetUserId123',                 // Target user ID
  { type: 'offer', sdp: '...' }     // WebRTC signal
);

// Listen for incoming signals
wsClient.on('voice_signal', (data) => {
  console.log(`Signal from: ${data.fromUserId}`);
  console.log(`Signal type: ${data.signal.type}`);
  
  // Handle WebRTC signal
  handleWebRTCSignal(data.signal);
});
```

## 👥 Room Management

### Get User Rooms
```javascript
// Request list of user's rooms
wsClient.getRooms();

// Listen for room list
wsClient.on('user_rooms', (data) => {
  console.log('User rooms:', data.rooms);
  
  // Update room list in UI
  updateRoomList(data.rooms);
});
```

### Room Events
```javascript
// User joined room
wsClient.on('user_joined_room', (data) => {
  console.log(`User ${data.userId} joined room ${data.roomId}`);
  console.log(`User role: ${data.user.role}`);
  
  // Update room participant list
  addParticipant(data.userId, data.user);
});

// User left room
wsClient.on('user_left_room', (data) => {
  console.log(`User ${data.userId} left room ${data.roomId}`);
  
  // Remove participant from list
  removeParticipant(data.userId);
});
```

## 📊 Status and Metrics

### Update User Status
```javascript
// Update your status
wsClient.updateStatus('available'); // available, busy, away, offline

// Listen for status changes
wsClient.on('user_status_changed', (data) => {
  console.log(`User ${data.userId} status: ${data.oldStatus} → ${data.newStatus}`);
  
  // Update user status in UI
  updateUserStatus(data.userId, data.newStatus);
});
```

### Get Metrics
```javascript
// Request user metrics
wsClient.getMetrics();

// Listen for metrics
wsClient.on('user_metrics', (data) => {
  console.log('User metrics:', data.metrics);
  
  // Display metrics in UI
  displayMetrics(data.metrics);
});
```

### Connection Health
```javascript
// Check connection status
if (wsClient.isConnected()) {
  console.log('WebSocket is connected');
} else {
  console.log('WebSocket is disconnected');
}

// Get connection state
const state = wsClient.getConnectionState();
console.log('Connection state:', state); // connecting, connected, closing, disconnected

// Get comprehensive metrics
const metrics = wsClient.getMetrics();
console.log('Connection metrics:', metrics);
```

## 🔄 Reconnection

### Automatic Reconnection
```javascript
const wsClient = new QUMAKWebSocketClient({
  autoReconnect: true,
  reconnectAttempts: 10,
  reconnectInterval: 1000
});

// Listen for reconnection events
wsClient.on('reconnecting', (data) => {
  console.log(`Reconnection attempt ${data.attempt} in ${data.delay}ms`);
  
  // Show reconnecting indicator
  showReconnectingIndicator();
});

wsClient.on('connected', (data) => {
  console.log('Reconnected successfully!');
  
  // Hide reconnecting indicator
  hideReconnectingIndicator();
});

wsClient.on('reconnect_failed', (data) => {
  console.log(`Reconnection failed after ${data.attempts} attempts`);
  
  // Show manual reconnect button
  showManualReconnectButton();
});
```

### Manual Reconnection
```javascript
// Disable auto-reconnect
wsClient.config.autoReconnect = false;

// Manual reconnect
async function reconnect() {
  try {
    await wsClient.connect();
    console.log('Manually reconnected!');
  } catch (error) {
    console.error('Manual reconnection failed:', error);
  }
}
```

## 🚨 Error Handling

### Server Errors
```javascript
wsClient.on('server_error', (data) => {
  console.error('Server error:', data.message);
  console.error('Error code:', data.code);
  
  // Handle specific error codes
  switch (data.code) {
    case 'RATE_LIMIT_EXCEEDED':
      showRateLimitMessage(data.message);
      break;
    case 'ACCESS_DENIED':
      showAccessDeniedMessage(data.message);
      break;
    case 'APPLICATION_NOT_FOUND':
      showApplicationNotFoundMessage(data.message);
      break;
    default:
      showGenericErrorMessage(data.message);
  }
});
```

### Rate Limiting
```javascript
wsClient.on('rate_limit_exceeded', (data) => {
  console.warn('Rate limit exceeded:', data.message);
  
  // Show rate limit warning
  showRateLimitWarning();
  
  // Disable send button temporarily
  disableSendButton();
  
  // Re-enable after delay
  setTimeout(() => {
    enableSendButton();
  }, 60000); // 1 minute
});
```

### Connection Errors
```javascript
wsClient.on('error', (data) => {
  console.error('Connection error:', data.error);
  
  if (data.details) {
    console.error('Error details:', data.details);
  }
  
  // Show error message to user
  showErrorMessage(data.error);
});
```

## 🎯 Complete Example

### React Component Example
```jsx
import React, { useEffect, useState } from 'react';
import QUMAKWebSocketClient from './services/websocketClient';

function ChatComponent({ applicationId, token }) {
  const [wsClient, setWsClient] = useState(null);
  const [messages, setMessages] = useState([]);
  const [connected, setConnected] = useState(false);
  const [typing, setTyping] = useState(false);

  useEffect(() => {
    // Initialize WebSocket client
    const client = new QUMAKWebSocketClient({
      url: 'ws://localhost:3000/ws',
      token,
      autoReconnect: true
    });

    // Set up event listeners
    client.on('connected', () => {
      setConnected(true);
      console.log('Connected to chat server');
      
      // Join application room
      client.joinRoom(`app_${applicationId}`, 'application');
    });

    client.on('disconnected', () => {
      setConnected(false);
      console.log('Disconnected from chat server');
    });

    client.on('new_message', (data) => {
      setMessages(prev => [...prev, data.message]);
    });

    client.on('ai_response', (data) => {
      setMessages(prev => [...prev, data.message]);
    });

    client.on('user_joined_room', (data) => {
      console.log(`User ${data.userId} joined the chat`);
    });

    client.on('user_left_room', (data) => {
      console.log(`User ${data.userId} left the chat`);
    });

    // Connect to server
    client.connect();

    setWsClient(client);

    // Cleanup on unmount
    return () => {
      client.disconnect();
    };
  }, [applicationId, token]);

  const sendMessage = (content) => {
    if (wsClient && connected) {
      wsClient.sendChatMessage(applicationId, content, 'en');
    }
  };

  const startVoiceCall = () => {
    if (wsClient && connected) {
      wsClient.startVoiceCall(applicationId, 'audio');
    }
  };

  return (
    <div className="chat-component">
      <div className="chat-header">
        <h3>Chat Room</h3>
        <div className="connection-status">
          {connected ? '🟢 Connected' : '🔴 Disconnected'}
        </div>
        <button onClick={startVoiceCall} disabled={!connected}>
          📞 Start Voice Call
        </button>
      </div>

      <div className="chat-messages">
        {messages.map((message, index) => (
          <div key={index} className={`message ${message.isAI ? 'ai' : 'user'}`}>
            <div className="sender">{message.sender}</div>
            <div className="content">{message.content}</div>
            <div className="timestamp">{new Date(message.timestamp).toLocaleTimeString()}</div>
          </div>
        ))}
      </div>

      <MessageInput onSend={sendMessage} disabled={!connected} />
    </div>
  );
}

function MessageInput({ onSend, disabled }) {
  const [message, setMessage] = useState('');

  const handleSubmit = (e) => {
    e.preventDefault();
    if (message.trim() && !disabled) {
      onSend(message.trim());
      setMessage('');
    }
  };

  return (
    <form onSubmit={handleSubmit} className="message-input">
      <input
        type="text"
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="Type your message..."
        disabled={disabled}
      />
      <button type="submit" disabled={disabled || !message.trim()}>
        Send
      </button>
    </form>
  );
}

export default ChatComponent;
```

### Vue.js Component Example
```vue
<template>
  <div class="chat-component">
    <div class="chat-header">
      <h3>Chat Room</h3>
      <div class="connection-status">
        {{ connected ? '🟢 Connected' : '🔴 Disconnected' }}
      </div>
      <button @click="startVoiceCall" :disabled="!connected">
        📞 Start Voice Call
      </button>
    </div>

    <div class="chat-messages">
      <div
        v-for="(message, index) in messages"
        :key="index"
        :class="['message', message.isAI ? 'ai' : 'user']"
      >
        <div class="sender">{{ message.sender }}</div>
        <div class="content">{{ message.content }}</div>
        <div class="timestamp">
          {{ new Date(message.timestamp).toLocaleTimeString() }}
        </div>
      </div>
    </div>

    <form @submit.prevent="sendMessage" class="message-input">
      <input
        v-model="newMessage"
        type="text"
        placeholder="Type your message..."
        :disabled="!connected"
      />
      <button type="submit" :disabled="!connected || !newMessage.trim()">
        Send
      </button>
    </form>
  </div>
</template>

<script>
import QUMAKWebSocketClient from './services/websocketClient';

export default {
  name: 'ChatComponent',
  props: {
    applicationId: {
      type: String,
      required: true
    },
    token: {
      type: String,
      required: true
    }
  },
  data() {
    return {
      wsClient: null,
      messages: [],
      connected: false,
      newMessage: ''
    };
  },
  mounted() {
    this.initializeWebSocket();
  },
  beforeDestroy() {
    if (this.wsClient) {
      this.wsClient.disconnect();
    }
  },
  methods: {
    initializeWebSocket() {
      this.wsClient = new QUMAKWebSocketClient({
        url: 'ws://localhost:3000/ws',
        token: this.token,
        autoReconnect: true
      });

      this.wsClient.on('connected', () => {
        this.connected = true;
        console.log('Connected to chat server');
        this.wsClient.joinRoom(`app_${this.applicationId}`, 'application');
      });

      this.wsClient.on('disconnected', () => {
        this.connected = false;
        console.log('Disconnected from chat server');
      });

      this.wsClient.on('new_message', (data) => {
        this.messages.push(data.message);
      });

      this.wsClient.on('ai_response', (data) => {
        this.messages.push(data.message);
      });

      this.wsClient.connect();
    },

    sendMessage() {
      if (this.wsClient && this.connected && this.newMessage.trim()) {
        this.wsClient.sendChatMessage(
          this.applicationId,
          this.newMessage.trim(),
          'en'
        );
        this.newMessage = '';
      }
    },

    startVoiceCall() {
      if (this.wsClient && this.connected) {
        this.wsClient.startVoiceCall(this.applicationId, 'audio');
      }
    }
  }
};
</script>
```

## 🧪 Testing

### Test WebSocket Connection
```javascript
// Test basic connectivity
async function testConnection() {
  const client = new QUMAKWebSocketClient({
    url: 'ws://localhost:3000/ws',
    token: 'test-token'
  });

  client.on('connected', () => {
    console.log('✅ Connection test passed');
    client.disconnect();
  });

  client.on('error', (data) => {
    console.log('❌ Connection test failed:', data.error);
  });

  await client.connect();
}

// Test message sending
async function testMessageSending() {
  const client = new QUMAKWebSocketClient({
    url: 'ws://localhost:3000/ws',
    token: 'test-token'
  });

  await client.connect();

  // Test chat message
  const success = client.sendChatMessage('test123', 'Hello, World!', 'en');
  console.log('Message sent:', success);

  client.disconnect();
}
```

## 🔧 Troubleshooting

### Common Issues

1. **Connection Refused**
   - Check if WebSocket server is running
   - Verify server URL and port
   - Check firewall settings

2. **Authentication Failed**
   - Verify JWT token is valid
   - Check token expiration
   - Ensure token format is correct

3. **Messages Not Received**
   - Check if user is in the correct room
   - Verify message format
   - Check server logs for errors

4. **Reconnection Issues**
   - Check network connectivity
   - Verify reconnection settings
   - Check server availability

### Debug Mode
```javascript
const wsClient = new QUMAKWebSocketClient({
  url: 'ws://localhost:3000/ws',
  token: 'your-token',
  debug: true // Enable debug logging
});

// Monitor all events
wsClient.on('*', (event, data) => {
  console.log(`Event: ${event}`, data);
});
```

## 📚 API Reference

### Constructor Options
- `url`: WebSocket server URL
- `token`: JWT authentication token
- `autoReconnect`: Enable automatic reconnection
- `reconnectAttempts`: Maximum reconnection attempts
- `reconnectInterval`: Base reconnection interval
- `heartbeatInterval`: Heartbeat interval in milliseconds
- `connectionTimeout`: Connection timeout in milliseconds

### Methods
- `connect()`: Connect to WebSocket server
- `disconnect()`: Disconnect from server
- `send(data)`: Send message to server
- `joinRoom(roomId, type)`: Join a room
- `leaveRoom(roomId)`: Leave a room
- `sendChatMessage(applicationId, content, language)`: Send chat message
- `startVoiceCall(applicationId, type)`: Start voice call
- `joinVoiceCall(callId)`: Join voice call
- `endVoiceCall(callId)`: End voice call
- `updateStatus(status)`: Update user status
- `getRooms()`: Get user rooms
- `getMetrics()`: Get user metrics
- `ping()`: Send ping to server

### Events
- `connected`: Connection established
- `disconnected`: Connection closed
- `reconnecting`: Reconnection attempt
- `reconnect_failed`: Reconnection failed
- `error`: Connection error
- `message`: Generic message received
- `new_message`: New chat message
- `ai_response`: AI-generated response
- `room_joined`: Joined room
- `room_left`: Left room
- `user_joined_room`: User joined room
- `user_left_room`: User left room
- `voice_call_started`: Voice call started
- `voice_call_created`: Voice call created
- `call_ended`: Voice call ended
- `voice_signal`: WebRTC signal
- `user_status_changed`: User status changed
- `rate_limit_exceeded`: Rate limit exceeded
- `server_error`: Server error

### Properties
- `connected`: Connection status
- `connecting`: Connection in progress
- `rooms`: Set of joined rooms
- `currentVoiceCall`: Current voice call info
- `metrics`: Connection metrics

## 🚀 Performance Tips

1. **Connection Pooling**: Reuse WebSocket connections when possible
2. **Message Batching**: Batch multiple messages when appropriate
3. **Event Cleanup**: Remove event listeners when components unmount
4. **Rate Limiting**: Respect server rate limits
5. **Error Handling**: Implement proper error handling and user feedback
6. **Reconnection Strategy**: Use exponential backoff for reconnections
7. **Heartbeat Monitoring**: Monitor connection health regularly

## 🔒 Security Considerations

1. **Token Security**: Store JWT tokens securely
2. **Input Validation**: Validate all user inputs
3. **Rate Limiting**: Respect client-side rate limits
4. **Error Handling**: Don't expose sensitive information in errors
5. **Connection Security**: Use WSS (WebSocket Secure) in production
6. **Authentication**: Always verify user authentication
7. **Data Encryption**: Encrypt sensitive data in transit

---

This guide provides everything you need to integrate the QUMAK WebSocket system into your frontend application. For additional support or questions, refer to the API documentation or contact the development team. 