/**
 * Credential generations for callback JWTs.
 *
 * A workspace ID (and an Instant node ID) can be reactivated under a new runtime: a VM
 * restart or rebuild, or an Instant container recovery. Each reactivation rotates
 * `callback_generation` on the row in the same D1 write that reactivates it, and every
 * credential minted for the new runtime carries the new value (`cgen` claim). A token
 * whose claim differs from its row belongs to a retired runtime and is rejected, even
 * though it is unexpired and the workspace is active again.
 *
 * NULL on the row means "never rotated": tokens minted before generations existed carry
 * no claim and match it, so a deploy does not invalidate running workspaces, while the
 * first rotation revokes them.
 */
import type { Env } from '../env';
import { log } from '../lib/logger';
import { AppError } from '../middleware/error';

export type CallbackCredentialScope = 'node' | 'workspace';

/**
 * The current generation of the row a callback token names: a string, null when the row
 * has never been rotated, or undefined when the row does not exist. A missing row is left
 * to the sinks, which already answer it with their designed 410/404 responses.
 */
export async function loadCallbackCredentialGeneration(
  env: Env,
  scope: CallbackCredentialScope,
  id: string
): Promise<string | null | undefined> {
  const table = scope === 'node' ? 'nodes' : 'workspaces';
  const row = await env.DATABASE.prepare(
    `SELECT callback_generation AS generation FROM ${table} WHERE id = ? LIMIT 1`
  )
    .bind(id)
    .first<{ generation: string | null }>();
  return row ? row.generation : undefined;
}

/**
 * Reject a verified callback token whose credential generation is not its row's current
 * one. `tokenGeneration` is the token's `cgen` claim, null when absent.
 */
export async function assertCallbackCredentialGenerationCurrent(
  env: Env,
  scope: CallbackCredentialScope,
  id: string,
  tokenGeneration: string | null
): Promise<void> {
  const current = await loadCallbackCredentialGeneration(env, scope, id);
  if (current === undefined || current === tokenGeneration) return;
  log.info('callback_token.generation_rejected', {
    scope,
    id,
    tokenGeneration,
    currentGeneration: current,
    action: 'rejected',
  });
  throw new AppError(401, 'UNAUTHORIZED', 'Callback token belongs to a retired runtime');
}
