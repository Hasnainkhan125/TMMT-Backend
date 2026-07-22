// ─── dotenv FIRST ────────────────────────────────────────────────────────
// MUST be the very first thing we do. Several modules (most notably
// middleware/s3Upload.js and services/storageService.js) decide at
// require-time whether Cloudflare R2 is configured by reading
// process.env.R2_ACCESS_KEY_ID et al. If any `require()` below runs before
// `dotenv.config()` and that require transitively loads s3Upload, the
// module caches "R2 not configured" for the lifetime of the process — so
// every studio upload silently falls back to local disk and returns
// http://localhost:5001/uploads/... URLs that FAL cannot fetch (422).
// This exact bug cost us the reel-generation path. Keep dotenv at line 1.
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

const studioRoutes = require('./controllers/studio/_routes');
const studioExtRoutes = require('./controllers/studio/_extRoutes');
const modelsRoutes = require('./routes/models');
const templatesRoutes = require('./routes/templates');
const creditsRoutes = require('./routes/credits');
const billingRoutes = require('./routes/billing.routes');

const {GenerationTemplate} = require('./model/schema/GenerationTemplate');
const allowedOrigins = [
	"http://localhost:5173",
	"http://localhost:5174",
	"https://qumak.io",
	"https://www.qumak.io",
  "https://tammat.netlify.app",  
  ];


//Setup Express App
const app = express();

// Middleware
app.use(bodyParser.json({ limit: '50mb' }));
app.use(cookieParser());
app.use(express.json({limit:"50mb"}));


// Configure session middleware for OAuth state management.
// Fail-fast in production if neither SESSION_SECRET nor JWT_SECRET is set.
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
    secure: isProduction, // Only send over HTTPS in production
    httpOnly: true,
    maxAge: 10 * 60 * 1000, // 10 minutes (enough for OAuth flow)
    sameSite: isProduction ? 'none' : 'lax'
  },
  name: 'qumak.sid' // Custom session name
}));

// ─── Observability (Phase 8) ─────────────────────────────────────────────
// Request-id + per-request child logger + access log line on finish.
// MUST come before routes so every handler gets `req.log` / `req.id`.
const requestContext = require('./middelwares/requestContext');
app.use(requestContext);  
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

app.use("/uploads", express.static(path.join(__dirname, "uploads")));

app.use("/api", route);
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/visa', visaRoutes);
app.use('/api/v1/chat', chatRoutes);
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





const metrics = require('./utils/metrics');
app.get('/metrics', metrics.handler);

app.get("/health",async (req, res) => {

	const templates =  await GenerationTemplate.find({})
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


// ─── Stripe webhooks MUST be mounted BEFORE bodyParser.json() ────────────
// Stripe signature verification requires the raw request body.
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
  
  // ─── Tabby + Tamara webhooks ─────────────────────────────────────────────
  // Their bodies are plain JSON; we don't need raw-body access for signing.
  // They're declared here for grouping with the Stripe webhook above.
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

// Brand Builder (Perfume / Skincare / Custom)
const brandProjectRoutes = require('./routes/brandProject');
app.use('/api/v1/brand-projects', brandProjectRoutes);

// Trade License Application
const tradeLicenseRoutes = require('./routes/tradeLicense');
app.use('/api/v1/brand-projects/:brandId/trade-license', tradeLicenseRoutes);


// Store & Products
const storeRoutes = require('./controllers/store/_routes');
app.use('/api/v1/store', storeRoutes);


// In your app.js
const brandUrlToAdsRoutes = require('./routes/brand.routes');
app.use('/api/v1/brand', brandUrlToAdsRoutes);
// AI Brand Engine (public + protected)
const aiBrandRoutes = require('./routes/aiBrand');
app.use('/api/v1/brand-ai', aiBrandRoutes);
// Image Generation Engine (purified prompts + token tracking)
const imageRoutes = require('./routes/images');
app.use('/api/v1/images', imageRoutes);
// Facebook Business SDK (OAuth + posting + insights + Meta MENA campaign launcher)
const facebookRoutes = require('./routes/facebook');
app.use('/api/v1/facebook', facebookRoutes);
// Snap Marketing API (MENA SME ad launcher)
const snapRoutes = require('./routes/snap');
app.use('/api/v1/snap', snapRoutes);




// Studio — AI Ad Video Generation

app.use('/api/v1/studio', studioRoutes);
// Studio Extended Routes
app.use('/api/v1/studio', studioExtRoutes);
// AI model registry (image/video models exposed in the Studio model picker).
app.use('/api/v1/models', modelsRoutes);
// GenerationTemplate intelligence layer — gallery, dynamic forms, model routing.
// Exposes /api/v1/templates/* (browse, by-id, similar, etc.).
app.use('/api/v1/templates', templatesRoutes);
// Per-user credit balance + ledger + per-generation cost quote.
app.use('/api/v1/me/credits', creditsRoutes);
// app.js — billing routes
app.use('/api/v1/billing', billingRoutes);



// Autonomous Brand Registry — create, manage, and configure autonomous brands.
const brandRoutes = require('./controllers/brand/_routes');
app.use('/api/v1/brands', brandRoutes);



// Chat WebSocket routes
const { router: chatWebSocketRoutes, setupWebSocket } = require('./routes/chat');
app.use('/api/chat', chatWebSocketRoutes);


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

module.exports = app;



if (require.main === module) {
	const http = require('http');
	const WebSocketServer = require('./websocket-server');

	const server = http.createServer(app);

	const wsServer = new WebSocketServer(server);

	const { handleWebSocket } = require('./controllers/chat/chatController');
	handleWebSocket(wsServer.io);

	app.set('wsServer', wsServer);

	server.listen(port, () => {
		const protocol =
			process.env.HTTPS === "true" || process.env.NODE_ENV === "production"
				? "https"
				: "http";
		const { address, port } = server.address();
		const host = address === "::" ? "127.0.0.1" : address;
		console.log(`🚀 QUMAK Visa Services Platform listening at ${protocol}://${host}:${port}`);
		console.log(`🔌 WebSocket server available at ws://${host}:${port}`);
		console.log(`🤖 AI Features: ${require('./services/openaiService').isAvailable() ? 'Enabled' : 'Disabled'}`);
		console.log(`📋 Services Catalog: ${require('./services/catalogLoader').getStats().totalServices} services available`);
		// Bridge Redis pub/sub → socket.io for Studio job updates
		const { setupJobUpdateSubscriber } = require('./utils/socketEmitter');
		setupJobUpdateSubscriber(wsServer.io);
		console.log('🎬 Qumak Studio: Redis pub/sub bridge initialized');

		// Boot the BullMQ worker in-process for dev. Spawning a separate
		// process is a deployment concern (PM2 / systemd); for `npm run dev`
		// we just want jobs to actually run when the API runs.
		// Skip in tests to keep them hermetic.
		if (process.env.NODE_ENV !== 'test' && process.env.STUDIO_WORKER_INPROC !== 'false') {
			try {
				require('./workers/videoWorker');
				console.log('🎞  Qumak Studio: in-process video worker booted');
			} catch (err) {
				console.error('⚠️  Qumak Studio: failed to boot in-process worker:', err.message);
				console.error('   → run `node workers/videoWorker.js` in a separate shell to recover');
			}
		}

		// Competitor Intelligence worker pool — consumes the `brand-intelligence`
		// queue. Separate from the video worker so a runaway Playwright/Meta
		// scrape can't starve ad-generation jobs and vice versa.
		if (process.env.NODE_ENV !== 'test' && process.env.INTELLIGENCE_WORKER_INPROC !== 'false') {
			try {
				const { startIntelligenceWorker } = require('./workers/intelligenceWorker');
				startIntelligenceWorker();
				console.log('🧠 Qumak Intelligence: in-process collection worker booted (concurrency=' + (process.env.INTELLIGENCE_WORKER_CONCURRENCY || 4) + ')');
			} catch (err) {
				console.error('⚠️  Qumak Intelligence: failed to boot in-process worker:', err.message);
				console.error('   → run `node workers/intelligenceWorker.js` in a separate shell to recover');
			}
		}

		if (process.env.NODE_ENV !== 'test' && process.env.URL_ADS_ENRICH_WORKER_INPROC !== 'false') {
			try {
				const { startUrlToAdsEnrichWorker } = require('./workers/urlToAdsEnrichWorker');
				startUrlToAdsEnrichWorker();
				console.log('📊 Qumak URL→Ads: Apify enrich worker booted (concurrency=' + (process.env.URL_ADS_ENRICH_CONCURRENCY || 2) + ')');
			} catch (err) {
				console.error('⚠️  URL→Ads enrich worker failed to boot:', err.message);
				console.error('   → run `node workers/urlToAdsEnrichWorker.js` in a separate shell');
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
					{ timezone: 'Asia/Dubai' },
				);
				console.log('📧 Weekly digest cron scheduled (Mon 09:00 Asia/Dubai)');
			} catch (err) {
				console.warn('⚠️  Weekly digest cron not started:', err.message);
			}
		}

		// Loud, actionable warning if fal.ai isn't configured. Without this
		// every generation 401s with "Unauthorized" and credits get refunded
		// silently — debugging that is awful, so we surface it at boot.
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
	const DATABASE_URL = process.env.DB_URL || "mongodb://127.0.0.1" + ":27017";
	const DATABASE = process.env.DB || "qumak";

	db(DATABASE_URL, DATABASE);
	  

	
}
