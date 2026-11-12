/** Fail-closed occupancy checks used inside NodeLifecycle's serialized idle transition. */
import {
  DEFAULT_NODE_WORKSPACE_IDLE_TIMEOUT_MS,
  isUserOwnedNodeClass,
} from '@simple-agent-manager/shared';

import { log } from '../lib/logger';
import { parsePositiveInt } from '../lib/route-helpers';
import { boundedWarmPlacementClaimGuardSql } from '../services/warm-placement-claims';
import {
  ACTIVE_WORKSPACE_RESERVATION_STATUS_SQL,
} from '../services/workspace-reservation-usage';
import type { NodeLifecycleEnv } from './node-lifecycle-types';

/** On lookup failure retain the existing managed-node treatment; the cleanup cron is
 * the backstop and cannot destroy a user-owned node through this advisory result.
 */
export async function isUserOwnedLifecycleNode(
  env: NodeLifecycleEnv,
  nodeId: string
): Promise<boolean> {
  try {
    const row = await env.DATABASE.prepare('SELECT node_class FROM nodes WHERE id = ?')
      .bind(nodeId)
      .first<{ node_class: string }>();
    return isUserOwnedNodeClass(row?.node_class);
  } catch (err) {
    log.error('node_lifecycle.node_class_lookup_failed', {
      nodeId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/** A live admission owns capacity before its workspace exists, for a finite window only. */
export async function hasRecentPlacementClaim(
  env: NodeLifecycleEnv,
  nodeId: string
): Promise<boolean> {
  const claimWindowMs = parsePositiveInt(
    env.NODE_WORKSPACE_IDLE_TIMEOUT_MS ?? env.NODE_ORPHAN_IDLE_TIMEOUT_MS,
    DEFAULT_NODE_WORKSPACE_IDLE_TIMEOUT_MS
  );
  try {
    const row = await env.DATABASE.prepare(
      `SELECT 1 AS unclaimed WHERE 1 = 1 ${boundedWarmPlacementClaimGuardSql('?')}`
    )
      .bind(nodeId, new Date(Date.now() - claimWindowMs).toISOString())
      .first<{ unclaimed: number }>();
    return row === null;
  } catch (error) {
    log.warn('node_lifecycle.placement_claim_unknown', { nodeId, error: String(error) });
    return true;
  }
}

export async function hasActiveWorkspace(env: NodeLifecycleEnv, nodeId: string): Promise<boolean> {
  try {
    const row = await env.DATABASE.prepare(
      `SELECT 1 AS occupied FROM workspaces WHERE node_id = ?
          AND status IN (${ACTIVE_WORKSPACE_RESERVATION_STATUS_SQL}) LIMIT 1`
    )
      .bind(nodeId)
      .first<{ occupied: number }>();
    return row !== null;
  } catch (error) {
    // Never turn an uncertain occupancy read into a destructive fallback.
    log.warn('node_lifecycle.occupancy_unknown', { nodeId, error: String(error) });
    return true;
  }
}

/** Serialize transitions without breaking the DO input gate on an expected conflict.
 * A rejection inside blockConcurrencyWhile resets the object before RPC callers can handle it.
 * Return the failure through the gate and rethrow only after the critical section has ended.
 */
export async function runNodeLifecycleTransition<T>(
  ctx: DurableObjectState,
  transition: () => Promise<T>
): Promise<T> {
  const result = await ctx.blockConcurrencyWhile(async () => {
    try {
      return { ok: true as const, value: await transition() };
    } catch (error) {
      return { ok: false as const, error };
    }
  });
  if (!result.ok) throw result.error;
  return result.value;
}
