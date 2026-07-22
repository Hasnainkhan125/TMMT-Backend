
function normalizeSessionKey(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  if (!s) return null;
  return s.length > 128 ? s.slice(0, 128) : s;
}

function readSessionFromHeadersCookies(req) {
  const h = normalizeSessionKey(req.headers['x-session-id']);
  if (h) return h;
  return normalizeSessionKey(req.cookies?.[STUDIO_SESSION_COOKIE]);
}

function getStudioSessionId(req) {
  const fromReq = normalizeSessionKey(req.sessionId);
  if (fromReq) return fromReq;
  return readSessionFromHeadersCookies(req);
}

export const getSessionId = (req)=> {
    return getStudioSessionId(req);
  }
  
  export const ownerFromReq = (req)=> {
    return {
      userId: req.user?._id || null,
      sessionId: getSessionId(req),
    };
  }

  export const getUserId = (req)=> {
    return req.user?._id || null;
  }