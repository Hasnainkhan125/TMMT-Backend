const jwt = require("jsonwebtoken");

if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  console.error('[auth] FATAL: JWT_SECRET is not set in production. Refusing to start.');
  process.exit(1);
}

const DEV_FALLBACK_SECRET = "qumak-dev-only-secret-do-not-use-in-prod";

const auth = (req, res, next) => {
  const secret = process.env.JWT_SECRET || DEV_FALLBACK_SECRET;

  const authHeader = req.headers.authorization || "";
  const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.split(" ")[1] : null;
  const cookieToken = req.cookies?.token || null;

  const tokens = [bearerToken, cookieToken].filter(
    (t) => t && t !== "undefined" && t !== "null" && t.includes(".")
  );

  if (tokens.length === 0) {
    return res.status(401).json({
      success: false,
      message: "Authentication failed: Token missing"
    });
  }

  for (const token of tokens) {
    try {
      const decoded = jwt.verify(token, secret);
      req.user = decoded;
      req.user._id = decoded.userId;
      return next();
    } catch (err) {
      continue;
    }
  }

  return res.status(401).json({
    success: false,
    message: "Authentication failed: Invalid token"
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
    } catch (_err) { /* ignore */ }
  }
  return next();
};

module.exports = auth;
module.exports.requireRole = requireRole;
module.exports.optionalAuth = optionalAuth;