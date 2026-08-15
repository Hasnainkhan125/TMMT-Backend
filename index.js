// ─── dotenv FIRST ────────────────────────────────────────────────────────
require("dotenv").config();

const express = require("express");
const db = require("./db/config");
const route = require("./controllers/route");
const bodyParser = require("body-parser");
const cookieParser = require("cookie-parser");
const session = require("express-session");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const mongoose = require('mongoose');

// ============================================
// ✅ REDIS OPTIONAL - DISABLE IF NOT CONFIGURED
// ============================================
const isRedisConfigured = process.env.REDIS_URL && 
                         process.env.REDIS_URL !== 'false' && 
                         process.env.REDIS_URL !== 'undefined' &&
                         process.env.REDIS_URL !== '';

let redisClient = null;
let redisStore = null;

if (isRedisConfigured) {
  try {
    const Redis = require('ioredis');
    const RedisStore = require('connect-redis')(session);
    
    redisClient = new Redis(process.env.REDIS_URL, {
      retryStrategy: (times) => {
        if (times > 3) {
          console.warn('⚠️ Redis connection failed after 3 retries, disabling Redis');
          return null; // Stop retrying
        }
        return Math.min(times * 100, 3000);
      }
    });
    
    redisStore = new RedisStore({ 
      client: redisClient,
      prefix: 'qumak:session:',
      ttl: 600 // 10 minutes
    });
    
    redisClient.on('connect', () => {
      console.log('✅ Redis connected successfully');
    });
    
    redisClient.on('error', (err) => {
      console.warn('⚠️ Redis connection warning:', err.message);
      console.log('ℹ️ Falling back to memory session store');
      redisStore = null;
    });
    
    console.log('📦 Redis session store configured');
  } catch (err) {
    console.warn('⚠️ Redis initialization failed:', err.message);
    console.log('ℹ️ Falling back to memory session store');
    redisStore = null;
    redisClient = null;
  }
} else {
  console.log('ℹ️ Redis not configured, using memory session store');
}

// ✅ RAILWAY: Use PORT from environment
const PORT = process.env.PORT || 5001;

// ✅ Only require if files exist (prevents crashes)
try {
  require('./services/resolver/enrichment/enrichmentQueue');
} catch (err) {
  console.warn('⚠️ Enrichment queue not available:', err.message);
}

// ✅ Safe imports with try/catch
let visaRoutes, authRoutes, chatRoutes, servicesRoutes, notificationsRoutes;
let dependentsRoutes, paymentsRoutes, adminRoutes, userRoutes, businessSetupRoutes;
let familyVisaRoutes, popupLeadsRoutes, jobRoutes, marketplaceRoutes, blogRoutes;
let leadsRoutes, checksRoutes, packageRoutes, studioRoutes, studioExtRoutes;
let modelsRoutes, templatesRoutes, creditsRoutes, billingRoutes;

try {
  visaRoutes = require('./controllers/visa/_routes');
  authRoutes = require('./controllers/auth/_routes');
  chatRoutes = require('./controllers/chat/_routes');
  servicesRoutes = require('./controllers/services/_routes');
  notificationsRoutes = require('./controllers/notifications/_routes');
  dependentsRoutes = require('./controllers/dependents/_routes');
  paymentsRoutes = require('./controllers/payments/_routes');
  adminRoutes = require('./controllers/admin/_routes');
  userRoutes = require('./controllers/user/_routes');
  businessSetupRoutes = require('./controllers/businessSetup/_routes');
  familyVisaRoutes = require('./controllers/familyVisa/_routes');
  popupLeadsRoutes = require('./controllers/popupLeads/_routes');
  jobRoutes = require('./controllers/jobs/_routes');
  marketplaceRoutes = require('./controllers/marketplace/_routes');
  blogRoutes = require('./controllers/blog/_routes');
  leadsRoutes = require('./controllers/brandProject/leadsRoutes');
  checksRoutes = require('./controllers/checks/_routes');
  packageRoutes = require('./controllers/package/_routes');
  studioRoutes = require('./controllers/studio/_routes');
  studioExtRoutes = require('./controllers/studio/_extRoutes');
  modelsRoutes = require('./routes/models');
  templatesRoutes = require('./routes/templates');
  creditsRoutes = require('./routes/credits');
  billingRoutes = require('./routes/billing.routes');
} catch (err) {
  console.warn('⚠️ Some routes not available:', err.message);
}

// ✅ Only require GenerationTemplate if file exists
let GenerationTemplate;
try {
  ({ GenerationTemplate } = require('./model/schema/GenerationTemplate'));
} catch (err) {
  console.warn('⚠️ GenerationTemplate model not available:', err.message);
}

// ============================================
// ✅ UPDATED CORS ORIGINS (Fixed your frontend domains)
// ============================================
const allowedOrigins = [
  // Local development
  "http://localhost:5173",
  "http://localhost:5174",
  "http://localhost:3000",
  
  // Production (Custom domains)
  "https://qumak.io",
  "https://www.qumak.io",
  "https://tmmet.netlify.app",      // Added based on your screenshot
  "https://www.tmmet.netlify.app",  // Added based on your screenshot
  
  // Backend domains (for internal API calls)
  "https://tmmt-backend-production.up.railway.app",
  
  // Regex matchers for subdomains
  /^https?:\/\/.*\.netlify\.app$/,  // Catches ANY netlify subdomain
  /\.up\.railway\.app$/,
];

// Setup Express App
const app = express();

// ✅ REQUEST LOGGER (Helps debug)
app.use((req, res, next) => {
  console.log(`📝 ${req.method} ${req.url}`);
  next();
});

// Middleware
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));
app.use(cookieParser());
app.use(express.json({ limit: "50mb" }));

// ============================================
// ✅ SESSION CONFIGURATION - WITH REDIS OPTIONAL
// ============================================
const isProduction = process.env.NODE_ENV === 'production';
const sessionSecret = process.env.SESSION_SECRET || process.env.JWT_SECRET;

if (isProduction && !sessionSecret) {
  console.error('[index] FATAL: SESSION_SECRET (or JWT_SECRET) must be set in production.');
  console.warn('⚠️ Running without session secret - sessions will not persist');
}

// Build session config
const sessionConfig = {
  secret: sessionSecret || 'qumak-dev-only-session-secret-do-not-use-in-prod',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: isProduction,
    httpOnly: true,
    maxAge: 10 * 60 * 1000, // 10 minutes
    sameSite: isProduction ? 'none' : 'lax'
  },
  name: 'qumak.sid',
  proxy: true // ✅ Important for Railway
};

// ✅ Only add store if Redis is configured
if (redisStore) {
  sessionConfig.store = redisStore;
  console.log('📦 Using Redis session store');
} else {
  console.log('📦 Using memory session store (not persistent across restarts)');
}

app.use(session(sessionConfig));

// Request-id + per-request logger
try {
  const requestContext = require('./middelwares/requestContext');
  app.use(requestContext);
} catch (err) {
  console.warn('⚠️ Request context middleware not available:', err.message);
}

// ============================================
// 🛠️ FIXED CORS LOGIC (Removed dangerous global allow)
// ============================================
const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);

    // Check if origin matches allowed list
    if (allowedOrigins.some(allowed => {
      if (typeof allowed === 'string') return origin === allowed;
      if (allowed instanceof RegExp) return allowed.test(origin);
      return false;
    })) {
      return callback(null, true);
    }

    console.warn(`⚠️ CORS blocked origin: ${origin}`);
    callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Cookie'],
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));

// Static files
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// ============================================
// ✅ HEALTH CHECK (NO DB REQUIRED - ALWAYS WORKS)
// ============================================
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "OK",
    service: "qumak-api",
    message: "Qumak API is healthy",
    version: process.env.APP_VERSION || "1.0.0",
    env: process.env.NODE_ENV || "development",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    redis: {
      configured: isRedisConfigured,
      connected: redisClient ? redisClient.status === 'ready' : false,
      storeType: redisStore ? 'redis' : 'memory'
    },
    memory: {
      rss: Math.round(process.memoryUsage().rss / 1024 / 1024) + 'MB',
      heapTotal: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + 'MB',
      heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB'
    }
  });
});

// ============================================
// ✅ REDIS STATUS ENDPOINT
// ============================================
app.get('/api/redis-status', (req, res) => {
  const status = {
    redisConfigured: isRedisConfigured,
    redisConnected: redisClient ? redisClient.status === 'ready' : false,
    usingStore: !!redisStore,
    sessionStoreType: redisStore ? 'redis' : 'memory',
    redisUrl: process.env.REDIS_URL ? '******' : 'not set'
  };
  res.json(status);
});

// ============================================
// ✅ API TEST ENDPOINT (ALWAYS WORKS)
// ============================================
app.get("/api/test", (req, res) => {
  res.json({
    success: true,
    message: "✅ API test endpoint working!",
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || "development",
    origin: req.headers.origin || 'No origin'
  });
});

app.post("/api/test", (req, res) => {
  res.json({
    success: true,
    message: "✅ POST test received!",
    received: req.body,
    timestamp: new Date().toISOString()
  });
});

// ============================================
// ✅ ROOT ENDPOINT
// ============================================
app.get("/", (req, res) => {
  res.json({
    service: "qumak-api",
    message: "Welcome to Qumak — the Arabic-first AI ad agency for GCC SMEs.",
    description: "Paste your Instagram handle, get Arabic+English ads in 60 seconds, launch to Snap/Meta/TikTok MENA.",
    docs: "https://qumak.ae/docs",
    version: process.env.APP_VERSION || "1.0.0",
    environment: process.env.NODE_ENV || "development",
    endpoints: {
      health: "/health",
      test: "/api/test",
      api: "/api/v1",
      redisStatus: "/api/redis-status"
    }
  });
});

// ============================================
// ✅ SAFE ROUTE REGISTRATION (Won't crash if route missing)
// ============================================
try { app.use("/api", route); } catch (err) { console.warn('⚠️ /api route not available'); }
try { app.use('/api/v1/auth', authRoutes); } catch (err) { console.warn('⚠️ Auth routes not available'); }
try { app.use('/api/v1/visa', visaRoutes); } catch (err) { console.warn('⚠️ Visa routes not available'); }
try { app.use('/api/v1/chat', chatRoutes); } catch (err) { console.warn('⚠️ Chat routes not available'); }
try { app.use('/api/v1/checks', checksRoutes); } catch (err) { console.warn('⚠️ Checks routes not available'); }
try { app.use('/api/v1/services', servicesRoutes); } catch (err) { console.warn('⚠️ Services routes not available'); }
try { app.use('/api/v1/notifications', notificationsRoutes); } catch (err) { console.warn('⚠️ Notifications routes not available'); }
try { app.use('/api/v1/dependents', dependentsRoutes); } catch (err) { console.warn('⚠️ Dependents routes not available'); }
try { app.use('/api/v1/services/payments', paymentsRoutes); } catch (err) { console.warn('⚠️ Payments routes not available'); }
try { app.use('/api/v1/admin', adminRoutes); } catch (err) { console.warn('⚠️ Admin routes not available'); }
try { app.use('/api/v1/user', userRoutes); } catch (err) { console.warn('⚠️ User routes not available'); }
try { app.use('/api/v1/business-setup', businessSetupRoutes); } catch (err) { console.warn('⚠️ Business setup routes not available'); }
try { app.use('/api/v1/family-visa', familyVisaRoutes); } catch (err) { console.warn('⚠️ Family visa routes not available'); }
try { app.use('/api/v1/popup-leads', popupLeadsRoutes); } catch (err) { console.warn('⚠️ Popup leads routes not available'); }
try { app.use('/api/v1/jobs', jobRoutes); } catch (err) { console.warn('⚠️ Jobs routes not available'); }
try { app.use('/api/v1/marketplace', marketplaceRoutes); } catch (err) { console.warn('⚠️ Marketplace routes not available'); }
try { app.use('/api/v1/blog', blogRoutes); } catch (err) { console.warn('⚠️ Blog routes not available'); }
try { app.use('/api/v1/leads', leadsRoutes); } catch (err) { console.warn('⚠️ Leads routes not available'); }
try { app.use('/api/v1/package-applications', packageRoutes); } catch (err) { console.warn('⚠️ Package routes not available'); }

// Studio routes
try { app.use('/api/v1/studio', studioRoutes); } catch (err) { console.warn('⚠️ Studio routes not available'); }
try { app.use('/api/v1/studio', studioExtRoutes); } catch (err) { console.warn('⚠️ Studio ext routes not available'); }
try { app.use('/api/v1/models', modelsRoutes); } catch (err) { console.warn('⚠️ Models routes not available'); }
try { app.use('/api/v1/templates', templatesRoutes); } catch (err) { console.warn('⚠️ Templates routes not available'); }
try { app.use('/api/v1/me/credits', creditsRoutes); } catch (err) { console.warn('⚠️ Credits routes not available'); }
try { app.use('/api/v1/billing', billingRoutes); } catch (err) { console.warn('⚠️ Billing routes not available'); }

// Brand routes
try {
  const brandProjectRoutes = require('./routes/brandProject');
  app.use('/api/v1/brand-projects', brandProjectRoutes);
} catch (err) { console.warn('⚠️ Brand project routes not available'); }

try {
  const tradeLicenseRoutes = require('./routes/tradeLicense');
  app.use('/api/v1/brand-projects/:brandId/trade-license', tradeLicenseRoutes);
} catch (err) { console.warn('⚠️ Trade license routes not available'); }

try {
  const storeRoutes = require('./controllers/store/_routes');
  app.use('/api/v1/store', storeRoutes);
} catch (err) { console.warn('⚠️ Store routes not available'); }

try {
  const brandUrlToAdsRoutes = require('./routes/brand.routes');
  app.use('/api/v1/brand', brandUrlToAdsRoutes);
} catch (err) { console.warn('⚠️ Brand routes not available'); }

try {
  const aiBrandRoutes = require('./routes/aiBrand');
  app.use('/api/v1/brand-ai', aiBrandRoutes);
} catch (err) { console.warn('⚠️ AI Brand routes not available'); }

try {
  const imageRoutes = require('./routes/images');
  app.use('/api/v1/images', imageRoutes);
} catch (err) { console.warn('⚠️ Image routes not available'); }

try {
  const facebookRoutes = require('./routes/facebook');
  app.use('/api/v1/facebook', facebookRoutes);
} catch (err) { console.warn('⚠️ Facebook routes not available'); }

try {
  const snapRoutes = require('./routes/snap');
  app.use('/api/v1/snap', snapRoutes);
} catch (err) { console.warn('⚠️ Snap routes not available'); }

try {
  const brandRoutes = require('./controllers/brand/_routes');
  app.use('/api/v1/brands', brandRoutes);
} catch (err) { console.warn('⚠️ Brands routes not available'); }

try {
  const { router: chatWebSocketRoutes } = require('./routes/chat');
  app.use('/api/chat', chatWebSocketRoutes);
} catch (err) { console.warn('⚠️ Chat WebSocket routes not available'); }

// Metrics
try {
  const metrics = require('./utils/metrics');
  app.get('/metrics', metrics.handler);
} catch (err) { console.warn('⚠️ Metrics not available'); }

// ─── Stripe webhooks ────────────────────────────────────────────────────
app.post(
  '/api/v1/brand-projects/credits/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      const stripeKey = process.env.STRIPE_SECRET_KEY;
      const whSecret = process.env.STRIPE_CREDITS_WEBHOOK_SECRET || process.env.STRIPE_WEBHOOK_SECRET;
      if (!stripeKey || !whSecret) {
        return res.status(503).json({ error: 'stripe_not_configured' });
      }
      const stripe = require('stripe')(stripeKey);
      let event;
      try {
        event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], whSecret);
      } catch (err) {
        console.error('[credits webhook] signature verify failed:', err.message);
        return res.status(400).json({ error: `Webhook Error: ${err.message}` });
      }
      try {
        const { handleStripeWebhookEvent } = require('./controllers/brandProject/brandProjectController');
        await handleStripeWebhookEvent(event);
      } catch (err) {
        console.error('[credits webhook] handler failed:', err);
      }
      res.json({ received: true });
    } catch (err) {
      console.error('[credits webhook] error:', err);
      res.status(500).json({ error: 'webhook_error' });
    }
  }
);

app.post(
  '/api/v1/brand-projects/credits/tabby/webhook',
  express.json({ limit: '50mb' }),
  async (req, res) => {
    try {
      const { handleTabbyWebhook } = require('./controllers/brandProject/brandProjectController');
      return handleTabbyWebhook(req, res);
    } catch (err) {
      console.error('[tabby webhook] handler failed:', err);
      res.status(500).send('error');
    }
  }
);

app.post(
  '/api/v1/brand-projects/credits/tamara/webhook',
  express.json({ limit: '50mb' }),
  async (req, res) => {
    try {
      const { handleTamaraWebhook } = require('./controllers/brandProject/brandProjectController');
      return handleTamaraWebhook(req, res);
    } catch (err) {
      console.error('[tamara webhook] handler failed:', err);
      res.status(500).send('error');
    }
  }
);

// WhatsApp endpoint
if (process.env.NODE_ENV !== 'test') {
  try {
    const auth = require('./middelwares/auth');
    const { requireRole } = require('./middelwares/auth');
    app.post("/api/sendWhatsappMessage", auth, requireRole('admin', 'superadmin'), async (req, res) => {
      try {
        const { sendWhatsappMessage } = require("./utills/whatsAppMessage");
        const result = await sendWhatsappMessage(req.body);
        if (!result.ok) {
          return res.status(result.simulated ? 503 : 400).json({ success: false, ...result });
        }
        return res.json({ success: true, sid: result.sid });
      } catch (err) {
        console.error('[whatsApp endpoint] error:', err);
        return res.status(500).json({ success: false, error: 'server_error' });
      }
    });
  } catch (err) {
    console.warn('⚠️ WhatsApp endpoint not available:', err.message);
  }
}

// ════════════════════════════════════════════════════════════════
// 🛑 JSON ERROR HANDLERS
// ════════════════════════════════════════════════════════════════

app.use('/api', (req, res) => {
  res.status(404).json({
    status: 'fail',
    message: 'API endpoint not found',
    path: req.path,
    method: req.method
  });
});

app.use((err, req, res, next) => {
  console.error('💥 Error:', err.message);
  console.error('Stack:', err.stack);
  
  if (req.path.startsWith('/api')) {
    const status = err.statusCode || 500;
    res.status(status).json({
      status: 'fail',
      message: err.message || 'Internal server error',
      ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
    });
  } else {
    res.status(err.status || 500).send('<h1>Something went wrong</h1>');
  }
});

// ════════════════════════════════════════════════════════════════
// 🚀 START SERVER - START FIRST, CONNECT DB AFTER
// ════════════════════════════════════════════════════════════════
if (require.main === module) {
  const http = require('http');

  // ✅ START SERVER IMMEDIATELY (don't wait for DB)
  const server = http.createServer(app);

  // Initialize WebSocket Server (if available)
  let wsServer;
  try {
    const WebSocketServer = require('./websocket-server');
    wsServer = new WebSocketServer(server);
    const { handleWebSocket } = require('./controllers/chat/chatController');
    handleWebSocket(wsServer.io);
    app.set('wsServer', wsServer);
  } catch (err) {
    console.warn('⚠️ WebSocket server not available:', err.message);
  }

  // ✅ Listen on all interfaces for Railway
  server.listen(PORT, '0.0.0.0', () => {
    const protocol = process.env.HTTPS === "true" || process.env.NODE_ENV === "production" ? "https" : "http";
    const host = process.env.RAILWAY_PUBLIC_DOMAIN || 'localhost';
    
    console.log(`🚀 Qumak API running!`);
    console.log(`🌐 URL: ${protocol}://${host}:${PORT}`);
    console.log(`❤️  Health: ${protocol}://${host}:${PORT}/health`);
    console.log(`🧪 Test: ${protocol}://${host}:${PORT}/api/test`);
    console.log(`🔴 Redis Status: ${protocol}://${host}:${PORT}/api/redis-status`);
    console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`📦 Session Store: ${redisStore ? 'Redis' : 'Memory'}`);
    
    // ✅ THEN try to connect to DB (don't crash if it fails)
    const DATABASE_URL = process.env.DB_URL || "mongodb://127.0.0.1:27017";
    const DATABASE = process.env.DB || "qumak";
    
    console.log(`📦 Attempting to connect to MongoDB...`);
    
    db(DATABASE_URL, DATABASE)
      .then(() => {
        console.log('✅ MongoDB connected successfully');
        
        // Start workers only after DB is connected
        if (process.env.NODE_ENV !== 'test' && process.env.STUDIO_WORKER_INPROC !== 'false') {
          try {
            require('./workers/videoWorker');
            console.log('🎞  Video worker booted');
          } catch (err) {
            console.warn('⚠️ Video worker failed:', err.message);
          }
        }

        if (process.env.NODE_ENV !== 'test' && process.env.INTELLIGENCE_WORKER_INPROC !== 'false') {
          try {
            const { startIntelligenceWorker } = require('./workers/intelligenceWorker');
            startIntelligenceWorker();
            console.log('🧠 Intelligence worker booted');
          } catch (err) {
            console.warn('⚠️ Intelligence worker failed:', err.message);
          }
        }

        if (process.env.NODE_ENV !== 'test' && process.env.URL_ADS_ENRICH_WORKER_INPROC !== 'false') {
          try {
            const { startUrlToAdsEnrichWorker } = require('./workers/urlToAdsEnrichWorker');
            startUrlToAdsEnrichWorker();
            console.log('📊 URL→Ads enrich worker booted');
          } catch (err) {
            console.warn('⚠️ URL→Ads enrich worker failed:', err.message);
          }
        }

        if (process.env.NODE_ENV !== 'test' && process.env.WEEKLY_DIGEST_CRON !== 'false') {
          try {
            const cron = require('node-cron');
            cron.schedule(
              '0 9 * * 1',
              () => {
                require('./jobs/weeklyDigestJob')
                  .runWeeklyDigest()
                  .catch((e) => console.error('[weeklyDigest]', e.message));
              },
              { timezone: 'Asia/Dubai' }
            );
            console.log('📧 Weekly digest cron scheduled');
          } catch (err) {
            console.warn('⚠️ Weekly digest cron not started:', err.message);
          }
        }

        // Bridge Redis pub/sub (if available)
        try {
          const { setupJobUpdateSubscriber } = require('./utils/socketEmitter');
          if (wsServer) {
            setupJobUpdateSubscriber(wsServer.io);
            console.log('🎬 Redis pub/sub bridge initialized');
          }
        } catch (err) {
          console.warn('⚠️ Redis pub/sub not available:', err.message);
        }
      })
      .catch((err) => {
        console.error('⚠️ MongoDB connection failed:', err.message);
        console.log('⚠️ Server will continue running without database');
        console.log('⚠️ API endpoints that need DB will return errors');
      });

    console.log('✅ Server ready!');
  });

  // ✅ Graceful shutdown for Railway
  process.on('SIGTERM', () => {
    console.log('🔴 SIGTERM received, shutting down gracefully...');
    
    // Close Redis connection
    if (redisClient) {
      redisClient.quit();
    }
    
    server.close(() => {
      console.log('✅ Server closed');
      process.exit(0);
    });
  });

  process.on('SIGINT', () => {
    console.log('🔴 SIGINT received, shutting down gracefully...');
    
    // Close Redis connection
    if (redisClient) {
      redisClient.quit();
    }
    
    server.close(() => {
      console.log('✅ Server closed');
      process.exit(0);
    });
  });
}

module.exports = app;