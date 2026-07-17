import {
  DEFAULT_GCP_API_TIMEOUT_MS,
  DEFAULT_GCP_SERVICE_ACCOUNT_JSON_MAX_BYTES,
  type GcpCredential,
  isValidLocationForProvider,
} from '@simple-agent-manager/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { getCredentialEncryptionKey } from '../lib/secrets';
import { getUserId, requireApproved, requireAuth } from '../middleware/auth';
import { errors } from '../middleware/error';
import {
  GcpOAuthHandleSchema,
  GcpSetupSchema,
  jsonValidator,
  SaveGcpServiceAccountCredentialSchema,
} from '../schemas';
import { enforceCredentialMutationRateLimit } from '../services/credential-mutation-rate-limit';
import { decrypt } from '../services/encryption';
import { getTimeoutMs } from '../services/fetch-timeout';
import { replaceUserGcpCredential } from '../services/gcp-credential-store';
import { sanitizeGcpError, toSanitizedAppError } from '../services/gcp-errors';
import {
  parseGcpServiceAccountJson,
  verifyGcpServiceAccountAccess,
} from '../services/gcp-service-account';
import { listGcpProjects, runGcpSetup } from '../services/gcp-setup';
import {
  clearGcpAccessTokenCache,
  getGcpAccessToken,
  verifyGcpOidcSetup,
} from '../services/gcp-sts';
import { getGoogleInfraOAuthConfig } from '../services/platform-config';
import { parseGcpCredential, toGcpCredentialMetadata } from '../services/provider-credentials';

const gcpRoutes = new Hono<{ Bindings: Env }>();

gcpRoutes.use('*', requireAuth(), requireApproved());

async function resolveOAuthToken(handle: string, kv: KVNamespace): Promise<string> {
  const token = await kv.get(`gcp-oauth-token:${handle}`);
  if (!token) {
    throw errors.badRequest('OAuth handle expired or invalid — please re-authenticate with Google');
  }
  return token;
}

function jsonSizeLimit(env: Env): number {
  const parsed = Number.parseInt(env.GCP_SERVICE_ACCOUNT_JSON_MAX_BYTES ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_GCP_SERVICE_ACCOUNT_JSON_MAX_BYTES;
}

async function getStoredGcpCredential(env: Env, userId: string): Promise<GcpCredential | null> {
  const db = drizzle(env.DATABASE, { schema });
  const [row] = await db
    .select({ encryptedToken: schema.credentials.encryptedToken, iv: schema.credentials.iv })
    .from(schema.credentials)
    .where(and(
      eq(schema.credentials.userId, userId),
      eq(schema.credentials.provider, 'gcp'),
      eq(schema.credentials.credentialType, 'cloud-provider'),
      isNull(schema.credentials.projectId),
    ))
    .limit(1);
  if (!row) return null;
  const decrypted = await decrypt(row.encryptedToken, row.iv, getCredentialEncryptionKey(env));
  return parseGcpCredential(decrypted);
}

async function clearCredentialCache(
  env: Env,
  userId: string,
  credential: GcpCredential,
): Promise<void> {
  try {
    await clearGcpAccessTokenCache(env, userId, credential);
  } catch (err) {
    log.warn('gcp.token_cache_cleanup_failed', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

gcpRoutes.post('/projects', jsonValidator(GcpOAuthHandleSchema), async (c) => {
  const body = c.req.valid('json');
  const oauthToken = await resolveOAuthToken(body.oauthHandle, c.env.KV);
  const timeoutMs = getTimeoutMs(c.env.GCP_API_TIMEOUT_MS, DEFAULT_GCP_API_TIMEOUT_MS);

  try {
    const projects = await listGcpProjects(oauthToken, timeoutMs);
    return c.json({ projects });
  } catch (err) {
    throw toSanitizedAppError(err, 'list-projects');
  }
});

/** Save or atomically rotate an OAuth-free GCP service-account credential. */
gcpRoutes.put(
  '/service-account',
  jsonValidator(SaveGcpServiceAccountCredentialSchema),
  async (c) => {
    const userId = getUserId(c);
    const body = c.req.valid('json');
    await enforceCredentialMutationRateLimit(c.env, userId, 'gcp-service-account');

    if (new TextEncoder().encode(body.serviceAccountJson).byteLength > jsonSizeLimit(c.env)) {
      throw errors.badRequest('Service-account JSON is too large');
    }
    if (!isValidLocationForProvider('gcp', body.defaultZone)) {
      throw errors.badRequest('Default zone is not supported for GCP');
    }

    let credential: GcpCredential;
    try {
      credential = await parseGcpServiceAccountJson(
        body.serviceAccountJson,
        body.defaultZone,
      );
    } catch (err) {
      throw errors.badRequest(err instanceof Error ? err.message : 'Invalid service-account JSON');
    }

    let previous: GcpCredential | null = null;
    try {
      previous = await getStoredGcpCredential(c.env, userId);
    } catch (err) {
      log.error('gcp.previous_credential_unreadable', {
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      const accessToken = await getGcpAccessToken(
        userId,
        'service-account-setup',
        credential,
        c.env,
      );
      await verifyGcpServiceAccountAccess(credential, accessToken, c.env);
    } catch (err) {
      throw toSanitizedAppError(err, 'gcp-service-account-save');
    }

    const stored = await replaceUserGcpCredential(c.env, userId, credential);
    if (previous) {
      await clearCredentialCache(c.env, userId, previous);
    }
    return c.json({
      success: true,
      credential: {
        id: stored.id,
        provider: 'gcp' as const,
        connected: true,
        createdAt: stored.createdAt,
        gcp: toGcpCredentialMetadata(credential),
      },
    });
  },
);

/** Run the existing keyless WIF setup and store its metadata atomically. */
gcpRoutes.post('/setup', jsonValidator(GcpSetupSchema), async (c) => {
  const userId = getUserId(c);
  const body = c.req.valid('json');
  if (!(await getGoogleInfraOAuthConfig(c.env))) {
    throw errors.badRequest('Google infrastructure OAuth is not configured on this SAM instance');
  }
  const oauthToken = await resolveOAuthToken(body.oauthHandle, c.env.KV);

  const previous = await getStoredGcpCredential(c.env, userId).catch(() => null);
  let credential: Awaited<ReturnType<typeof runGcpSetup>>;
  try {
    credential = await runGcpSetup(
      oauthToken,
      body.gcpProjectId,
      body.defaultZone,
      c.env,
    );
  } catch (err) {
    throw toSanitizedAppError(err, 'gcp-setup');
  }

  await replaceUserGcpCredential(c.env, userId, credential);
  if (previous) {
    await clearCredentialCache(c.env, userId, previous);
  }

  try {
    await verifyGcpOidcSetup(userId, 'setup-verification', credential, c.env);
  } catch (verifyErr) {
    log.warn('gcp.oidc_verification_failed', {
      error: verifyErr instanceof Error ? verifyErr.message : String(verifyErr),
    });
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
});

/** Verify the currently stored GCP credential, regardless of auth mode. */
gcpRoutes.post('/verify', async (c) => {
  const userId = getUserId(c);
  const gcpCredential = await getStoredGcpCredential(c.env, userId);
  if (!gcpCredential) {
    throw errors.notFound('GCP credential not configured');
  }

  try {
    if (gcpCredential.authType === 'service-account-key') {
      const token = await getGcpAccessToken(
        userId,
        'verification',
        gcpCredential,
        c.env,
      );
      await verifyGcpServiceAccountAccess(gcpCredential, token, c.env);
    } else {
      await verifyGcpOidcSetup(userId, 'verification', gcpCredential, c.env);
    }
    return c.json({ success: true, verified: true });
  } catch (err) {
    return c.json({
      success: false,
      verified: false,
      error: sanitizeGcpError(err, 'gcp-verify'),
    });
  }
});

export { gcpRoutes };
