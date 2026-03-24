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
import { signIdentityToken, verifyCallbackToken } from '../services/jwt';
import { validateMcpToken } from '../services/mcp-token';
import * as schema from '../db/schema';
import {
  DEFAULT_GCP_API_TIMEOUT_MS,
  DEFAULT_GCP_DEPLOY_WIF_POOL_ID,
  DEFAULT_GCP_DEPLOY_WIF_PROVIDER_ID,
  DEFAULT_GCP_DEPLOY_IDENTITY_TOKEN_EXPIRY_SECONDS,
  DEFAULT_GCP_DEPLOY_OAUTH_STATE_TTL_SECONDS,
  DEFAULT_GCP_DEPLOY_OAUTH_TOKEN_HANDLE_TTL_SECONDS,
} from '@simple-agent-manager/shared';

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

    const redirectUri = `https://api.${c.env.BASE_DOMAIN}/api/projects/${projectId}/deployment/gcp/callback`;
    const params = new URLSearchParams({
      client_id: c.env.GOOGLE_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      access_type: 'online',
      state,
      prompt: 'consent',
    });

    return c.redirect(`${GOOGLE_AUTH_URL}?${params.toString()}`);
  },
);

/**
 * GET /api/projects/:id/deployment/gcp/callback
 * Handle Google OAuth callback for deployment setup.
 */
projectDeploymentRoutes.get('/:id/deployment/gcp/callback', async (c) => {
  const projectId = c.req.param('id');

  if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) {
    throw errors.badRequest('Google OAuth is not configured');
  }

  const code = c.req.query('code');
  const state = c.req.query('state');
  const error = c.req.query('error');

  const appUrl = `https://app.${c.env.BASE_DOMAIN}/projects/${projectId}/settings`;

  if (error) {
    return c.redirect(`${appUrl}?gcp_deploy_error=${encodeURIComponent(error)}`);
  }

  if (!code || !state) {
    return c.redirect(`${appUrl}?gcp_deploy_error=${encodeURIComponent('Missing authorization code or state')}`);
  }

  // Validate CSRF state
  const storedStateRaw = await c.env.KV.get(`gcp-deploy-oauth-state:${state}`);
  if (!storedStateRaw) {
    return c.redirect(`${appUrl}?gcp_deploy_error=${encodeURIComponent('Invalid or expired OAuth state')}`);
  }
  await c.env.KV.delete(`gcp-deploy-oauth-state:${state}`);

  const storedState = JSON.parse(storedStateRaw) as { projectId: string; userId: string };
  if (storedState.projectId !== projectId) {
    return c.redirect(`${appUrl}?gcp_deploy_error=${encodeURIComponent('OAuth state project mismatch')}`);
  }

  // Exchange auth code for access token
  const redirectUri = `https://api.${c.env.BASE_DOMAIN}/api/projects/${projectId}/deployment/gcp/callback`;
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
    console.error('Google token exchange failed:', await tokenResponse.text());
    return c.redirect(`${appUrl}?gcp_deploy_error=token_exchange_failed`);
  }

  const tokenData = (await tokenResponse.json()) as { access_token: string };

  // Store token in KV with opaque handle
  const handle = crypto.randomUUID();
  const tokenHandleTtl = c.env.GCP_DEPLOY_OAUTH_TOKEN_HANDLE_TTL_SECONDS
    ? parseInt(c.env.GCP_DEPLOY_OAUTH_TOKEN_HANDLE_TTL_SECONDS, 10)
    : DEFAULT_GCP_DEPLOY_OAUTH_TOKEN_HANDLE_TTL_SECONDS;
  await c.env.KV.put(`gcp-deploy-oauth-token:${handle}`, tokenData.access_token, {
    expirationTtl: tokenHandleTtl,
  });

  return c.redirect(`${appUrl}?gcp_deploy_setup=${encodeURIComponent(handle)}`);
});

// ─── Setup + management (user session auth) ─────────────────────────────

/**
 * GET /api/projects/:id/deployment/gcp/projects
 * List user's GCP projects for deployment setup.
 */
projectDeploymentRoutes.get(
  '/:id/deployment/gcp/projects',
  requireAuth(),
  requireApproved(),
  async (c) => {
    const projectId = c.req.param('id');
    const userId = getUserId(c);
    const db = drizzle(c.env.DATABASE, { schema });
    await requireOwnedProject(db, projectId, userId);

    const handle = c.req.query('handle');
    if (!handle) {
      throw errors.badRequest('OAuth handle is required');
    }

    const oauthToken = await resolveDeployOAuthToken(handle, c.env.KV);
    const timeoutMs = c.env.GCP_API_TIMEOUT_MS
      ? parseInt(c.env.GCP_API_TIMEOUT_MS, 10)
      : DEFAULT_GCP_API_TIMEOUT_MS;

    const projects = await listGcpProjects(oauthToken, timeoutMs);
    return c.json({ projects });
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

    const result = await runGcpDeploySetup(oauthToken, body.gcpProjectId, c.env);

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

// ─── Identity token endpoint (workspace callback token auth) ────────────

/**
 * GET /api/projects/:id/deployment-identity-token
 * Returns a signed OIDC JWT for GCP token exchange.
 * Auth: workspace callback token OR MCP token.
 * Called by GCP client libraries via external_account credential config.
 */
projectDeploymentRoutes.get('/:id/deployment-identity-token', async (c) => {
  const projectId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });

  // Authenticate via Bearer token (callback token or MCP token)
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    throw errors.unauthorized('Missing or invalid Authorization header');
  }
  const token = authHeader.slice(7);

  // Try MCP token first, then fall back to callback token
  let userId: string;
  let workspaceId: string;
  const mcpData = await validateMcpToken(c.env.KV, token);
  if (mcpData) {
    // MCP token — verify project match
    if (mcpData.projectId !== projectId) {
      throw errors.forbidden('MCP token project does not match requested project');
    }
    userId = mcpData.userId;
    workspaceId = mcpData.workspaceId;
  } else {
    // Try callback token
    const payload = await verifyCallbackToken(token, c.env);
    const cbWorkspaceId = payload.workspace;
    if (!cbWorkspaceId) {
      throw errors.badRequest('Callback token does not contain a workspace ID');
    }

    // Verify workspace belongs to project
    const wsRows = await db
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, cbWorkspaceId))
      .limit(1);

    const workspace = wsRows[0];
    if (!workspace) {
      throw errors.notFound('Workspace');
    }
    if (workspace.projectId !== projectId) {
      throw errors.forbidden('Workspace does not belong to this project');
    }
    userId = workspace.userId;
    workspaceId = cbWorkspaceId;
  }

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

export { projectDeploymentRoutes };
