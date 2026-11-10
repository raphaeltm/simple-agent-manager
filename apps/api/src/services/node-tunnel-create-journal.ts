import { CloudflareTunnelApiError } from './cloudflare-tunnel-api';
import type { TunnelEnv } from './node-tunnel-config';

/**
 * Persist POST intent before sending it. Only an observed success or definitive rejection
 * settles that intent. A timeout, cancellation or process death leaves durable uncertainty:
 * cleanup keeps polling, even after an empty inventory, for a possible late commit.
 */
export async function withJournaledTunnelCreate<T>(
  env: TunnelEnv,
  journalId: string,
  create: () => Promise<T>
): Promise<T> {
  const claim = await env.DATABASE.prepare(
    `UPDATE node_cloudflare_tunnels SET pending_create_count = pending_create_count + 1,
       updated_at = ? WHERE id = ? AND status IN ('provisioning', 'active')`
  )
    .bind(new Date().toISOString(), journalId)
    .run();
  if ((claim.meta?.changes ?? 0) !== 1) {
    throw new Error('Tunnel ownership was released before Cloudflare create');
  }
  let settled = false;
  try {
    const result = await create();
    settled = true;
    return result;
  } catch (error) {
    settled =
      error instanceof CloudflareTunnelApiError &&
      error.status !== undefined &&
      error.status >= 400 &&
      error.status < 500 &&
      error.status !== 408;
    throw error;
  } finally {
    if (settled) {
      // Also settle after cleanup claims the row: that cleanup could have seen no resource
      // while this POST was running, but cannot mark the row cleaned while this count is >0.
      await env.DATABASE.prepare(
        `UPDATE node_cloudflare_tunnels SET pending_create_count = pending_create_count - 1,
           updated_at = ? WHERE id = ? AND pending_create_count > 0`
      )
        .bind(new Date().toISOString(), journalId)
        .run();
    }
  }
}
