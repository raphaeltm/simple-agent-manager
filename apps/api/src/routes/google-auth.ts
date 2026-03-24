import { Hono } from 'hono';
import type { Env } from '../index';
import { errors } from '../middleware/error';
import { requireAuth, requireApproved, getUserId } from '../middleware/auth';

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

  const userId = getUserId(c);

  // Generate CSRF state token and store in KV with userId for callback verification
  const state = crypto.randomUUID();
  await c.env.KV.put(`google-oauth-state:${state}`, JSON.stringify({ userId }), {
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
 * Exchanges the authorization code for an access token and stores it
 * server-side. The frontend retrieves it via the /oauth-result endpoint.
 */
googleAuthRoutes.get('/callback', requireAuth(), requireApproved(), async (c) => {
  const sessionUserId = getUserId(c);
  const appBaseUrl = `https://app.${c.env.BASE_DOMAIN}`;

  if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) {
    throw errors.badRequest('Google OAuth is not configured');
  }

  const code = c.req.query('code');
  const state = c.req.query('state');
  const error = c.req.query('error');

  if (error) {
    // User denied consent or other OAuth error
    const appUrl = `${appBaseUrl}/settings/cloud-provider?gcp_error=${encodeURIComponent(error)}`;
    return c.redirect(appUrl);
  }

  if (!code || !state) {
    throw errors.badRequest('Missing authorization code or state');
  }

  // Validate CSRF state and extract userId
  const storedStateRaw = await c.env.KV.get(`google-oauth-state:${state}`);
  if (!storedStateRaw) {
    throw errors.badRequest('Invalid or expired OAuth state');
  }

  let storedState: { userId: string };
  try {
    storedState = JSON.parse(storedStateRaw) as { userId: string };
  } catch {
    await c.env.KV.delete(`google-oauth-state:${state}`);
    throw errors.badRequest('Invalid OAuth state format');
  }

  // Verify the session user matches the user who initiated the flow
  if (storedState.userId !== sessionUserId) {
    // Don't delete state — the legitimate user can still retry
    return c.redirect(`${appBaseUrl}/settings/cloud-provider?gcp_error=${encodeURIComponent('OAuth state user mismatch')}`);
  }

  // All validation passed — consume the state token (one-time use)
  await c.env.KV.delete(`google-oauth-state:${state}`);

  const appUrl = `${appBaseUrl}/settings/cloud-provider`;

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
    return c.redirect(`${appUrl}?gcp_error=token_exchange_failed`);
  }

  const tokenData = (await tokenResponse.json()) as {
    access_token: string;
    token_type: string;
    expires_in: number;
    scope: string;
  };

  // Store the OAuth token server-side in KV with a short-lived opaque handle.
  const handle = crypto.randomUUID();
  await c.env.KV.put(`gcp-oauth-token:${handle}`, tokenData.access_token, {
    expirationTtl: 300, // 5 minutes — enough time for the setup wizard
  });

  // Store the handle in a user-scoped KV key so the frontend can retrieve it
  // via an authenticated API call instead of from the URL.
  await c.env.KV.put(`gcp-oauth-result:${sessionUserId}`, handle, {
    expirationTtl: 300,
  });

  // Redirect with only a flag — no sensitive token in the URL
  return c.redirect(`${appUrl}?gcp_setup=ready`);
});

/**
 * GET /auth/google/oauth-result - Retrieve the OAuth handle after callback.
 * One-time use: the KV entry is deleted after retrieval.
 */
googleAuthRoutes.get('/oauth-result', requireAuth(), requireApproved(), async (c) => {
  const userId = getUserId(c);

  const kvKey = `gcp-oauth-result:${userId}`;
  const handle = await c.env.KV.get(kvKey);
  if (!handle) {
    throw errors.notFound('No pending OAuth result — it may have expired or already been retrieved');
  }

  // One-time use: delete after retrieval
  await c.env.KV.delete(kvKey);

  return c.json({ handle });
});

export { googleAuthRoutes };
