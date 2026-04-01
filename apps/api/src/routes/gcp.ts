import { DEFAULT_GCP_API_TIMEOUT_MS } from '@simple-agent-manager/shared';
import { and,eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../index';
import { log } from '../lib/logger';
import { getCredentialEncryptionKey } from '../lib/secrets';
import { ulid } from '../lib/ulid';
import { getUserId,requireApproved, requireAuth } from '../middleware/auth';
import { errors } from '../middleware/error';
import { GcpOAuthHandleSchema, GcpSetupSchema,jsonValidator } from '../schemas';
import { encrypt } from '../services/encryption';
import { sanitizeGcpError, toSanitizedAppError } from '../services/gcp-errors';
import { listGcpProjects, runGcpSetup } from '../services/gcp-setup';
import { verifyGcpOidcSetup } from '../services/gcp-sts';
import { serializeCredentialToken } from '../services/provider-credentials';

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
 * POST /api/gcp/projects - List user's GCP projects
 * Accepts the OAuth handle in the request body to avoid leaking it in URL query parameters.
 */
gcpRoutes.post('/projects', jsonValidator(GcpOAuthHandleSchema), async (c) => {
  const body = c.req.valid('json');
  const oauthToken = await resolveOAuthToken(body.oauthHandle, c.env.KV);

  const timeoutMs = c.env.GCP_API_TIMEOUT_MS
    ? parseInt(c.env.GCP_API_TIMEOUT_MS, 10)
    : DEFAULT_GCP_API_TIMEOUT_MS;

  try {
    const projects = await listGcpProjects(oauthToken, timeoutMs);
    return c.json({ projects });
  } catch (err) {
    throw toSanitizedAppError(err, 'list-projects');
  }
});

/**
 * POST /api/gcp/setup - Run the full GCP OIDC setup orchestration.
 * Creates WIF pool, OIDC provider, service account, and IAM bindings.
 * Stores the resulting credential metadata (encrypted) for future use.
 */
gcpRoutes.post('/setup', jsonValidator(GcpSetupSchema), async (c) => {
  const userId = getUserId(c);
  const body = c.req.valid('json');

  // Validate Google OAuth is configured
  if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) {
    throw errors.badRequest('Google OAuth is not configured on this SAM instance');
  }

  // Resolve the actual OAuth token from the KV handle
  const oauthToken = await resolveOAuthToken(body.oauthHandle, c.env.KV);

  try {
    // Run the full setup orchestration.
    // SECURITY: samProjectId is intentionally NOT passed here. User-level GCP credentials
    // are scoped to the user (not a specific SAM project) and may serve multiple SAM projects
    // for VM provisioning. The pool-wide wildcard binding is correct for this trust model.
    // Project-scoped bindings are enforced in the deployment flow (project-deployment.ts).
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
      log.warn('gcp.oidc_verification_failed', { error: verifyErr instanceof Error ? verifyErr.message : String(verifyErr) });
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
    throw toSanitizedAppError(err, 'gcp-setup');
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
    // Intentional 200-with-error pattern: verification is a check, not a mutation.
    // The UI displays the result inline rather than treating it as an HTTP error.
    return c.json({
      success: false,
      verified: false,
      error: sanitizeGcpError(err, 'gcp-verify'),
    });
  }
});

export { gcpRoutes };
