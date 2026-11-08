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
import {
  deleteGcpApiHealth,
  listGcpApiIssuesSafely,
  probeGcpCloudBilling,
  toGcpCredentialMetadataWithApiIssues,
} from '../services/gcp-api-health';
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
import { parseGcpCredential } from '../services/provider-credentials';

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

interface StoredGcpCredential {
  id: string;
  credential: GcpCredential;
}

async function getStoredGcpCredential(
  env: Env,
  userId: string,
): Promise<StoredGcpCredential | null> {
  const db = drizzle(env.DATABASE, { schema });
  const [row] = await db
    .select({
      id: schema.credentials.id,
      encryptedToken: schema.credentials.encryptedToken,
      iv: schema.credentials.iv,
    })
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
  return { id: row.id, credential: parseGcpCredential(decrypted) };
}

/** Drop what SAM cached for a credential that was just replaced. */
async function forgetReplacedCredential(
  env: Env,
  userId: string,
  previous: StoredGcpCredential,
): Promise<void> {
  await clearCredentialCache(env, userId, previous.credential);
  try {
    await deleteGcpApiHealth(env, previous.id);
  } catch (err) {
    log.warn('gcp.api_health_cleanup_failed', {
      userId,
      credentialId: previous.id,
      error: err instanceof Error ? err.name : 'unknown',
    });
  }
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

    let previous: StoredGcpCredential | null = null;
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
      await forgetReplacedCredential(c.env, userId, previous);
    }
    return c.json({
      success: true,
      credential: {
        id: stored.id,
        provider: 'gcp' as const,
        connected: true,
        createdAt: stored.createdAt,
        gcp: await toGcpCredentialMetadataWithApiIssues(c.env, stored.id, credential),
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
    await forgetReplacedCredential(c.env, userId, previous);
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

/**
 * Verify the currently stored GCP credential, regardless of auth mode, then re-check the
 * required Google APIs SAM can probe (Cloud Billing) so an owner who just enabled one sees the
 * warning clear. The probe outcome is recorded on the credential and returned as `apiIssues`.
 */
gcpRoutes.post('/verify', async (c) => {
  const userId = getUserId(c);
  const stored = await getStoredGcpCredential(c.env, userId);
  if (!stored) {
    throw errors.notFound('GCP credential not configured');
  }
  const { id: credentialId, credential: gcpCredential } = stored;

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
  } catch (err) {
    return c.json({
      success: false,
      verified: false,
      error: sanitizeGcpError(err, 'gcp-verify'),
      apiIssues: await listGcpApiIssuesSafely(c.env, credentialId, gcpCredential),
    });
  }

  const billingCheck = await probeGcpCloudBilling(c.env, credentialId, gcpCredential, {
    credentialSource: 'user',
    userId,
    projectId: null,
  });
  return c.json({
    success: true,
    verified: true,
    billingCheck,
    apiIssues: await listGcpApiIssuesSafely(c.env, credentialId, gcpCredential),
  });
});

export { gcpRoutes };
