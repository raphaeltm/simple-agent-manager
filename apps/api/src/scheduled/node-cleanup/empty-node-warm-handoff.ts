/**
 * Cleanup phase — empty managed workspace VMs that never entered the warm pool.
 *
 * NodeLifecycle only learns a node is empty when a removal path hands it off, and every other
 * running-node phase keys ownership on `tasks.auto_provisioned_node_id`. A node whose last
 * workspace left through a path that skipped the handoff, and whose provisioning link a
 * conversation wake had cleared, was invisible to every layer: on 2026-10-09 a healthy cx53 ran
 * 34 h with no workspace until an operator deleted it by hand
 * (tasks/archive/2026-10-11-reap-empty-managed-vm-nodes.md).
 *
 * This phase destroys nothing. It hands each candidate to NodeLifecycle exactly as a removal
 * path would, so warm reuse, the normal warm timeout and the stopped-node teardown apply, and
 * warm retention is unchanged (policy d08d64dc). The candidate needs teardown provenance so that
 * teardown can actually finish, and only healthy nodes qualify: a heartbeat-lost node is the
 * unhealthy phase's to drain and release.
 *
 * In-flight work is excluded without a separate lock: a reservation is a live workspace row,
 * written atomically against a `running` node (`reserveWorkspacePlacement`); a warm-reuse claim
 * precedes its row, so recent claims are excluded (`boundedWarmPlacementClaimGuardSql`); and a
 * node still provisioning is not `running` and is younger than the grace. Handing an occupied
 * node to NodeLifecycle is harmless anyway: its warm alarm re-checks occupancy atomically.
 *
 * Idleness is the last workspace ACTIVITY, never `nodes.updated_at` (heartbeats rewrite it,
 * rule 53). It falls back to `nodes.created_at`, so a fresh node always gets the full grace. Bounded by NODE_CLEANUP_SWEEP_LIMIT (rule 47). A handed-off node leaves the
 * candidate set through its `warm_since`; every other outcome sets `cleanup_backoff_until`, so
 * neither a failing candidate nor a repeated `markIdle()` restarting a warm timer can loop.
 */
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { handOffEmptyWorkspaceNode } from '../../services/node-warm-handoff';
import { persistError } from '../../services/observability';
import {
  ACTIVE_WORKSPACE_RESERVATION_STATUS_SQL,
} from '../../services/workspace-reservation-usage';
import {
  boundedWarmPlacementClaimGuardSql,
  type CleanupConfig,
  type CleanupDb,
  cleanupNodeProvenanceSql,
  getNodeWorkspaceIdleThresholdIso,
  LAST_WORKSPACE_ACTIVITY_SQL,
  markNodeCleanupBackoff,
  type NodeCleanupResult,
} from './shared';

const RECOVERY_TYPE = 'empty_node_warm_handoff';

type Candidate = {
  id: string;
  user_id: string;
  created_at: string;
  last_activity: string;
};

/** Every action is recorded with exactly one of these reasons. */
type HandoffRecordReason =
  'missed_warm_handoff' | 'preserved_active' | 'warm_since_not_persisted' | 'handoff_failed';

async function loadCandidates(env: Env, now: Date, config: CleanupConfig): Promise<Candidate[]> {
  const graceThreshold = new Date(now.getTime() - config.emptyNodeWarmHandoffGraceMs).toISOString();
  const claimWindowThreshold = getNodeWorkspaceIdleThresholdIso(now, config);
  const rows = await env.DATABASE.prepare(
    `SELECT n.id, n.user_id, n.created_at, ${LAST_WORKSPACE_ACTIVITY_SQL} AS last_activity
     FROM nodes n
     LEFT JOIN workspaces w ON w.node_id = n.id
     WHERE n.status = 'running'
       AND n.warm_since IS NULL
       AND n.node_class = 'managed'
       AND n.runtime = 'vm'
       AND n.node_role = 'workspace'
       AND n.health_status = 'healthy'
       AND ${cleanupNodeProvenanceSql('n', true)}
       AND (n.cleanup_backoff_until IS NULL OR n.cleanup_backoff_until <= ?)
       AND NOT EXISTS (
         SELECT 1 FROM workspaces live
         WHERE live.node_id = n.id
           AND live.status IN (${ACTIVE_WORKSPACE_RESERVATION_STATUS_SQL})
       )
       ${boundedWarmPlacementClaimGuardSql('n.id')}
     GROUP BY n.id, n.user_id, n.created_at
     HAVING ${LAST_WORKSPACE_ACTIVITY_SQL} < ?
     ORDER BY last_activity ASC
     LIMIT ?`
  )
    .bind(now.toISOString(), claimWindowThreshold, graceThreshold, config.nodeSweepLimit)
    .all<Candidate>();
  return rows.results;
}

async function record(
  env: Env,
  node: Candidate,
  reason: HandoffRecordReason,
  now: Date,
  config: CleanupConfig,
  detail: Record<string, string | number | null> = {}
): Promise<void> {
  const context = {
    recoveryType: RECOVERY_TYPE,
    reason,
    nodeId: node.id,
    createdAt: node.created_at,
    lastWorkspaceActivity: node.last_activity,
    idleMs: now.getTime() - Date.parse(node.last_activity),
    graceMs: config.emptyNodeWarmHandoffGraceMs,
    ...detail,
  };
  const failed = reason === 'handoff_failed';
  log[failed ? 'error' : 'warn'](`node_cleanup.${RECOVERY_TYPE}`, context);
  try {
    await persistError(
      env.OBSERVABILITY_DATABASE,
      {
        source: 'api',
        level: failed ? 'error' : 'warn',
        message:
          reason === 'missed_warm_handoff'
            ? 'Handed empty managed node to NodeLifecycle (its last-workspace handoff was missed)'
            : `Empty managed node warm handoff not completed: ${reason}`,
        context,
        userId: node.user_id,
        nodeId: node.id,
      },
      env
    );
  } catch (error) {
    // Recording a decision must never abort the phase (rule 53).
    log.error('node_cleanup.empty_node_warm_handoff_record_failed', {
      nodeId: node.id,
      reason,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function warmSincePersisted(env: Env, nodeId: string): Promise<boolean> {
  const row = await env.DATABASE.prepare('SELECT warm_since FROM nodes WHERE id = ?')
    .bind(nodeId)
    .first<{ warm_since: string | null }>();
  return Boolean(row?.warm_since);
}

async function handOffCandidate(
  env: Env,
  node: Candidate,
  now: Date,
  config: CleanupConfig,
  result: NodeCleanupResult
): Promise<void> {
  const backoffUntil = new Date(now.getTime() + config.failureBackoffMs).toISOString();
  const handoff = await handOffEmptyWorkspaceNode(env, {
    nodeId: node.id,
    expectedUserId: node.user_id,
    reason: 'cleanup_sweep_backstop',
  });

  if (handoff.outcome === 'handed_to_warm') {
    if (await warmSincePersisted(env, node.id)) {
      result.emptyNodesHandedToWarm++;
      await record(env, node, 'missed_warm_handoff', now, config);
      return;
    }
    // NodeLifecycle is warm but D1 never saw it, so this node would be selected again and a
    // second markIdle() would restart its warm timer. Fence it past the warm window instead.
    await markNodeCleanupBackoff(env, node.id, backoffUntil);
    result.emptyNodesHandoffSkipped++;
    await record(env, node, 'warm_since_not_persisted', now, config, { backoffUntil });
    return;
  }

  if (handoff.outcome === 'skipped') {
    // Changed between selection and handoff (a workspace arrived, it went warm or stopped).
    // Those states already leave the candidate set.
    log.info('node_cleanup.empty_node_warm_handoff_skipped', {
      nodeId: node.id,
      skipReason: handoff.reason,
    });
    result.emptyNodesHandoffSkipped++;
    return;
  }

  await markNodeCleanupBackoff(env, node.id, backoffUntil);
  if (handoff.outcome === 'preserved_active') {
    result.emptyNodesHandoffSkipped++;
    await record(env, node, 'preserved_active', now, config, { backoffUntil });
    return;
  }
  result.errors++;
  await record(env, node, 'handoff_failed', now, config, {
    backoffUntil,
    error: handoff.error,
  });
}

export async function sweepEmptyNodeWarmHandoff(
  _db: CleanupDb,
  env: Env,
  now: Date,
  config: CleanupConfig,
  result: NodeCleanupResult
): Promise<void> {
  const candidates = await loadCandidates(env, now, config);
  for (const node of candidates) {
    try {
      await handOffCandidate(env, node, now, config, result);
    } catch (error) {
      // One candidate must not starve the rest of the bounded page.
      result.errors++;
      log.error('node_cleanup.empty_node_warm_handoff_candidate_failed', {
        nodeId: node.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
