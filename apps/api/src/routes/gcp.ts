import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq, and } from 'drizzle-orm';
import { ulid } from '../lib/ulid';
import type { Env } from '../index';
import { requireAuth, requireApproved, getUserId } from '../middleware/auth';
import { errors } from '../middleware/error';
import { encrypt } from '../services/encryption';
import { listGcpProjects, runGcpSetup } from '../services/gcp-setup';
import { verifyGcpOidcSetup } from '../services/gcp-sts';
import { serializeCredentialToken } from '../services/provider-credentials';
import * as schema from '../db/schema';
import { DEFAULT_GCP_API_TIMEOUT_MS } from '@simple-agent-manager/shared';
import { getCredentialEncryptionKey } from '../lib/secrets';

const gcpRoutes = new Hono<{ Bindings: Env }>();

// All GCP routes require authentication
gcpRoutes.use('*', requireAuth(), requireApproved());

/**
 * Resolve a GCP OAuth token from a KV handle.
 * The handle is a short-lived opaque key created during the OAuth callback.
 */
async function resolveOAuthToken(handle: string, kv: KVNamespace): Promise<string> {
  const token = await kv.get(`gcp-oauth-token:${handle}`);
  if (!token) {
    throw errors.badRequest('OAuth handle expired or invalid — please re-authenticate with Google');
  }
  return token;
}

/**
 * GET /api/gcp/projects - List user's GCP projects
 * Requires a KV handle from the OAuth callback (passed as ?handle=...).
 */
gcpRoutes.get('/projects', async (c) => {
  const handle = c.req.query('handle');
  if (!handle) {
    throw errors.badRequest('OAuth handle is required (pass as ?handle=...)');
  }
  const oauthToken = await resolveOAuthToken(handle, c.env.KV);

  const timeoutMs = c.env.GCP_API_TIMEOUT_MS
    ? parseInt(c.env.GCP_API_TIMEOUT_MS, 10)
    : DEFAULT_GCP_API_TIMEOUT_MS;

  try {
    const projects = await listGcpProjects(oauthToken, timeoutMs);
    return c.json({ projects });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error('Failed to list GCP projects:', detail);
    throw errors.badRequest(`Failed to list GCP projects: ${detail}`);
  }
});

/**
 * POST /api/gcp/setup - Run the full GCP OIDC setup orchestration.
 * Creates WIF pool, OIDC provider, service account, and IAM bindings.
 * Stores the resulting credential metadata (encrypted) for future use.
 */
gcpRoutes.post('/setup', async (c) => {
  const userId = getUserId(c);
  const body = await c.req.json<{
    oauthHandle: string;
    gcpProjectId: string;
    defaultZone: string;
  }>();

  if (!body.oauthHandle) throw errors.badRequest('oauthHandle is required');
  if (!body.gcpProjectId) throw errors.badRequest('gcpProjectId is required');
  if (!body.defaultZone) throw errors.badRequest('defaultZone is required');

  // Validate Google OAuth is configured
  if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) {
    throw errors.badRequest('Google OAuth is not configured on this SAM instance');
  }

  // Resolve the actual OAuth token from the KV handle
  const oauthToken = await resolveOAuthToken(body.oauthHandle, c.env.KV);

  try {
    // Run the full setup orchestration
    const credential = await runGcpSetup(
      oauthToken,
      body.gcpProjectId,
      body.defaultZone,
      c.env,
    );

    // Store the credential metadata (encrypted for consistency)
    const db = drizzle(c.env.DATABASE, { schema });
    const tokenToEncrypt = serializeCredentialToken('gcp', {
      gcpProjectId: credential.gcpProjectId,
      gcpProjectNumber: credential.gcpProjectNumber,
      serviceAccountEmail: credential.serviceAccountEmail,
      wifPoolId: credential.wifPoolId,
      wifProviderId: credential.wifProviderId,
      defaultZone: credential.defaultZone,
    });

    const { ciphertext, iv } = await encrypt(tokenToEncrypt, getCredentialEncryptionKey(c.env));
    const now = new Date().toISOString();

    // Invalidate any cached GCP access token for this user+project
    // to prevent stale tokens from being used after re-setup
    await c.env.KV.delete(`gcp-token:${userId}:${credential.gcpProjectId}`);

    // Check if GCP credential already exists for this user
    const existing = await db
      .select()
      .from(schema.credentials)
      .where(
        and(
          eq(schema.credentials.userId, userId),
          eq(schema.credentials.provider, 'gcp'),
          eq(schema.credentials.credentialType, 'cloud-provider'),
        ),
      )
      .limit(1);

    if (existing[0]) {
      await db
        .update(schema.credentials)
        .set({ encryptedToken: ciphertext, iv, updatedAt: now })
        .where(eq(schema.credentials.id, existing[0].id));
    } else {
      await db.insert(schema.credentials).values({
        id: ulid(),
        userId,
        provider: 'gcp',
        credentialType: 'cloud-provider',
        encryptedToken: ciphertext,
        iv,
        createdAt: now,
        updatedAt: now,
      });
    }

    // Step 8: Verify the setup works by performing a test token exchange
    try {
      await verifyGcpOidcSetup(userId, 'setup-verification', credential, c.env);
    } catch (verifyErr) {
      console.warn('GCP OIDC verification failed (setup completed but token exchange failed):', verifyErr);
      // Don't fail the setup — the resources are created. Verification failure
      // may be due to propagation delay. Return success with a warning.
      return c.json({
        success: true,
        verified: false,
        credential: {
          gcpProjectId: credential.gcpProjectId,
          gcpProjectNumber: credential.gcpProjectNumber,
          serviceAccountEmail: credential.serviceAccountEmail,
          defaultZone: credential.defaultZone,
        },
        warning: 'Setup completed but OIDC verification failed. This may resolve after a few minutes of propagation.',
      });
    }

    return c.json({
      success: true,
      verified: true,
      credential: {
        gcpProjectId: credential.gcpProjectId,
        gcpProjectNumber: credential.gcpProjectNumber,
        serviceAccountEmail: credential.serviceAccountEmail,
        defaultZone: credential.defaultZone,
      },
    });
  } catch (err) {
    console.error('GCP setup failed:', err instanceof Error ? err.message : err);
    throw errors.badRequest(
      `GCP setup failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
    );
  }
});

/**
 * POST /api/gcp/verify - Verify that an existing GCP OIDC setup works.
 */
gcpRoutes.post('/verify', async (c) => {
  const userId = getUserId(c);
  const db = drizzle(c.env.DATABASE, { schema });

  // Look up GCP credential
  const creds = await db
    .select()
    .from(schema.credentials)
    .where(
      and(
        eq(schema.credentials.userId, userId),
        eq(schema.credentials.provider, 'gcp'),
        eq(schema.credentials.credentialType, 'cloud-provider'),
      ),
    )
    .limit(1);

  const cred = creds[0];
  if (!cred) {
    throw errors.notFound('GCP credential not configured');
  }

  const { decrypt } = await import('../services/encryption');
  const decryptedToken = await decrypt(cred.encryptedToken, cred.iv, getCredentialEncryptionKey(c.env));
  const { parseGcpCredential } = await import('../services/provider-credentials');
  const gcpCred = parseGcpCredential(decryptedToken);

  try {
    await verifyGcpOidcSetup(userId, 'verification', gcpCred, c.env);
    return c.json({ success: true, verified: true });
  } catch (err) {
    return c.json({
      success: false,
      verified: false,
      error: err instanceof Error ? err.message : 'Verification failed',
    });
  }
});

export { gcpRoutes };
