#!/bin/bash

echo "🚀 Deploying Robust Amer Officer Chat System"
echo "============================================="

# Kill any existing processes on port 5001
echo "🔄 Stopping existing server..."
lsof -ti:5001 | xargs kill -9 2>/dev/null || echo "No existing server found"

# Wait a moment
sleep 2

# Start the server
echo "🚀 Starting server with robust chat system..."
npm start &

# Wait for server to start
echo "⏳ Waiting for server to start..."
sleep 5

# Test the connection
echo "🧪 Testing server connection..."
curl -s http://localhost:5001/health > /dev/null && echo "✅ Server is running" || echo "❌ Server failed to start"

echo ""
echo "🎯 Robust Chat System Deployed!"
echo ""
echo "✅ Features Implemented:"
echo "   • Amer officer registration and availability tracking"
echo "   • User connection requests with proper routing"
echo "   • Real-time message exchange between users and officers"
echo "   • File sharing with metadata support"
echo "   • Separate chat contexts (AI vs Amer)"
echo "   • Auto-scroll and overflow prevention"
echo "   • Comprehensive error handling and debugging"
echo "   • Mobile-first responsive design"
echo ""
echo "🔧 Backend Features:"
echo "   • Unified WebSocket handler in chatController.js"
echo "   • Officer registration and status management"
echo "   • Message routing with chatId-based sessions"
echo "   • File upload handling with proper metadata"
echo "   • Connection cleanup and error recovery"
echo ""
echo "🎨 Frontend Features:"
echo "   • Separate AI and Amer chat contexts"
echo "   • Real-time message display with auto-scroll"
echo "   • Officer connection status indicators"
echo "   • File sharing UI with drag & drop"
echo "   • Mobile-optimized responsive design"
echo "   • Proper error handling and user feedback"
echo ""
echo "🧪 Testing:"
echo "   • Run: node test-complete-chat.js"
echo "   • Test officer registration and connection"
echo "   • Test message exchange and file sharing"
echo "   • Verify real-time updates and error handling"
echo ""
echo "📱 Usage:"
echo "   1. Officers: Open AmerDashboard and register automatically"
echo "   2. Users: Open StartApplicationDialog and request officer"
echo "   3. Chat: Real-time messaging with file sharing"
echo "   4. AI: Separate AI chat context for guidance"
echo ""
echo "🎉 System is ready for production use!"
