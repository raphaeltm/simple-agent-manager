/**
 * Hand an empty managed workspace VM to NodeLifecycle, so the warm timeout, warm reuse and the
 * cleanup sweep's stopped-node teardown apply to it.
 *
 * Every last-workspace removal path and the cleanup sweep's backstop call this one operation.
 * It is keyed on the node itself, never on `tasks.auto_provisioned_node_id`: a task pack-placed
 * onto an existing pool node never records that link, and a woken conversation clears the one
 * it had (`reactivateSleepingTask`). Keying on it left a healthy cx53 running empty for 34 h
 * (tasks/archive/2026-10-11-reap-empty-managed-vm-nodes.md).
 *
 * NodeLifecycle stays the authority: `markIdle()` re-checks occupancy and node class inside the
 * Durable Object, so the read below only avoids pointless RPCs. A node without teardown
 * provenance is never handed off, because once its warm timer marks it `stopped` the cleanup
 * sweep could not destroy it and the VM would keep running behind a `stopped` row.
 *
 * Never throws and never destroys anything. A failed handoff is returned to the caller; the
 * cleanup sweep's backstop (`empty-node-warm-handoff.ts`) retries nodes that stay empty.
 */
import { DEFAULT_NODE_WARM_TIMEOUT_MS } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { parsePositiveInt } from '../lib/route-helpers';
import * as nodeLifecycleService from './node-lifecycle';
import {
  type NodeLifecycleDecision,
  type NodeLifecycleDecisionDetail,
  recordNodeLifecycleDecision,
} from './node-lifecycle-decisions';
import { cleanupNodeProvenanceSql } from './node-teardown-provenance';
import { resolveOperationsTelemetrySetting } from './operations-telemetry-settings';
import { wakeVmAdmissionWaiters } from './vm-admission-wakeup';
import { ACTIVE_WORKSPACE_RESERVATION_STATUS_SQL } from './workspace-reservation-usage';

export type NodeWarmHandoffSkipReason =
  | 'node_missing'
  | 'owner_mismatch'
  | 'not_vm'
  | 'not_workspace_role'
  | 'not_managed'
  | 'not_running'
  | 'already_warm'
  | 'no_teardown_provenance'
  | 'occupied';

export type NodeWarmHandoffResult =
  | { outcome: 'handed_to_warm' }
  /** NodeLifecycle kept the node active: a workspace or claim arrived first. */
  | { outcome: 'preserved_active' }
  | { outcome: 'skipped'; reason: NodeWarmHandoffSkipReason }
  | { outcome: 'failed'; error: string };

export interface NodeWarmHandoffInput {
  nodeId: string;
  /** Diagnostic label naming the removal path, e.g. `task_run_cleanup`. */
  reason: string;
  /** When set, a node owned by anyone else is left alone. */
  expectedUserId?: string | null;
  /** Explicit project override; otherwise preserve the longest visible retention promise. */
  warmTimeoutOverrideMs?: number | null;
  /** Preserve this project's retention even if confirmed deletion removed its workspace row. */
  sourceProjectId?: string | null;
}

interface HandoffNodeRow {
  user_id: string;
  status: string;
  warm_since: string | null;
  node_class: string;
  runtime: string;
  node_role: string;
  teardown_provenance: number;
  occupied: number;
}

function skipReason(
  node: HandoffNodeRow | null,
  expectedUserId: string | null | undefined
): NodeWarmHandoffSkipReason | null {
  if (!node) return 'node_missing';
  if (expectedUserId && node.user_id !== expectedUserId) return 'owner_mismatch';
  if (node.runtime !== 'vm') return 'not_vm';
  if (node.node_role !== 'workspace') return 'not_workspace_role';
  // Fail closed: only SAM-provisioned hardware enters the warm → teardown pipeline.
  if (node.node_class !== 'managed') return 'not_managed';
  if (node.status !== 'running') return 'not_running';
  // A second markIdle would restart a warm timer another path already armed.
  if (node.warm_since) return 'already_warm';
  if (node.teardown_provenance !== 1) return 'no_teardown_provenance';
  if (node.occupied === 1) return 'occupied';
  return null;
}

/** Keep every visible retention promise when a removal path has no explicit override. */
async function retainedWarmTimeoutMs(env: Env, input: NodeWarmHandoffInput): Promise<number> {
  const row = await env.DATABASE.prepare(
    `SELECT MAX(?, COALESCE(MAX(p.warm_node_timeout_ms), 0)) AS warm_timeout_ms
       FROM projects p
      WHERE p.id IN (
        SELECT capacity_pool_project_id FROM nodes WHERE id = ?
        UNION SELECT project_id FROM workspaces WHERE node_id = ?
        UNION SELECT ?
      )`
  )
    .bind(
      parsePositiveInt(env.NODE_WARM_TIMEOUT_MS, DEFAULT_NODE_WARM_TIMEOUT_MS),
      input.nodeId,
      input.nodeId,
      input.sourceProjectId ?? null
    )
    .first<{ warm_timeout_ms: number }>();
  if (!row || !Number.isFinite(row.warm_timeout_ms) || row.warm_timeout_ms <= 0) {
    throw new Error('Cannot establish safe node warm retention');
  }
  return row.warm_timeout_ms;
}

/** Best-effort decision log row; repeating skips are deduped (see node-lifecycle-decisions). */
async function recordHandoffDecision(
  env: Env,
  input: NodeWarmHandoffInput,
  decision: NodeLifecycleDecision,
  reason: string | null,
  detail: NodeLifecycleDecisionDetail = {},
  repeating = false
): Promise<void> {
  await recordNodeLifecycleDecision(env.DATABASE, {
    nodeId: input.nodeId,
    source: 'warm_handoff',
    decision,
    reason,
    detail: { removalPath: input.reason, ...detail },
    dedupeWindowMs: repeating
      ? await resolveOperationsTelemetrySetting(env, 'nodeDecisionDedupeWindowMs')
      : undefined,
  });
}

export async function handOffEmptyWorkspaceNode(
  env: Env,
  input: NodeWarmHandoffInput
): Promise<NodeWarmHandoffResult> {
  const logContext = { nodeId: input.nodeId, reason: input.reason };
  try {
    const node = await env.DATABASE.prepare(
      `SELECT n.user_id, n.status, n.warm_since, n.node_class, n.runtime, n.node_role,
              CASE WHEN ${cleanupNodeProvenanceSql('n', true)} THEN 1 ELSE 0 END
                AS teardown_provenance,
              EXISTS (
                SELECT 1 FROM workspaces live
                WHERE live.node_id = n.id
                  AND live.status IN (${ACTIVE_WORKSPACE_RESERVATION_STATUS_SQL})
              ) AS occupied
         FROM nodes n
        WHERE n.id = ?`
    )
      .bind(input.nodeId)
      .first<HandoffNodeRow>();

    const skipped = skipReason(node, input.expectedUserId);
    if (skipped || !node) {
      log.info('node_warm_handoff.skipped', { ...logContext, skipReason: skipped });
      // A missing node has nothing to explain; every other skip says why it stayed alive.
      if (node) await recordHandoffDecision(env, input, 'handoff_skipped', skipped, {}, true);
      return { outcome: 'skipped', reason: skipped ?? 'node_missing' };
    }

    const warmTimeoutMs = input.warmTimeoutOverrideMs ?? (await retainedWarmTimeoutMs(env, input));
    const state = await nodeLifecycleService.markIdle(
      env,
      input.nodeId,
      node.user_id,
      warmTimeoutMs
    );
    if (state.status !== 'warm') {
      log.info('node_warm_handoff.preserved_active', { ...logContext, state: state.status });
      await recordHandoffDecision(env, input, 'preserved_active', `node_lifecycle_${state.status}`);
      return { outcome: 'preserved_active' };
    }

    log.info('node_warm_handoff.handed_to_warm', {
      ...logContext,
      userId: node.user_id,
      warmSince: state.warmSince,
      warmTimeoutOverrideMs: warmTimeoutMs,
    });
    await recordHandoffDecision(env, input, 'handed_to_warm', null, { warmTimeoutMs });
    try {
      // A warm node is reusable capacity: let queued admissions claim it now.
      await wakeVmAdmissionWaiters(env, { userId: node.user_id, reason: 'node_marked_warm' });
    } catch (error) {
      log.warn('node_warm_handoff.admission_wake_failed', {
        ...logContext,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return { outcome: 'handed_to_warm' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('node_warm_handoff.failed', { ...logContext, error: message });
    await recordHandoffDecision(env, input, 'handoff_failed', message, {}, true);
    return { outcome: 'failed', error: message };
  }
}
