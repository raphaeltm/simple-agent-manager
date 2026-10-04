/**
 * Per-workspace limit for POST /api/workspaces/:id/callback-token/renew.
 *
 * A credential rotation endpoint needs a per-principal limit whose state cannot lose
 * increments under concurrent requests (.claude/rules/28), so this is one guarded D1
 * upsert, not the generic KV limiter. The renewal service spends a slot only after both
 * proofs verified and D1 confirmed the workspace is active on the calling node, so a
 * party without the workspace's credentials cannot use up its quota.
 *
 * A healthy VM agent asks about once per half token lifetime and waits
 * WORKSPACE_CALLBACK_TOKEN_RETRY_MAX after a not-due answer, far below the default. The
 * limit bounds a holder of both proofs replaying them in a loop.
 */
import type { Env } from '../env';
import { parsePositiveInt } from '../lib/route-helpers';
import { getRateLimit } from '../middleware/rate-limit';

/** Window for RATE_LIMIT_CALLBACK_TOKEN_RENEWAL. */
export const DEFAULT_CALLBACK_TOKEN_RENEWAL_WINDOW_SECONDS = 3600;

export function getCallbackTokenRenewalRateLimit(env: Env): {
  limit: number;
  windowSeconds: number;
} {
  return {
    limit: getRateLimit(env, 'CALLBACK_TOKEN_RENEWAL'),
    windowSeconds: parsePositiveInt(
      env.RATE_LIMIT_CALLBACK_TOKEN_RENEWAL_WINDOW_SECONDS,
      DEFAULT_CALLBACK_TOKEN_RENEWAL_WINDOW_SECONDS
    ),
  };
}

export type CallbackTokenRenewalQuota =
  | { outcome: 'allowed' }
  | { outcome: 'limited'; retryAfterSeconds: number }
  | { outcome: 'workspace_missing' };

/**
 * Atomically count one renewal attempt for `workspaceId` in the current fixed window.
 *
 * SQLite serializes the single upsert, so concurrent attempts cannot both read the same
 * count. The row is inserted only while the workspace row exists; a workspace deleted
 * since the caller's checks returns `workspace_missing` instead of a foreign-key error.
 */
export async function consumeCallbackTokenRenewalQuota(
  env: Env,
  workspaceId: string,
  nowMs = Date.now()
): Promise<CallbackTokenRenewalQuota> {
  const { limit, windowSeconds } = getCallbackTokenRenewalRateLimit(env);
  const nowSeconds = Math.floor(nowMs / 1000);
  const windowStart = Math.floor(nowSeconds / windowSeconds) * windowSeconds;

  // The SELECT needs its WHERE clause: SQLite requires one to parse an upsert whose
  // values come from a SELECT.
  const row = await env.DATABASE.prepare(
    `INSERT INTO workspace_callback_token_renewal_rate_limits (workspace_id, window_start, count)
     SELECT id, ?, 1 FROM workspaces WHERE id = ?
     ON CONFLICT(workspace_id) DO UPDATE SET
       count = CASE
         WHEN workspace_callback_token_renewal_rate_limits.window_start = excluded.window_start
           THEN workspace_callback_token_renewal_rate_limits.count + 1
         ELSE 1
       END,
       window_start = excluded.window_start
     RETURNING count`
  )
    .bind(windowStart, workspaceId)
    .first<{ count: number }>();

  if (!row) return { outcome: 'workspace_missing' };
  if (Number(row.count) > limit) {
    return {
      outcome: 'limited',
      retryAfterSeconds: Math.max(1, windowStart + windowSeconds - nowSeconds),
    };
  }
  return { outcome: 'allowed' };
}
