import type { Env } from '../env';
import {
  DEFAULT_RATE_LIMITS,
  DEFAULT_WINDOW_SECONDS,
  RateLimitError,
} from '../middleware/rate-limit';

function configuredLimit(env: Env): number {
  const parsed = Number.parseInt(env.RATE_LIMIT_CREDENTIAL_UPDATE ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_RATE_LIMITS.CREDENTIAL_UPDATE;
}

async function stableHash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .slice(0, 16)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Atomically rate-limit credential mutations with a D1 conditional update.
 * Unlike the generic KV limiter, concurrent requests cannot lose increments.
 */
export async function enforceCredentialMutationRateLimit(
  env: Env,
  principalId: string,
  scope: 'gcp-service-account' | 'google-infra-oauth',
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const windowSeconds = DEFAULT_WINDOW_SECONDS;
  const windowStart = now - windowSeconds;
  const limit = configuredLimit(env);
  const key = `credential.rateLimit.${scope}.${await stableHash(principalId)}`;

  await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO platform_settings (key, value, updated_at, updated_by)
     VALUES (?, json_object('windowStart', ?, 'count', 0), CURRENT_TIMESTAMP, ?)`,
  ).bind(key, now, principalId).run();

  const result = await env.DATABASE.prepare(
    `UPDATE platform_settings
     SET value = CASE
       WHEN CAST(json_extract(value, '$.windowStart') AS INTEGER) < ?
         THEN json_object('windowStart', ?, 'count', 1)
       ELSE json_object(
         'windowStart', CAST(json_extract(value, '$.windowStart') AS INTEGER),
         'count', CAST(json_extract(value, '$.count') AS INTEGER) + 1
       )
     END,
     updated_at = CURRENT_TIMESTAMP,
     updated_by = ?
     WHERE key = ?
       AND (
         CAST(json_extract(value, '$.windowStart') AS INTEGER) < ?
         OR CAST(json_extract(value, '$.count') AS INTEGER) < ?
       )`,
  ).bind(windowStart, now, principalId, key, windowStart, limit).run();

  if (!result.meta.changes) {
    throw new RateLimitError(windowSeconds);
  }
}
