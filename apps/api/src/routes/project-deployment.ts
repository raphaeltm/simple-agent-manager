import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { and, eq } from 'drizzle-orm';
import type { Env } from '../index';
import { requireAuth, requireApproved, getUserId } from '../middleware/auth';
import { requireOwnedProject } from '../middleware/project-auth';
import { errors } from '../middleware/error';
import { ulid } from '../lib/ulid';
import { listGcpProjects } from '../services/gcp-setup';
import { runGcpDeploySetup } from '../services/gcp-deploy-setup';
import { toSanitizedAppError } from '../services/gcp-errors';
import { signIdentityToken } from '../services/jwt';
import { validateMcpToken } from '../services/mcp-token';
import {
  checkRateLimit,
  createRateLimitKey,
  DEFAULT_WINDOW_SECONDS,
  getCurrentWindowStart,
  getRateLimit,
  RateLimitError,
} from '../middleware/rate-limit';
import * as schema from '../db/schema';
import {
  DEFAULT_GCP_API_TIMEOUT_MS,
  DEFAULT_GCP_DEPLOY_WIF_POOL_ID,
  DEFAULT_GCP_DEPLOY_WIF_PROVIDER_ID,
  DEFAULT_GCP_DEPLOY_IDENTITY_TOKEN_EXPIRY_SECONDS,
  DEFAULT_GCP_DEPLOY_OAUTH_STATE_TTL_SECONDS,
  DEFAULT_GCP_DEPLOY_OAUTH_TOKEN_HANDLE_TTL_SECONDS,
} from '@simple-agent-manager/shared';
import { log } from '../lib/logger';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

const projectDeploymentRoutes = new Hono<{ Bindings: Env }>();

// ─── OAuth flow (user session auth) ─────────────────────────────────────

/**
 * GET /api/projects/:id/deployment/gcp/authorize
 * Start Google OAuth flow for deployment credential setup.
 */
projectDeploymentRoutes.get(
  '/:id/deployment/gcp/authorize',
  requireAuth(),
  requireApproved(),
  async (c) => {
    const projectId = c.req.param('id');
    const userId = getUserId(c);

    if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) {
      throw errors.badRequest('Google OAuth is not configured on this SAM instance');
    }

    // Verify project ownership
    const db = drizzle(c.env.DATABASE, { schema });
    await requireOwnedProject(db, projectId, userId);

    // Generate CSRF state token with project context
    const state = crypto.randomUUID();
    const stateTtl = c.env.GCP_DEPLOY_OAUTH_STATE_TTL_SECONDS
      ? parseInt(c.env.GCP_DEPLOY_OAUTH_STATE_TTL_SECONDS, 10)
      : DEFAULT_GCP_DEPLOY_OAUTH_STATE_TTL_SECONDS;
    await c.env.KV.put(
      `gcp-deploy-oauth-state:${state}`,
      JSON.stringify({ projectId, userId }),
      { expirationTtl: stateTtl },
    );

    const redirectUri = `https://api.${c.env.BASE_DOMAIN}/api/deployment/gcp/callback`;
    const params = new URLSearchParams({
      client_id: c.env.GOOGLE_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      // access_type: 'online' — no refresh token issued; this is a one-time setup flow only
      access_type: 'online',
      state,
      prompt: 'consent',
    });

    return c.redirect(`${GOOGLE_AUTH_URL}?${params.toString()}`);
  },
);

// OAuth callback moved to gcpDeployCallbackRoute — see below

/**
 * GET /api/projects/:id/deployment/gcp/oauth-result
 * Retrieve the OAuth handle after the callback redirect.
 * The handle is stored server-side so it never appears in a URL.
 * One-time use: the KV entry is deleted after retrieval.
 */
projectDeploymentRoutes.get(
  '/:id/deployment/gcp/oauth-result',
  requireAuth(),
  requireApproved(),
  async (c) => {
    const projectId = c.req.param('id');
    const userId = getUserId(c);
    const db = drizzle(c.env.DATABASE, { schema });
    await requireOwnedProject(db, projectId, userId);

    const kvKey = `gcp-deploy-oauth-result:${userId}:${projectId}`;
    const handle = await c.env.KV.get(kvKey);
    if (!handle) {
      throw errors.notFound('No pending OAuth result — it may have expired or already been retrieved');
    }

    // One-time use: delete after retrieval.
    // NOTE: get-then-delete is not atomic in KV — two simultaneous requests could
    // both retrieve the handle. The TTL on the underlying token handle is the safety net.
    await c.env.KV.delete(kvKey);

    return c.json({ handle });
  },
);

// ─── Setup + management (user session auth) ─────────────────────────────

/**
 * POST /api/projects/:id/deployment/gcp/projects
 * List user's GCP projects for deployment setup.
 * Accepts the OAuth handle in the request body to avoid leaking it in URL query parameters.
 */
projectDeploymentRoutes.post(
  '/:id/deployment/gcp/projects',
  requireAuth(),
  requireApproved(),
  async (c) => {
    const projectId = c.req.param('id');
    const userId = getUserId(c);
    const db = drizzle(c.env.DATABASE, { schema });
    await requireOwnedProject(db, projectId, userId);

    const body = await c.req.json<{ oauthHandle: string }>();
    if (!body.oauthHandle) {
      throw errors.badRequest('oauthHandle is required');
    }

    const oauthToken = await resolveDeployOAuthToken(body.oauthHandle, c.env.KV);
    const timeoutMs = c.env.GCP_API_TIMEOUT_MS
      ? parseInt(c.env.GCP_API_TIMEOUT_MS, 10)
      : DEFAULT_GCP_API_TIMEOUT_MS;

    try {
      const projects = await listGcpProjects(oauthToken, timeoutMs);
      return c.json({ projects });
    } catch (err) {
      throw toSanitizedAppError(err, 'deploy-list-projects');
    }
  },
);

/**
 * POST /api/projects/:id/deployment/gcp/setup
 * Run full GCP deployment setup: WIF pool + provider + SA with deployment roles.
 */
projectDeploymentRoutes.post(
  '/:id/deployment/gcp/setup',
  requireAuth(),
  requireApproved(),
  async (c) => {
    const projectId = c.req.param('id');
    const userId = getUserId(c);
    const db = drizzle(c.env.DATABASE, { schema });
    await requireOwnedProject(db, projectId, userId);

    const body = await c.req.json<{
      oauthHandle: string;
      gcpProjectId: string;
    }>();

    if (!body.oauthHandle) throw errors.badRequest('oauthHandle is required');
    if (!body.gcpProjectId) throw errors.badRequest('gcpProjectId is required');

    if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) {
      throw errors.badRequest('Google OAuth is not configured on this SAM instance');
    }

    const oauthToken = await resolveDeployOAuthToken(body.oauthHandle, c.env.KV);

    let result;
    try {
      result = await runGcpDeploySetup(oauthToken, body.gcpProjectId, c.env, undefined, projectId);
    } catch (err) {
      throw toSanitizedAppError(err, 'deploy-setup');
    }

    // Consume the OAuth token after successful setup (one-time use)
    await c.env.KV.delete(`gcp-deploy-oauth-token:${body.oauthHandle}`);

    // Upsert deployment credential
    const now = new Date().toISOString();
    const existing = await db
      .select()
      .from(schema.projectDeploymentCredentials)
      .where(
        and(
          eq(schema.projectDeploymentCredentials.projectId, projectId),
          eq(schema.projectDeploymentCredentials.provider, 'gcp'),
        ),
      )
      .limit(1);

    if (existing[0]) {
      await db
        .update(schema.projectDeploymentCredentials)
        .set({
          gcpProjectId: result.gcpProjectId,
          gcpProjectNumber: result.gcpProjectNumber,
          serviceAccountEmail: result.serviceAccountEmail,
          wifPoolId: result.wifPoolId,
          wifProviderId: result.wifProviderId,
          updatedAt: now,
        })
        .where(eq(schema.projectDeploymentCredentials.id, existing[0].id));
    } else {
      await db.insert(schema.projectDeploymentCredentials).values({
        id: ulid(),
        projectId,
        userId,
        provider: 'gcp',
        gcpProjectId: result.gcpProjectId,
        gcpProjectNumber: result.gcpProjectNumber,
        serviceAccountEmail: result.serviceAccountEmail,
        wifPoolId: result.wifPoolId,
        wifProviderId: result.wifProviderId,
        createdAt: now,
        updatedAt: now,
      });
    }

    return c.json({
      success: true,
      credential: {
        provider: 'gcp' as const,
        gcpProjectId: result.gcpProjectId,
        serviceAccountEmail: result.serviceAccountEmail,
        connected: true,
        createdAt: now,
      },
    });
  },
);

/**
 * GET /api/projects/:id/deployment/gcp
 * Get deployment credential config for a project.
 */
projectDeploymentRoutes.get(
  '/:id/deployment/gcp',
  requireAuth(),
  requireApproved(),
  async (c) => {
    const projectId = c.req.param('id');
    const userId = getUserId(c);
    const db = drizzle(c.env.DATABASE, { schema });
    await requireOwnedProject(db, projectId, userId);

    const rows = await db
      .select()
      .from(schema.projectDeploymentCredentials)
      .where(
        and(
          eq(schema.projectDeploymentCredentials.projectId, projectId),
          eq(schema.projectDeploymentCredentials.provider, 'gcp'),
        ),
      )
      .limit(1);

    const cred = rows[0];
    if (!cred) {
      return c.json({ connected: false });
    }

    return c.json({
      connected: true,
      provider: 'gcp' as const,
      gcpProjectId: cred.gcpProjectId,
      serviceAccountEmail: cred.serviceAccountEmail,
      createdAt: cred.createdAt,
    });
  },
);

/**
 * DELETE /api/projects/:id/deployment/gcp
 * Remove deployment credential for a project.
 */
projectDeploymentRoutes.delete(
  '/:id/deployment/gcp',
  requireAuth(),
  requireApproved(),
  async (c) => {
    const projectId = c.req.param('id');
    const userId = getUserId(c);
    const db = drizzle(c.env.DATABASE, { schema });
    await requireOwnedProject(db, projectId, userId);

    await db
      .delete(schema.projectDeploymentCredentials)
      .where(
        and(
          eq(schema.projectDeploymentCredentials.projectId, projectId),
          eq(schema.projectDeploymentCredentials.provider, 'gcp'),
        ),
      );

    return c.json({ success: true });
  },
);

// ─── Identity token endpoint (MCP token auth only) ──────────────────────
// Mounted as a SEPARATE Hono instance to avoid middleware leak from projectsRoutes.
// Both projectsRoutes and projectDeploymentRoutes mount at /api/projects — Hono merges
// routes, so projectsRoutes.use('/*', requireAuth()) leaks to all siblings.
// This endpoint uses MCP Bearer token auth (not session cookies), so it MUST be isolated.
// See docs/notes/2026-03-25-deployment-identity-token-middleware-leak-postmortem.md

const deploymentIdentityTokenRoute = new Hono<{ Bindings: Env }>();

/**
 * GET /api/projects/:id/deployment-identity-token
 * Returns a signed OIDC JWT for GCP token exchange.
 * Auth: MCP token ONLY — callback tokens are rejected to prevent privilege escalation.
 * Called by GCP client libraries via external_account credential config.
 */
deploymentIdentityTokenRoute.get('/:id/deployment-identity-token', async (c) => {
  const projectId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });

  // Authenticate via Bearer token (MCP token only)
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    throw errors.unauthorized('Missing or invalid Authorization header');
  }
  const token = authHeader.slice(7);
  if (!token) {
    throw errors.unauthorized('Missing or invalid Authorization header');
  }

  // Validate MCP token — callback tokens are NOT accepted here.
  // Callback tokens are operational credentials for node-to-API communication
  // (heartbeats, message reporting) and must not grant GCP deployment access.
  const mcpData = await validateMcpToken(c.env.KV, token);
  if (!mcpData) {
    throw errors.forbidden('Identity token endpoint requires a valid MCP token');
  }

  // Verify project match
  if (mcpData.projectId !== projectId) {
    throw errors.forbidden('MCP token project does not match requested project');
  }
  const userId = mcpData.userId;
  const workspaceId = mcpData.workspaceId;

  // Look up deployment credential
  const credRows = await db
    .select()
    .from(schema.projectDeploymentCredentials)
    .where(
      and(
        eq(schema.projectDeploymentCredentials.projectId, projectId),
        eq(schema.projectDeploymentCredentials.provider, 'gcp'),
      ),
    )
    .limit(1);

  const cred = credRows[0];
  if (!cred) {
    throw errors.notFound('No GCP deployment credential configured for this project');
  }

  // Build the WIF audience URI.
  // NOTE: The JWT `aud` claim uses the full `https://` scheme, which is what GCP expects
  // for identity tokens. The STS `audience` field in the credential config (deployment-tools.ts)
  // uses the protocol-relative `//` format. Both forms are intentionally different per GCP WIF spec.
  const poolId = cred.wifPoolId || c.env.GCP_DEPLOY_WIF_POOL_ID || DEFAULT_GCP_DEPLOY_WIF_POOL_ID;
  const providerId = cred.wifProviderId || c.env.GCP_DEPLOY_WIF_PROVIDER_ID || DEFAULT_GCP_DEPLOY_WIF_PROVIDER_ID;
  const audience = `https://iam.googleapis.com/projects/${cred.gcpProjectNumber}/locations/global/workloadIdentityPools/${poolId}/providers/${providerId}`;

  const expirySeconds = c.env.GCP_DEPLOY_IDENTITY_TOKEN_EXPIRY_SECONDS
    ? parseInt(c.env.GCP_DEPLOY_IDENTITY_TOKEN_EXPIRY_SECONDS, 10)
    : DEFAULT_GCP_DEPLOY_IDENTITY_TOKEN_EXPIRY_SECONDS;

  // ── Token caching: return cached token if still valid ──
  // Cache key includes userId to prevent cross-user token leakage
  const cacheKey = `identity-token-cache:${userId}:${workspaceId}:${audience}`;
  const cachedToken = await c.env.KV.get(cacheKey);
  if (cachedToken) {
    return c.json({ token: cachedToken });
  }

  // ── Rate limit per workspace (only for new signing operations) ──
  const rateLimitWindowSeconds = c.env.RATE_LIMIT_IDENTITY_TOKEN_WINDOW_SECONDS
    ? parseInt(c.env.RATE_LIMIT_IDENTITY_TOKEN_WINDOW_SECONDS, 10)
    : DEFAULT_WINDOW_SECONDS;
  const rateLimitMax = getRateLimit(c.env, 'IDENTITY_TOKEN');
  const windowStart = getCurrentWindowStart(rateLimitWindowSeconds);
  const rlKey = createRateLimitKey('identity-token', workspaceId, windowStart);

  const { allowed, remaining, resetAt } = await checkRateLimit(
    c.env.KV,
    rlKey,
    rateLimitMax,
    rateLimitWindowSeconds,
  );

  c.header('X-RateLimit-Limit', rateLimitMax.toString());
  c.header('X-RateLimit-Remaining', remaining.toString());
  c.header('X-RateLimit-Reset', resetAt.toString());

  if (!allowed) {
    const retryAfter = resetAt - Math.floor(Date.now() / 1000);
    c.header('Retry-After', Math.max(1, retryAfter).toString());
    throw new RateLimitError(retryAfter);
  }

  const identityToken = await signIdentityToken(
    {
      userId,
      projectId,
      workspaceId,
      audience,
    },
    c.env,
    expirySeconds,
  );

  // Cache the signed token with TTL = expiry - buffer (min floor)
  const cacheBuffer = c.env.IDENTITY_TOKEN_CACHE_BUFFER_SECONDS
    ? parseInt(c.env.IDENTITY_TOKEN_CACHE_BUFFER_SECONDS, 10)
    : 60;
  const cacheMinTtl = c.env.IDENTITY_TOKEN_CACHE_MIN_TTL_SECONDS
    ? parseInt(c.env.IDENTITY_TOKEN_CACHE_MIN_TTL_SECONDS, 10)
    : 30;
  const cacheTtl = Math.max(cacheMinTtl, expirySeconds - cacheBuffer);
  await c.env.KV.put(cacheKey, identityToken, { expirationTtl: cacheTtl });

  return c.json({ token: identityToken });
});

// ─── Helpers ─────────────────────────────────────────────────────────────

async function resolveDeployOAuthToken(handle: string, kv: KVNamespace): Promise<string> {
  const token = await kv.get(`gcp-deploy-oauth-token:${handle}`);
  if (!token) {
    throw errors.badRequest('OAuth handle expired or invalid — please re-authenticate with Google');
  }
  return token;
}

// ─── Top-level GCP OAuth callback (static URI) ──────────────────────────

const gcpDeployCallbackRoute = new Hono<{ Bindings: Env }>();

/**
 * GET /api/deployment/gcp/callback
 * Handle Google OAuth callback for deployment setup.
 * Project context comes from the KV state token, NOT the URL.
 * This allows a single static redirect URI in Google Cloud Console.
 */
gcpDeployCallbackRoute.get(
  '/gcp/callback',
  requireAuth(),
  requireApproved(),
  async (c) => {
    const sessionUserId = getUserId(c);
    const appBaseUrl = `https://app.${c.env.BASE_DOMAIN}`;

    if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) {
      throw errors.badRequest('Google OAuth is not configured');
    }

    const code = c.req.query('code');
    const state = c.req.query('state');
    const error = c.req.query('error');

    if (error) {
      // No project context yet — redirect to dashboard with error
      return c.redirect(`${appBaseUrl}?gcp_deploy_error=${encodeURIComponent(error)}`);
    }

    if (!code || !state) {
      return c.redirect(`${appBaseUrl}?gcp_deploy_error=${encodeURIComponent('Missing authorization code or state')}`);
    }

    // Validate state format before KV lookup (state is always a UUID)
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(state)) {
      return c.redirect(`${appBaseUrl}?gcp_deploy_error=${encodeURIComponent('Invalid OAuth state')}`);
    }

    // Validate CSRF state and extract project context
    const storedStateRaw = await c.env.KV.get(`gcp-deploy-oauth-state:${state}`);
    if (!storedStateRaw) {
      return c.redirect(`${appBaseUrl}?gcp_deploy_error=${encodeURIComponent('Invalid or expired OAuth state')}`);
    }

    let storedState: { projectId: string; userId: string };
    try {
      storedState = JSON.parse(storedStateRaw) as { projectId: string; userId: string };
    } catch {
      await c.env.KV.delete(`gcp-deploy-oauth-state:${state}`);
      return c.redirect(`${appBaseUrl}?gcp_deploy_error=${encodeURIComponent('Invalid OAuth state format')}`);
    }

    if (!storedState.projectId || !storedState.userId) {
      await c.env.KV.delete(`gcp-deploy-oauth-state:${state}`);
      return c.redirect(`${appBaseUrl}?gcp_deploy_error=${encodeURIComponent('Incomplete OAuth state')}`);
    }

    // Validate user identity BEFORE consuming the state token — if the user doesn't
    // match, the state remains valid for the legitimate user to retry
    if (storedState.userId !== sessionUserId) {
      return c.redirect(`${appBaseUrl}?gcp_deploy_error=${encodeURIComponent('OAuth state user mismatch')}`);
    }

    // All validation passed — consume the state token (one-time use)
    await c.env.KV.delete(`gcp-deploy-oauth-state:${state}`);

    const projectId = storedState.projectId;

    // Defense-in-depth: verify the session user owns the project in the database,
    // even though the KV state was created by an authenticated owner at authorize time
    const db = drizzle(c.env.DATABASE, { schema });
    await requireOwnedProject(db, projectId, sessionUserId);

    const appUrl = `https://app.${c.env.BASE_DOMAIN}/projects/${projectId}/settings`;

    // Exchange auth code for access token
    const redirectUri = `https://api.${c.env.BASE_DOMAIN}/api/deployment/gcp/callback`;
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
      const errBody = await tokenResponse.json().catch(() => ({})) as { error?: string };
      log.error('project_deployment.google_token_exchange_failed', {
        status: tokenResponse.status,
        error: errBody.error ?? 'unknown',
      });
      return c.redirect(`${appUrl}?gcp_deploy_error=token_exchange_failed`);
    }

    const tokenData = (await tokenResponse.json()) as { access_token: string };

    // Store token in KV with opaque handle (for subsequent API calls)
    const handle = crypto.randomUUID();
    const tokenHandleTtl = c.env.GCP_DEPLOY_OAUTH_TOKEN_HANDLE_TTL_SECONDS
      ? parseInt(c.env.GCP_DEPLOY_OAUTH_TOKEN_HANDLE_TTL_SECONDS, 10)
      : DEFAULT_GCP_DEPLOY_OAUTH_TOKEN_HANDLE_TTL_SECONDS;
    await c.env.KV.put(`gcp-deploy-oauth-token:${handle}`, tokenData.access_token, {
      expirationTtl: tokenHandleTtl,
    });

    // Store the handle reference in a user+project-scoped KV key so the frontend
    // can retrieve it via an authenticated API call instead of from the URL.
    // This prevents the handle from leaking in browser history, Referer headers, and logs.
    await c.env.KV.put(
      `gcp-deploy-oauth-result:${sessionUserId}:${projectId}`,
      handle,
      { expirationTtl: tokenHandleTtl },
    );

    // Redirect with only a flag — no sensitive token in the URL
    return c.redirect(`${appUrl}?gcp_deploy_setup=ready`);
  },
);

export { projectDeploymentRoutes, gcpDeployCallbackRoute, deploymentIdentityTokenRoute };
