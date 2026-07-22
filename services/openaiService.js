const OpenAI = require('openai');
const { getServiceById } = require('./catalogLoader');
const VisaApplication = require('../model/schema/visaApplication');
const ChatMessage = require('../model/schema/chatMessage');

class OpenAIService {
  constructor() {
    this.client = null;
    this.isEnabled = false;
    this.maxRetries = 3;
    this.baseDelayMs = 500;
    
    if (process.env.OPENAI_API_KEY) {
      try {
        this.client = new OpenAI({
          apiKey: process.env.OPENAI_API_KEY
        });
        this.isEnabled = true;
        console.log('OpenAI service initialized');
      } catch (error) {
        console.error('Failed to initialize OpenAI:', error);
      }
    } else {
      console.log('OpenAI API key not found - AI features disabled');
    }
  }

  // Basic sleep helper
  async sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Decide if error is transient and worth retrying
  isTransientError(error) {
    const message = String(error?.message || '').toLowerCase();
    const status = error?.status || error?.code;
    if (status && [408, 409, 425, 429, 500, 502, 503, 504].includes(Number(status))) return true;
    if (message.includes('timeout') || message.includes('timed out')) return true;
    if (message.includes('network') || message.includes('unavailable') || message.includes('temporarily')) return true;
    return false;
  }

  // Generic retry wrapper
  async withRetry(actionFn, description = 'openai_call') {
    let lastError;
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        return await actionFn();
      } catch (err) {
        lastError = err;
        if (!this.isTransientError(err) || attempt === this.maxRetries - 1) break;
        const delay = this.baseDelayMs * Math.pow(2, attempt) + Math.floor(Math.random() * 200);
        console.warn(`[OpenAI retry] ${description} attempt ${attempt + 1} failed: ${err?.message || err}. Retrying in ${delay}ms...`);
        await this.sleep(delay);
      }
    }
    throw lastError;
  }

  // Low-level chat completion with retry
  async chatComplete(messages, options = {}) {
    if (!this.isEnabled) {
      return { content: null, raw: null };
    }
    const {
      model = 'gpt-4',
      max_tokens = 500,
      temperature = 0.7,
      presence_penalty = 0.1,
      frequency_penalty = 0.1,
    } = options;

    const completion = await this.withRetry(() => this.client.chat.completions.create({
      model,
      messages,
      max_tokens,
      temperature,
      presence_penalty,
      frequency_penalty
    }), 'chat.completions.create');

    const content = completion?.choices?.[0]?.message?.content || null;
    return { content, raw: completion };
  }

  // Generate AI response for chat
  async generateAIResponse(userMessage, applicationId, language = 'auto') {
    if (!this.isEnabled) {
      return "I'm sorry, AI assistance is currently unavailable. Please contact our support team for help.";
    }

    try {
      // Get application context
      const application = await VisaApplication.findById(applicationId)
        .populate('sponsor', 'firstName lastName role')
        .populate('sponsored', 'firstName lastName');

      // Get service context if available
      let serviceContext = '';
      if (application && application.serviceId) {
        const service = getServiceById(application.serviceId);
        if (service) {
          serviceContext = `
Service: ${service.name}
Description: ${service.outsideDescription}
Required Documents: ${service.requiredDocuments?.join(', ') || 'Not specified'}
Price Range: ${service.prices?.map(p => `${p.PriceAmount} ${p.PriceCurrency} (${p.PriceType})`).join(', ') || 'Not specified'}
`;
        }
      }

      // Get recent chat history for context
      const recentMessages = await ChatMessage.find({ application: applicationId })
        .sort({ createdAt: -1 })
        .limit(10)
        .populate('sender', 'firstName lastName role');

      const chatHistory = recentMessages.reverse().map(msg => ({
        role: msg.isAI ? 'assistant' : 'user',
        content: msg.content,
        sender: msg.sender ? `${msg.sender.firstName} ${msg.sender.lastName}` : 'System'
      }));

      // Build system prompt
      const systemPrompt = this.buildSystemPrompt(application, serviceContext, language);

      // Build messages array
      const messages = [
        { role: 'system', content: systemPrompt },
        ...chatHistory.slice(-6).map(msg => ({ // Last 6 messages for context
          role: msg.role,
          content: msg.content
        })),
        { role: 'user', content: userMessage }
      ];

      // Generate response with retry
      const { content: response } = await this.chatComplete(messages, {
        model: 'gpt-4',
        max_tokens: 500,
        temperature: 0.7,
        presence_penalty: 0.1,
        frequency_penalty: 0.1,
      });
      
      if (!response) {
        throw new Error('No response generated');
      }

      return response;

    } catch (error) {
      console.error('Error generating AI response:', error);
      return "I apologize, but I'm having trouble processing your request right now. Please try again or contact our support team for assistance.";
    }
  }

  // Build context-aware system prompt
  buildSystemPrompt(application, serviceContext, language) {
    const basePrompt = `You are QUMAK AI, an expert assistant for UAE visa and immigration services. You help users navigate the complex process of obtaining various types of visas and permits in Dubai and the UAE.

Key Guidelines:
1. Be helpful, professional, and accurate
2. Provide step-by-step guidance when possible
3. Reference specific documents and requirements
4. Explain complex processes in simple terms
5. Always prioritize official government requirements
6. If uncertain about specific details, recommend contacting professional support
7. Be empathetic to user concerns about visa processes
8. Provide estimated timelines when known
9. Suggest next steps and actions

Current Application Context:
${application ? `
Application Type: ${application.applicationType}
Status: ${application.status}
Sponsor: ${application.sponsor?.firstName} ${application.sponsor?.lastName}
${application.sponsored ? `Sponsored Person: ${application.sponsored.firstName} ${application.sponsored.lastName}` : ''}
Application Date: ${application.createdAt?.toDateString()}
` : 'No application context available'}

${serviceContext ? `Service Information:\n${serviceContext}` : ''}

Language Instructions:
${this.getLanguageInstructions(language)}

Remember: Always provide practical, actionable advice while emphasizing compliance with UAE immigration laws.`;

    return basePrompt;
  }

  // Get language-specific instructions
  getLanguageInstructions(language) {
    const instructions = {
      'ar': 'Please respond in Arabic. Use formal Arabic and ensure cultural sensitivity.',
      'ur': 'Please respond in Urdu. Use respectful language appropriate for the context.',
      'hi': 'Please respond in Hindi. Use formal Hindi with appropriate honorifics.',
      'fr': 'Please respond in French. Use formal French appropriate for professional context.',
      'es': 'Please respond in Spanish. Use formal Spanish with professional tone.',
      'ru': 'Please respond in Russian. Use formal Russian appropriate for official matters.',
      'de': 'Please respond in German. Use formal German with professional terminology.',
      'auto': 'Detect the language of the user\'s message and respond in the same language. If unsure, respond in English.'
    };

    return instructions[language] || 'Respond in clear, professional English.';
  }

  // Generate service recommendations
  async generateServiceRecommendations(userQuery, userProfile = {}) {
    if (!this.isEnabled) {
      return [];
    }

    try {
      const prompt = `Based on the user query and profile, recommend the most relevant UAE visa/immigration services.

User Query: "${userQuery}"
User Profile: ${JSON.stringify(userProfile)}

Please analyze and suggest the top 3-5 most relevant services. Consider:
1. User's current status (resident, visitor, etc.)
2. Family situation
3. Employment status
4. Specific needs mentioned

Respond with a JSON array of service recommendations with reasoning.`;

      const { content: response } = await this.chatComplete([
        { role: 'user', content: prompt }
      ], { model: 'gpt-4', max_tokens: 300, temperature: 0.3 });
      
      try {
        return JSON.parse(response);
      } catch {
        return [];
      }

    } catch (error) {
      console.error('Error generating service recommendations:', error);
      return [];
    }
  }

  // Generate document checklist
  async generateDocumentChecklist(serviceId, userContext = {}) {
    if (!this.isEnabled) {
      return null;
    }

    try {
      const service = getServiceById(serviceId);
      if (!service) {
        return null;
      }

      const prompt = `Create a personalized document checklist for the following UAE visa service:

Service: ${service.name}
Description: ${service.outsideDescription}
Required Documents: ${service.requiredDocuments?.join(', ') || 'Not specified'}
Form Description: ${service.formDescription || 'Not available'}

User Context: ${JSON.stringify(userContext)}

Generate a comprehensive, personalized checklist with:
1. All required documents
2. Where to obtain each document
3. Attestation requirements
4. Special notes or considerations
5. Estimated timeline for document preparation

Format as a structured checklist.`;

      const { content } = await this.chatComplete([
        { role: 'user', content: prompt }
      ], { model: 'gpt-4', max_tokens: 600, temperature: 0.3 });

      return content;

    } catch (error) {
      console.error('Error generating document checklist:', error);
      return null;
    }
  }

  // Analyze uploaded documents
  async analyzeDocuments(documentList, serviceId) {
    if (!this.isEnabled) {
      return null;
    }

    try {
      const service = getServiceById(serviceId);
      if (!service) {
        return null;
      }

      const prompt = `Analyze the uploaded documents against the requirements for this UAE visa service:

Service: ${service.name}
Required Documents: ${service.requiredDocuments?.join(', ') || 'Not specified'}

Uploaded Documents: ${documentList.map(doc => doc.name || doc.type).join(', ')}

Please provide:
1. Document completeness analysis
2. Missing documents (if any)
3. Potential issues or concerns
4. Recommendations for next steps
5. Estimated likelihood of approval

Be specific and actionable in your analysis.`;

      const { content } = await this.chatComplete([
        { role: 'user', content: prompt }
      ], { model: 'gpt-4', max_tokens: 400, temperature: 0.3 });

      return content;

    } catch (error) {
      console.error('Error analyzing documents:', error);
      return null;
    }
  }

  // Generate status update explanation
  async explainStatusUpdate(oldStatus, newStatus, serviceType) {
    if (!this.isEnabled) {
      return `Your application status has been updated from ${oldStatus} to ${newStatus}.`;
    }

    try {
      const prompt = `Explain this UAE visa application status change in a clear, helpful way:

Service Type: ${serviceType}
Previous Status: ${oldStatus}
New Status: ${newStatus}

Provide:
1. What this status change means
2. What happens next
3. Any action required from the applicant
4. Estimated timeline for next steps
5. Any important reminders or tips

Keep it concise but informative, and maintain a reassuring tone.`;

      const { content } = await this.chatComplete([
        { role: 'user', content: prompt }
      ], { model: 'gpt-4', max_tokens: 300, temperature: 0.4 });

      return content || `Your application status has been updated from ${oldStatus} to ${newStatus}.`;

    } catch (error) {
      console.error('Error explaining status update:', error);
      return `Your application status has been updated from ${oldStatus} to ${newStatus}.`;
    }
  }

  // Check if AI is enabled
  isAvailable() {
    return this.isEnabled;
  }

  // Get usage statistics (if needed)
  getUsageStats() {
    return {
      isEnabled: this.isEnabled,
      model: 'gpt-4',
      features: [
        'chat_assistance',
        'service_recommendations',
        'document_analysis',
        'status_explanations',
        'multi_language_support'
      ]
    };
  }
}

// Create singleton instance
const openaiService = new OpenAIService();

module.exports = {
  chatComplete: (messages, options) => openaiService.chatComplete(messages, options),
  generateAIResponse: (userMessage, applicationId, language) => 
    openaiService.generateAIResponse(userMessage, applicationId, language),
  
  generateServiceRecommendations: (userQuery, userProfile) => 
    openaiService.generateServiceRecommendations(userQuery, userProfile),
  
  generateDocumentChecklist: (serviceId, userContext) => 
    openaiService.generateDocumentChecklist(serviceId, userContext),
  
  analyzeDocuments: (documentList, serviceId) => 
    openaiService.analyzeDocuments(documentList, serviceId),
  
  explainStatusUpdate: (oldStatus, newStatus, serviceType) => 
    openaiService.explainStatusUpdate(oldStatus, newStatus, serviceType),
  
  isAvailable: () => openaiService.isAvailable(),
  
  getUsageStats: () => openaiService.getUsageStats()
}; 