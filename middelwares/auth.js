const jwt = require("jsonwebtoken");

// Fail-fast on missing JWT_SECRET in production. The previous default
// "your-secret-key-change-in-production" allowed anyone with public knowledge
// of this codebase to forge tokens.
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  // eslint-disable-next-line no-console
  console.error('[auth] FATAL: JWT_SECRET is not set in production. Refusing to start.');
  process.exit(1);
}

const DEV_FALLBACK_SECRET = "qumak-dev-only-secret-do-not-use-in-prod";

const auth = (req, res, next) => {
  const secret = process.env.JWT_SECRET || DEV_FALLBACK_SECRET;

  // Collect token candidates in priority order
  const authHeader = req.headers.authorization || "";
  const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.split(" ")[1] : null;
  const cookieToken = req.cookies?.token || null;

  // Filter out empty/falsy/garbage values (e.g. the string "undefined" from bad localStorage)
  const tokens = [bearerToken, cookieToken].filter(
    (t) => t && t !== "undefined" && t !== "null" && t.includes(".")
  );

  if (tokens.length === 0) {
    return res.status(401).json({
      success: false,
      message: "Authentication failed, Token missing"
    });
  }

  // Try each token — if Bearer is malformed, fall back to HttpOnly cookie
  for (const token of tokens) {
    try {
      const decoded = jwt.verify(token, secret);
      req.user = decoded;
      req.user._id = decoded.userId;
      return next();
    } catch (err) {
      // This token failed, try the next one
      continue;
    }
  }

  // All tokens failed
  return res.status(401).json({
    success: false,
    message: "Authentication failed. Invalid token."
  });
};

const requireRole = (...roles) => (req, res, next) => {
  const role = req.user?.role || req.auth?.role;
  if (!role || !roles.includes(role)) {
    return res.status(403).json({ 
      success: false,
      message: "Forbidden: insufficient role" 
    });
  }
  next();
};

// Soft-auth: same token resolution as `auth`, but never rejects. Used by
// the studio "ext" routes (copy / refine / download) where anonymous
// session-id callers are valid but a logged-in user gets richer ownership
// & credit handling.
const optionalAuth = (req, _res, next) => {
  const secret = process.env.JWT_SECRET || DEV_FALLBACK_SECRET;
  const authHeader = req.headers.authorization || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
  const cookieToken = req.cookies?.token || null;
  const tokens = [bearerToken, cookieToken].filter(
    (t) => t && t !== 'undefined' && t !== 'null' && t.includes('.')
  );
  for (const token of tokens) {
    try {
      const decoded = jwt.verify(token, secret);
      req.user = decoded;
      req.user._id = decoded.userId;
      break;
    } catch (_err) { /* ignore — optional */ }
  }
  return next();
};

module.exports = auth;
module.exports.requireRole = requireRole;
module.exports.optionalAuth = optionalAuth;
