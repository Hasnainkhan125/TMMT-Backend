'use strict';

const axios = require('axios');
const UserMetaConnection = require('../../model/schema/userMetaConnection');

const SCOPES = [
  'ads_management',
  'ads_read',
  'business_management',
  'pages_show_list',
  'pages_read_engagement',
].join(',');

async function connect(req, res) {
  const appId = process.env.META_APP_ID;
  const redirectUri = process.env.META_REDIRECT_URI;
  if (!appId || !redirectUri) {
    return res.status(503).json({
      success: false,
      error: 'meta_not_configured',
      message: 'Meta OAuth is not configured on this server.',
    });
  }
  const uid = req.user?._id || req.user?.id;
  if (!uid) {
    return res.status(401).json({
      success: false,
      error: 'unauthorized',
      message: 'Sign in to connect your Meta account.',
    });
  }
  const state = Buffer.from(JSON.stringify({ u: String(uid) }), 'utf8').toString('base64url');
  const url =
    `https://www.facebook.com/v21.0/dialog/oauth?client_id=${encodeURIComponent(appId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${encodeURIComponent(SCOPES)}` +
    `&state=${encodeURIComponent(state)}`;
  return res.redirect(302, url);
}

async function callback(req, res) {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  const redirectUri = process.env.META_REDIRECT_URI;
  const code = req.query.code;
  const state = req.query.state;
  if (!appId || !appSecret || !redirectUri) {
    return res.status(503).send('Meta OAuth not configured');
  }
  if (!code || !state) {
    return res.status(400).send('Missing code or state');
  }

  let userId;
  try {
    const parsed = JSON.parse(Buffer.from(String(state), 'base64url').toString('utf8'));
    userId = parsed.u;
  } catch (_e) {
    return res.status(400).send('Invalid state');
  }
  if (!userId) return res.status(400).send('Invalid state payload');

  try {
    const tokenUrl = 'https://graph.facebook.com/v21.0/oauth/access_token';
    const { data } = await axios.get(tokenUrl, {
      params: {
        client_id: appId,
        client_secret: appSecret,
        redirect_uri: redirectUri,
        code,
      },
      timeout: 15000,
    });
    const accessToken = data.access_token;
    const expiresIn = data.expires_in;
    await UserMetaConnection.findOneAndUpdate(
      { userId },
      {
        accessToken,
        expiresAt: expiresIn ? new Date(Date.now() + Number(expiresIn) * 1000) : null,
        scopes: SCOPES.split(','),
      },
      { upsert: true, new: true },
    );
    return res.redirect(302, '/studio/url-to-ads?meta=connected');
  } catch (e) {
    console.error('[metaOAuth] callback error:', e.response?.data || e.message);
    return res.status(502).send('Could not complete Meta connection');
  }
}

module.exports = { connect, callback };
