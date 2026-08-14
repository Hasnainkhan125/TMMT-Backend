const express = require('express');
const router = express.Router();
const chatController = require('./chatController');
const auth = require('../../middelwares/auth');

// Process chat messages through OpenAI
router.post('/process', auth, chatController.processMessage);
router.post('/stream', auth, chatController.streamMessage);
router.post('/message', auth, chatController.processMessage); // Alias for live chat widget
router.post('/upload', auth, chatController.chatUploadMiddleware, chatController.uploadChatFile);

module.exports = router;