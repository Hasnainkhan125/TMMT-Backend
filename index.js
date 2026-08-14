// ─── dotenv FIRST ────────────────────────────────────────────────────────
require("dotenv").config();

const express = require("express");
const db = require("./db/config");
const route = require("./controllers/route");
const bodyParser = require("body-parser");
const cookieParser = require("cookie-parser");
const session = require("express-session");
const cors = require("cors");
const port = 5001;
const fs = require("fs");
const path = require("path");

require('./services/resolver/enrichment/enrichmentQueue');
const visaRoutes = require('./controllers/visa/_routes');
const authRoutes = require('./controllers/auth/_routes');
const chatRoutes = require('./controllers/chat/_routes');
const servicesRoutes = require('./controllers/services/_routes');
const notificationsRoutes = require('./controllers/notifications/_routes');
const dependentsRoutes = require('./controllers/dependents/_routes');
const paymentsRoutes = require('./controllers/payments/_routes');
const adminRoutes = require('./controllers/admin/_routes');
const userRoutes = require('./controllers/user/_routes');
const businessSetupRoutes = require('./controllers/businessSetup/_routes');
const familyVisaRoutes = require('./controllers/familyVisa/_routes');
const popupLeadsRoutes = require('./controllers/popupLeads/_routes');
const jobRoutes = require('./controllers/jobs/_routes');
const marketplaceRoutes = require('./controllers/marketplace/_routes');
const blogRoutes = require('./controllers/blog/_routes');
const leadsRoutes = require('./controllers/brandProject/leadsRoutes');
const checksRoutes = require('./controllers/checks/_routes');
const packageRoutes = require('./controllers/package/_routes');

const studioRoutes = require('./controllers/studio/_routes');
const studioExtRoutes = require('./controllers/studio/_extRoutes');
const modelsRoutes = require('./routes/models');
const templatesRoutes = require('./routes/templates');
const creditsRoutes = require('./routes/credits');
const billingRoutes = require('./routes/billing.routes');

const { GenerationTemplate } = require('./model/schema/GenerationTemplate');
const allowedOrigins = [
  "http://localhost:5173",
  "http://localhost:5174",
  "https://qumak.io",
  "https://www.qumak.io",
  "https://tammat.netlify.app",
  "https://tmmtae.netlify.app",
];

//Setup Express App
const app = express();

// Middleware
app.use(bodyParser.json({ limit: '50mb' }));
app.use(cookieParser());
app.use(express.json({ limit: "50mb" }));

// Session middleware
const isProduction = process.env.NODE_ENV === 'production';
const sessionSecret = process.env.SESSION_SECRET || process.env.JWT_SECRET;
if (isProduction && !sessionSecret) {
  console.error('[index] FATAL: SESSION_SECRET (or JWT_SECRET) must be set in production.');
  process.exit(1);
}

app.use(session({
  secret: sessionSecret || 'qumak-dev-only-session-secret-do-not-use-in-prod',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: isProduction,
    httpOnly: true,
    maxAge: 10 * 60 * 1000,
    sameSite: isProduction ? 'none' : 'lax'
  },
  name: 'qumak.sid'
}));

// Request-id + per-request logger
const requestContext = require('./middelwares/requestContext');
app.use(requestContext);

// CORS
const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.warn(`CORS blocked origin: ${origin}`);
      callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: true,
};
app.use(cors(corsOptions));

// Static files
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// ─── Routes ─────────────────────────────────────────────────────────────
app.use("/api", route);
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/visa', visaRoutes);
app.use('/api/v1/chat', chatRoutes);
app.use('/api/v1/checks', checksRoutes);
app.use('/api/v1/services', servicesRoutes);
app.use('/api/v1/notifications', notificationsRoutes);
app.use('/api/v1/dependents', dependentsRoutes);
app.use('/api/v1/services/payments', paymentsRoutes);
app.use('/api/v1/admin', adminRoutes);
app.use('/api/v1/user', userRoutes);
app.use('/api/v1/business-setup', businessSetupRoutes);
app.use('/api/v1/family-visa', familyVisaRoutes);
app.use('/api/v1/popup-leads', popupLeadsRoutes);
app.use('/api/v1/jobs', jobRoutes);
app.use('/api/v1/marketplace', marketplaceRoutes);
app.use('/api/v1/blog', blogRoutes);
app.use('/api/v1/leads', leadsRoutes);
app.use('/api/v1/package-applications', packageRoutes);

const metrics = require('./utils/metrics');
app.get('/metrics', metrics.handler);

app.get("/health", async (req, res) => {
  const templates = await GenerationTemplate.find({});
  const templateUrls = templates.map(template => template.media.previewVideo);
  console.log(templateUrls);
  fs.writeFileSync('templatesUrls.json', JSON.stringify(templateUrls, null, 2));
  res.status(200).json({
    success: true,
    service: "qumak-api",
    message: "Qumak API is healthy",
    version: process.env.APP_VERSION || "1.0.0",
    env: process.env.NODE_ENV || "development",
    timestamp: new Date().toISOString(),
  });
});

app.get("/", async (req, res) => {
  res.json({
    service: "qumak-api",
    message: "Welcome to Qumak — the Arabic-first AI ad agency for GCC SMEs.",
    description: "Paste your Instagram handle, get Arabic+English ads in 60 seconds, launch to Snap/Meta/TikTok MENA.",
    docs: "https://qumak.ae/docs",
    version: process.env.APP_VERSION || "1.0.0"
  });
});

// ─── Stripe webhooks ────────────────────────────────────────────────────
app.post(
  '/api/v1/brand-projects/credits/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
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

// Brand Builder
const brandProjectRoutes = require('./routes/brandProject');
app.use('/api/v1/brand-projects', brandProjectRoutes);

const tradeLicenseRoutes = require('./routes/tradeLicense');
app.use('/api/v1/brand-projects/:brandId/trade-license', tradeLicenseRoutes);

const storeRoutes = require('./controllers/store/_routes');
app.use('/api/v1/store', storeRoutes);

const brandUrlToAdsRoutes = require('./routes/brand.routes');
app.use('/api/v1/brand', brandUrlToAdsRoutes);

const aiBrandRoutes = require('./routes/aiBrand');
app.use('/api/v1/brand-ai', aiBrandRoutes);

const imageRoutes = require('./routes/images');
app.use('/api/v1/images', imageRoutes);

const facebookRoutes = require('./routes/facebook');
app.use('/api/v1/facebook', facebookRoutes);

const snapRoutes = require('./routes/snap');
app.use('/api/v1/snap', snapRoutes);

// Studio
app.use('/api/v1/studio', studioRoutes);
app.use('/api/v1/studio', studioExtRoutes);
app.use('/api/v1/models', modelsRoutes);
app.use('/api/v1/templates', templatesRoutes);
app.use('/api/v1/me/credits', creditsRoutes);
app.use('/api/v1/billing', billingRoutes);

const brandRoutes = require('./controllers/brand/_routes');
app.use('/api/v1/brands', brandRoutes);

const { router: chatWebSocketRoutes } = require('./routes/chat');
app.use('/api/chat', chatWebSocketRoutes);

// WhatsApp endpoint
if (process.env.NODE_ENV !== 'test') {
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
}

// ════════════════════════════════════════════════════════════════
// 🛑 JSON ERROR HANDLERS
// ════════════════════════════════════════════════════════════════

app.use('/api', (req, res) => {
  res.status(404).json({
    status: 'fail',
    message: 'API endpoint not found'
  });
});

app.use((err, req, res, next) => {
  if (req.path.startsWith('/api')) {
    const status = err.statusCode || 500;
    res.status(status).json({
      status: 'fail',
      message: err.message || 'Internal server error'
    });
  } else {
    res.status(err.status || 500).send('<h1>Something went wrong</h1>');
  }
});

// ════════════════════════════════════════════════════════════════
// 🚀 START SERVER - CONNECT TO DB FIRST!
// ════════════════════════════════════════════════════════════════
if (require.main === module) {
  const http = require('http');
  const WebSocketServer = require('./websocket-server');

  // ✅ CONNECT TO MONGODB FIRST
  const DATABASE_URL = process.env.DB_URL || "mongodb://127.0.0.1:27017";
  const DATABASE = process.env.DB || "qumak";
  
  console.log(`📦 Connecting to MongoDB at ${DATABASE_URL}/${DATABASE}...`);
  
  db(DATABASE_URL, DATABASE)
    .then(() => {
      console.log('✅ MongoDB connected successfully');
      
      // ✅ NOW start the server
      const server = http.createServer(app);

      // Initialize WebSocket Server
      const wsServer = new WebSocketServer(server);
      const { handleWebSocket } = require('./controllers/chat/chatController');
      handleWebSocket(wsServer.io);
      app.set('wsServer', wsServer);

      server.listen(port, () => {
        const protocol = process.env.HTTPS === "true" || process.env.NODE_ENV === "production" ? "https" : "http";
        const { address, port } = server.address();
        const host = address === "::" ? "127.0.0.1" : address;
        console.log(`🚀 QUMAK Visa Services Platform listening at ${protocol}://${host}:${port}`);
        console.log(`🔌 WebSocket server available at ws://${host}:${port}`);
        console.log(`🤖 AI Features: ${require('./services/openaiService').isAvailable() ? 'Enabled' : 'Disabled'}`);
        console.log(`📋 Services Catalog: ${require('./services/catalogLoader').getStats().totalServices} services available`);
        
        // Bridge Redis pub/sub → socket.io
        const { setupJobUpdateSubscriber } = require('./utils/socketEmitter');
        setupJobUpdateSubscriber(wsServer.io);
        console.log('🎬 Qumak Studio: Redis pub/sub bridge initialized');

        // Start workers...
        if (process.env.NODE_ENV !== 'test' && process.env.STUDIO_WORKER_INPROC !== 'false') {
          try {
            require('./workers/videoWorker');
            console.log('🎞  Qumak Studio: in-process video worker booted');
          } catch (err) {
            console.error('⚠️  Qumak Studio: failed to boot in-process worker:', err.message);
          }
        }

        if (process.env.NODE_ENV !== 'test' && process.env.INTELLIGENCE_WORKER_INPROC !== 'false') {
          try {
            const { startIntelligenceWorker } = require('./workers/intelligenceWorker');
            startIntelligenceWorker();
            console.log('🧠 Qumak Intelligence: in-process collection worker booted');
          } catch (err) {
            console.error('⚠️  Qumak Intelligence: failed to boot in-process worker:', err.message);
          }
        }

        if (process.env.NODE_ENV !== 'test' && process.env.URL_ADS_ENRICH_WORKER_INPROC !== 'false') {
          try {
            const { startUrlToAdsEnrichWorker } = require('./workers/urlToAdsEnrichWorker');
            startUrlToAdsEnrichWorker();
            console.log('📊 Qumak URL→Ads: Apify enrich worker booted');
          } catch (err) {
            console.error('⚠️  URL→Ads enrich worker failed to boot:', err.message);
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
            console.log('📧 Weekly digest cron scheduled (Mon 09:00 Asia/Dubai)');
          } catch (err) {
            console.warn('⚠️  Weekly digest cron not started:', err.message);
          }
        }

        if (!process.env.FAL_API_KEY && !process.env.FAL_KEY) {
          console.warn('');
          console.warn('⚠️  ───────────────────────────────────────────────────────────');
          console.warn('⚠️   FAL_API_KEY is NOT set in qumak-backend/.env');
          console.warn('⚠️   Image / video generation will fail with "Unauthorized".');
          console.warn('⚠️   Get a key at https://fal.ai/dashboard/keys and add:');
          console.warn('⚠️       FAL_API_KEY=-************');
          console.warn('⚠️   Then restart the API.');
          console.warn('⚠️  ───────────────────────────────────────────────────────────');
          console.warn('');
        }
      });
    })
    .catch((err) => {
      console.error('❌ Failed to connect to MongoDB:', err.message);
      console.error('Please make sure MongoDB is running:');
      console.error('  sudo systemctl start mongod');
      process.exit(1);
    });
}

module.exports = app;