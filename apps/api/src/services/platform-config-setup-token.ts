import type { Env } from '../env';
import { creatorId, positiveIntegerEnv } from './platform-config-store';

/* Setup-token verification and its D1-backed per-identifier attempt rate limit. */

const DEFAULT_SETUP_RATE_LIMIT_WINDOW_SECONDS = 15 * 60;
const DEFAULT_SETUP_RATE_LIMIT_MAX_ATTEMPTS = 10;

export function isSetupTokenConfigured(env: Env): boolean {
  return Boolean(env.SETUP_TOKEN && env.SETUP_TOKEN.trim());
}

async function stableHash(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .slice(0, 16)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  const length = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let i = 0; i < length; i += 1) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

export async function verifySetupToken(
  env: Env,
  submittedToken: string,
  identifier: string
): Promise<{ ok: true } | { ok: false; status: 401 | 429; message: string }> {
  const token = env.SETUP_TOKEN?.trim();
  if (!token) {
    return { ok: false, status: 401, message: 'Setup token is not configured' };
  }

  const now = Math.floor(Date.now() / 1000);
  const windowSeconds = positiveIntegerEnv(
    env,
    'SETUP_RATE_LIMIT_WINDOW_SECONDS',
    DEFAULT_SETUP_RATE_LIMIT_WINDOW_SECONDS
  );
  const maxAttempts = positiveIntegerEnv(
    env,
    'SETUP_RATE_LIMIT_MAX_ATTEMPTS',
    DEFAULT_SETUP_RATE_LIMIT_MAX_ATTEMPTS
  );
  const windowStart = now - windowSeconds;
  const key = `setup.rateLimit.${await stableHash(identifier || 'unknown')}`;

  await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO platform_settings (key, value, updated_at, updated_by)
     VALUES (?, json_object('windowStart', ?, 'count', 0), CURRENT_TIMESTAMP, ?)`
  )
    .bind(key, now, creatorId(env))
    .run();

  const result = await env.DATABASE.prepare(
    `UPDATE platform_settings
     SET value = CASE
       WHEN CAST(json_extract(value, '$.windowStart') AS INTEGER) < ?
         THEN json_object('windowStart', ?, 'count', 1)
       ELSE json_object('windowStart', CAST(json_extract(value, '$.windowStart') AS INTEGER), 'count', CAST(json_extract(value, '$.count') AS INTEGER) + 1)
     END,
     updated_at = CURRENT_TIMESTAMP
     WHERE key = ?
       AND (
         CAST(json_extract(value, '$.windowStart') AS INTEGER) < ?
         OR CAST(json_extract(value, '$.count') AS INTEGER) < ?
       )`
  )
    .bind(windowStart, now, key, windowStart, maxAttempts)
    .run();

  if (!result.meta.changes || result.meta.changes === 0) {
    return { ok: false, status: 429, message: 'Too many setup token attempts. Try again later.' };
  }

  if (!constantTimeEqual(submittedToken.trim(), token)) {
    return { ok: false, status: 401, message: 'Invalid setup token' };
  }

  return { ok: true };
}
