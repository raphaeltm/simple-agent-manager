import { Hono } from 'hono';
import type { Env } from '../index';
import { errors } from '../middleware/error';
import { requireAuth, requireApproved } from '../middleware/auth';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

const googleAuthRoutes = new Hono<{ Bindings: Env }>();

/**
 * GET /auth/google/authorize - Start Google OAuth flow for GCP integration.
 * This is NOT for user login — it's for connecting a GCP project.
 * Requires the user to already be authenticated via GitHub OAuth.
 */
googleAuthRoutes.get('/authorize', requireAuth(), requireApproved(), async (c) => {
  if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) {
    throw errors.badRequest('Google OAuth is not configured on this SAM instance');
  }

  // Generate CSRF state token and store in KV
  const state = crypto.randomUUID();
  await c.env.KV.put(`google-oauth-state:${state}`, 'valid', {
    expirationTtl: 600, // 10 minute expiry
  });

  const redirectUri = `https://api.${c.env.BASE_DOMAIN}/auth/google/callback`;
  const params = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    access_type: 'online', // No refresh token needed — ephemeral use only
    state,
    prompt: 'consent', // Always show consent to ensure we get the right scopes
  });

  return c.redirect(`${GOOGLE_AUTH_URL}?${params.toString()}`);
});

/**
 * GET /auth/google/callback - Handle Google OAuth callback.
 * Exchanges the authorization code for an access token and redirects
 * back to the frontend with the token as a URL fragment.
 */
googleAuthRoutes.get('/callback', async (c) => {
  if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) {
    throw errors.badRequest('Google OAuth is not configured');
  }

  const code = c.req.query('code');
  const state = c.req.query('state');
  const error = c.req.query('error');

  if (error) {
    // User denied consent or other OAuth error
    const appUrl = `https://app.${c.env.BASE_DOMAIN}/settings/cloud-provider?gcp_error=${encodeURIComponent(error)}`;
    return c.redirect(appUrl);
  }

  if (!code || !state) {
    throw errors.badRequest('Missing authorization code or state');
  }

  // Validate CSRF state
  const storedState = await c.env.KV.get(`google-oauth-state:${state}`);
  if (!storedState) {
    throw errors.badRequest('Invalid or expired OAuth state');
  }
  // Delete used state token
  await c.env.KV.delete(`google-oauth-state:${state}`);

  // Exchange authorization code for access token
  const redirectUri = `https://api.${c.env.BASE_DOMAIN}/auth/google/callback`;
  const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: c.env.GOOGLE_CLIENT_ID,
      client_secret: c.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });

  if (!tokenResponse.ok) {
    const errorBody = await tokenResponse.text();
    console.error('Google token exchange failed:', errorBody);
    const appUrl = `https://app.${c.env.BASE_DOMAIN}/settings/cloud-provider?gcp_error=token_exchange_failed`;
    return c.redirect(appUrl);
  }

  const tokenData = (await tokenResponse.json()) as {
    access_token: string;
    token_type: string;
    expires_in: number;
    scope: string;
  };

  // Store the OAuth token server-side in KV with a short-lived opaque handle.
  // This avoids exposing the full cloud-platform-scoped token in URL params
  // (which would leak to browser history, server logs, and Referer headers).
  const handle = crypto.randomUUID();
  await c.env.KV.put(`gcp-oauth-token:${handle}`, tokenData.access_token, {
    expirationTtl: 300, // 5 minutes — enough time for the setup wizard
  });

  const appUrl = `https://app.${c.env.BASE_DOMAIN}/settings/cloud-provider?gcp_setup=${encodeURIComponent(handle)}`;
  return c.redirect(appUrl);
});

export { googleAuthRoutes };
