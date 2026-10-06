/**
 * Deployment registry credential service.
 *
 * Mints short-lived Cloudflare managed container registry credentials
 * for agents to push images directly to registry.cloudflare.com.
 *
 * SECURITY: Credential values (username/password) are NEVER logged or
 * persisted. Only audit metadata is recorded.
 */
import type { Env } from '../env';
import { log } from '../lib/logger';
import {
  buildMintConfigFromEnv,
  DEFAULT_CLOUDFLARE_REGISTRY_HOST,
  mintCloudflareRegistryCredentials,
} from './cf-registry';

const DEFAULT_REGISTRY_CREDENTIAL_EXPIRATION_MINUTES = 60;
const DEFAULT_REGISTRY_CREDENTIAL_RATE_LIMIT = 10;
const DEFAULT_REGISTRY_CREDENTIAL_RATE_WINDOW_SECONDS = 300;

export interface RegistryCredentialResult {
  registry: string;
  username: string;
  password: string;
  /** Project-scoped namespace prefix — all images must be pushed under this path */
  namespace: string;
  /** ISO timestamp when the credential expires */
  expiresAt: string;
}

export interface RegistryCredentialAudit {
  projectId: string;
  userId: string;
  /** Empty string for project-chat sessions (no task context) */
  taskId: string;
  environment?: string;
  namespace: string;
  expirationMinutes: number;
  mintedAt: string;
}

export interface RegistryCredentialRateLimitResult {
  allowed: boolean;
  maxRequests: number;
  windowSeconds: number;
  count: number | null;
  retryAfterSeconds: number;
}

/**
 * Build the project-scoped registry namespace prefix.
 *
 * Convention: `{accountId}/sam-{projectId}`
 * This prefix MUST match what the deployment manifest validation expects.
 * The namespace includes the CF account ID because CF registry paths are
 * `registry.cloudflare.com/{accountId}/{repository}:{tag}`.
 */
export function buildProjectNamespace(accountId: string, projectId: string): string {
  const sanitized = projectId.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  return `${accountId}/sam-${sanitized}`;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Mint a short-lived registry credential for a project.
 *
 * @returns Credential with registry host, auth, namespace, and expiry
 * @throws Error if platform CF token is not configured or mint fails
 */
export async function mintProjectRegistryCredential(
  env: Env,
  projectId: string,
  userId: string,
  taskId: string,
  environment?: string,
  options?: { permissions?: Array<'pull' | 'push'> }
): Promise<RegistryCredentialResult> {
  const expirationMinutes = parsePositiveInteger(
    env.REGISTRY_CREDENTIAL_EXPIRATION_MINUTES,
    DEFAULT_REGISTRY_CREDENTIAL_EXPIRATION_MINUTES
  );

  const registryHost = (env.REGISTRY_HOST || DEFAULT_CLOUDFLARE_REGISTRY_HOST).trim();

  const mintConfig = buildMintConfigFromEnv(env, {
    registryHost,
    expirationMinutes,
    permissions: options?.permissions ?? ['pull', 'push'],
  });

  if (!mintConfig) {
    throw new Error(
      'Registry credential minting is not available: CF_ACCOUNT_ID and CF_API_TOKEN must be configured'
    );
  }

  const namespace = buildProjectNamespace(mintConfig.accountId, projectId);

  const credentials = await mintCloudflareRegistryCredentials(mintConfig);

  const mintedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + expirationMinutes * 60_000).toISOString();

  // Audit log — metadata only, NEVER credential values
  const audit: RegistryCredentialAudit = {
    projectId,
    userId,
    taskId,
    environment,
    namespace,
    expirationMinutes,
    mintedAt,
  };
  log.info('registry_credential_minted', audit as unknown as Record<string, unknown>);

  return {
    registry: credentials.registry,
    username: credentials.username,
    password: credentials.password,
    namespace,
    expiresAt,
  };
}

/**
 * Get the rate limit config for registry credential minting.
 */
export function getRegistryCredentialRateLimit(env: Env): {
  maxRequests: number;
  windowSeconds: number;
} {
  return {
    maxRequests: parsePositiveInteger(
      env.REGISTRY_CREDENTIAL_RATE_LIMIT,
      DEFAULT_REGISTRY_CREDENTIAL_RATE_LIMIT
    ),
    windowSeconds: parsePositiveInteger(
      env.REGISTRY_CREDENTIAL_RATE_WINDOW_SECONDS,
      DEFAULT_REGISTRY_CREDENTIAL_RATE_WINDOW_SECONDS
    ),
  };
}

/**
 * Atomically consume one project-scoped registry-credential mint quota slot.
 *
 * D1/SQLite serializes this guarded upsert for a fixed project/window key:
 * callers only get a returned row when the counter was inserted or incremented
 * below the configured cap. Failed mint attempts still consume quota; callers
 * invoke this before contacting Cloudflare to bound upstream load during
 * incidents.
 */
export async function consumeRegistryCredentialRateLimit(
  env: Env,
  projectId: string,
  nowMs = Date.now()
): Promise<RegistryCredentialRateLimitResult> {
  const rateLimit = getRegistryCredentialRateLimit(env);
  const nowSeconds = Math.floor(nowMs / 1000);
  const windowStart = Math.floor(nowSeconds / rateLimit.windowSeconds) * rateLimit.windowSeconds;
  const retryAfterSeconds = Math.max(1, windowStart + rateLimit.windowSeconds - nowSeconds);
  const rateKey = `registry-cred-rate:${projectId}:${windowStart}`;
  const nowIso = new Date(nowMs).toISOString();
  const expiresAt = new Date((windowStart + rateLimit.windowSeconds + 60) * 1000).toISOString();

  const row = await env.DATABASE.prepare(
    `INSERT INTO registry_credential_rate_limits
       (rate_key, project_id, window_start, request_count, expires_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?)
     ON CONFLICT(rate_key) DO UPDATE SET
       request_count = registry_credential_rate_limits.request_count + 1,
       expires_at = excluded.expires_at,
       updated_at = excluded.updated_at
     WHERE registry_credential_rate_limits.request_count < ?
     RETURNING request_count`
  )
    .bind(rateKey, projectId, windowStart, expiresAt, nowIso, rateLimit.maxRequests)
    .first<{ request_count: number }>();

  void env.DATABASE.prepare('DELETE FROM registry_credential_rate_limits WHERE expires_at < ?')
    .bind(nowIso)
    .run()
    .catch((err: unknown) => {
      log.warn('registry_credential_rate_limit_cleanup_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

  return {
    allowed: Boolean(row),
    maxRequests: rateLimit.maxRequests,
    windowSeconds: rateLimit.windowSeconds,
    count: row?.request_count ?? null,
    retryAfterSeconds,
  };
}
