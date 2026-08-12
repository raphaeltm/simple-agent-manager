/**
 * Node-destroying phases of the cleanup sweep.
 *
 * Every candidate query here carries BOTH rule-51 gates:
 *   node_role  = 'workspace'      — deployment nodes back live user applications
 *   node_class != 'user-owned'    — SAM never destroys a machine it does not own
 *
 * The role gate is not cosmetic. Production deployment nodes legitimately hold ZERO
 * workspaces indefinitely (they run docker compose apps, not agent workspaces), so
 * any "running with no workspaces" heuristic matches them perfectly. Three such nodes
 * backing active production deployments were live when this sweep was written.
 */
import { eq } from 'drizzle-orm';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { stopNodeResources } from '../../services/nodes';
import { persistError } from '../../services/observability';
import {
  claimWorkspaceForCleanup,
  completeWorkspaceCleanupClaim,
  restoreWorkspaceCleanupClaim,
} from '../../services/workspace-cleanup-authorization';
import {
  type CleanupConfig,
  type CleanupDb,
  destroyNodeForCleanup,
  LAST_WORKSPACE_ACTIVITY_SQL,
  markNodeCleanupBackoff,
  NODE_DESTRUCTIVE_ACTIVE_WORKSPACE_STATUSES_SQL,
  type NodeCleanupResult,
} from './shared';

/**
 * Phase 0 — cf-container nodes left behind after their task reached a terminal state.
 */
export async function sweepTerminalCfContainers(
  env: Env,
  now: Date,
  config: CleanupConfig,
  result: NodeCleanupResult
): Promise<void> {
  const candidates = await env.DATABASE.prepare(
    `SELECT DISTINCT n.id as node_id, n.user_id, w.id as workspace_id, w.project_id, t.id as task_id, t.status as task_status
     FROM nodes n
     INNER JOIN workspaces w ON w.node_id = n.id
     INNER JOIN tasks t ON t.workspace_id = w.id
     WHERE n.runtime = 'cf-container'
       AND n.status NOT IN ('deleted', 'stopped')
       AND n.node_role = 'workspace'
       AND n.node_class != 'user-owned'
       AND (n.cleanup_backoff_until IS NULL OR n.cleanup_backoff_until <= ?)
       AND w.status IN ('running', 'creating', 'recovery', 'sleeping', 'stopped')
       AND t.project_id IS w.project_id
       AND (
         t.chat_session_id IS NULL
         OR (
           t.task_mode = 'conversation'
           AND w.chat_session_id = t.chat_session_id
           AND w.user_id = t.user_id
         )
         OR (
           t.task_mode != 'conversation'
           AND (w.chat_session_id IS NULL OR w.chat_session_id = t.chat_session_id)
         )
       )
       AND t.status IN ('completed', 'failed', 'cancelled')
       AND NOT EXISTS (
         SELECT 1 FROM tasks active
         WHERE active.workspace_id = w.id
           AND active.status IN ('queued', 'delegated', 'in_progress')
       )
       AND t.updated_at < ?
     ORDER BY t.updated_at ASC
     LIMIT ?`
  )
    .bind(
      now.toISOString(),
      new Date(now.getTime() - config.orphanGracePeriodMs).toISOString(),
      config.cfContainerSweepLimit
    )
    .all<{
      node_id: string;
      user_id: string;
      workspace_id: string;
      project_id: string | null;
      task_id: string;
      task_status: string;
    }>();

  for (const candidate of candidates.results) {
    let claim: Awaited<ReturnType<typeof claimWorkspaceForCleanup>> = null;
    try {
      log.warn('node_cleanup.cf_container_terminal_task_destroying', {
        nodeId: candidate.node_id,
        workspaceId: candidate.workspace_id,
        taskId: candidate.task_id,
        taskStatus: candidate.task_status,
      });

      claim = await claimWorkspaceForCleanup(env, {
        workspaceId: candidate.workspace_id,
        nodeId: candidate.node_id,
        userId: candidate.user_id,
        projectId: candidate.project_id,
        allowedStatuses: ['running', 'creating', 'pending', 'recovery', 'sleeping', 'stopped'],
        taskId: candidate.task_id,
        source: 'node_cleanup.cf_container_terminal_task',
      });
      if (!claim) {
        continue;
      }

      const sibling = await env.DATABASE.prepare(
        `SELECT id FROM workspaces
         WHERE node_id = ? AND id != ? AND status != 'deleted'
         LIMIT 1`
      )
        .bind(candidate.node_id, candidate.workspace_id)
        .first<{ id: string }>();
      if (sibling) {
        await restoreWorkspaceCleanupClaim(env, claim);
        log.warn('node_cleanup.cf_container_sibling_workspace_rejected', {
          nodeId: candidate.node_id,
          workspaceId: candidate.workspace_id,
          siblingWorkspaceId: sibling.id,
          taskId: candidate.task_id,
          action: 'skipped',
        });
        continue;
      }

      await stopNodeResources(candidate.node_id, candidate.user_id, env, {
        exclusiveWorkspaceId: candidate.workspace_id,
      });
      await completeWorkspaceCleanupClaim(env, claim, 'deleted');

      await persistError(
        env.OBSERVABILITY_DATABASE,
        {
          source: 'api',
          level: 'warn',
          message: 'Destroyed cf-container node left behind after terminal task',
          context: {
            recoveryType: 'cf_container_terminal_task_cleanup',
            nodeId: candidate.node_id,
            workspaceId: candidate.workspace_id,
            taskId: candidate.task_id,
            taskStatus: candidate.task_status,
            gracePeriodMs: config.orphanGracePeriodMs,
          },
          userId: candidate.user_id,
          nodeId: candidate.node_id,
          workspaceId: candidate.workspace_id,
        },
        env
      );

      result.cfContainersDestroyed++;
    } catch (err) {
      if (claim) {
        await restoreWorkspaceCleanupClaim(
          env,
          claim,
          err instanceof Error ? err.message : String(err)
        );
      }
      await markNodeCleanupBackoff(
        env,
        candidate.node_id,
        new Date(now.getTime() + config.failureBackoffMs).toISOString()
      );
      log.error('node_cleanup.cf_container_terminal_task_destroy_failed', {
        nodeId: candidate.node_id,
        workspaceId: candidate.workspace_id,
        taskId: candidate.task_id,
        error: err instanceof Error ? err.message : String(err),
      });
      result.errors++;
    }
  }
}

/**
 * Phase 1 — warm nodes whose warm window has expired.
 */
export async function sweepStaleWarmNodes(
  db: CleanupDb,
  env: Env,
  now: Date,
  config: CleanupConfig,
  result: NodeCleanupResult
): Promise<void> {
  const staleThreshold = new Date(now.getTime() - config.gracePeriodMs).toISOString();
  const candidates = await env.DATABASE.prepare(
    `SELECT n.id, n.user_id, n.warm_since,
            COUNT(CASE WHEN w.status IN (${NODE_DESTRUCTIVE_ACTIVE_WORKSPACE_STATUSES_SQL}) THEN 1 END) as active_ws_count
     FROM nodes n
     LEFT JOIN workspaces w ON w.node_id = n.id
     WHERE n.warm_since IS NOT NULL
       AND n.warm_since < ?
       AND n.status = 'running'
       AND n.node_role = 'workspace'
       AND n.node_class != 'user-owned'
       AND (n.runtime IS NULL OR n.runtime != 'cf-container')
       AND (n.cleanup_backoff_until IS NULL OR n.cleanup_backoff_until <= ?)
     GROUP BY n.id, n.user_id, n.warm_since
     ORDER BY n.warm_since ASC
     LIMIT ?`
  )
    .bind(staleThreshold, now.toISOString(), config.nodeSweepLimit)
    .all<{
      id: string;
      user_id: string;
      warm_since: string;
      active_ws_count: number;
    }>();

  for (const node of candidates.results) {
    if (node.active_ws_count > 0) {
      // Has active workspaces — it should not be warm at all. Clearing warm_since
      // is also this candidate's escape path out of the candidate set (rule 47).
      await db
        .update(schema.nodes)
        .set({ warmSince: null, updatedAt: now.toISOString() })
        .where(eq(schema.nodes.id, node.id));
      continue;
    }

    const destroyed = await destroyNodeForCleanup(db, env, now.toISOString(), node, {
      logEvent: 'node_cleanup.destroying_stale_warm',
      failureLogEvent: 'node_cleanup.stale_warm_destroy_failed',
      successMessage: 'Destroyed stale warm node (Layer 2 defense)',
      failureMessagePrefix: 'Failed to destroy stale warm node',
      recoveryType: 'stale_warm_node_cleanup',
      failureRecoveryType: 'stale_warm_node_cleanup_failure',
      failureBackoffMs: config.failureBackoffMs,
      level: 'info',
      context: { warmSince: node.warm_since, gracePeriodMs: config.gracePeriodMs },
    });

    if (destroyed) {
      result.staleDestroyed++;
    } else {
      result.errors++;
    }
  }
}

/**
 * Phase 2 — auto-provisioned nodes past max lifetime.
 *
 * Two ceilings, both keyed on workspace ACTIVITY rather than nominal status:
 *
 *  - `maxLifetimeMs` (4h): node is older than the limit AND holds no active workspaces.
 *
 * Nodes with active or resumable workspaces are always skipped. Workspace-level
 * cleanup handles stale rows first; node-level deletion must never cascade a
 * resumable workspace to deleted.
 */
export async function sweepMaxLifetimeNodes(
  db: CleanupDb,
  env: Env,
  now: Date,
  config: CleanupConfig,
  result: NodeCleanupResult
): Promise<void> {
  const lifetimeThreshold = new Date(now.getTime() - config.maxLifetimeMs).toISOString();

  const candidates = await env.DATABASE.prepare(
    `SELECT n.id, n.user_id, n.status, n.created_at,
            COUNT(DISTINCT CASE WHEN w.status IN (${NODE_DESTRUCTIVE_ACTIVE_WORKSPACE_STATUSES_SQL}) THEN w.id END) as active_ws_count,
            ${LAST_WORKSPACE_ACTIVITY_SQL} as last_activity
     FROM nodes n
     INNER JOIN tasks t ON t.auto_provisioned_node_id = n.id
     LEFT JOIN workspaces w ON w.node_id = n.id
     WHERE t.auto_provisioned_node_id IS NOT NULL
       AND n.status NOT IN ('stopped', 'deleted')
       AND n.node_role = 'workspace'
       AND n.node_class != 'user-owned'
       AND (n.runtime IS NULL OR n.runtime != 'cf-container')
       AND (n.cleanup_backoff_until IS NULL OR n.cleanup_backoff_until <= ?)
       AND n.created_at < ?
     GROUP BY n.id, n.user_id, n.status, n.created_at
     ORDER BY n.created_at ASC
     LIMIT ?`
  )
    .bind(now.toISOString(), lifetimeThreshold, config.nodeSweepLimit)
    .all<{
      id: string;
      user_id: string;
      status: string;
      created_at: string;
      active_ws_count: number;
      last_activity: string;
    }>();

  for (const node of candidates.results) {
    if (node.active_ws_count > 0) {
      // Genuinely busy or resumable — workspace-level cleanup handles stale rows
      // at a finer granularity before any node-level deletion.
      log.info('node_cleanup.max_lifetime_skipped_active_workspaces', {
        nodeId: node.id,
        userId: node.user_id,
        activeWorkspaces: node.active_ws_count,
        createdAt: node.created_at,
        lastWorkspaceActivity: node.last_activity,
        maxLifetimeMs: config.maxLifetimeMs,
      });

      result.lifetimeSkipped++;
      continue;
    }

    const destroyed = await destroyNodeForCleanup(db, env, now.toISOString(), node, {
      logEvent: 'node_cleanup.destroying_max_lifetime',
      failureLogEvent: 'node_cleanup.max_lifetime_destroy_failed',
      successMessage: 'Destroyed auto-provisioned node exceeding max lifetime (no active workspaces)',
      failureMessagePrefix: 'Failed to destroy max-lifetime node',
      recoveryType: 'max_lifetime_node_cleanup',
      failureRecoveryType: 'max_lifetime_node_cleanup_failure',
      failureBackoffMs: config.failureBackoffMs,
      context: {
        createdAt: node.created_at,
        lastWorkspaceActivity: node.last_activity,
        staleActiveWorkspaces: 0,
        maxLifetimeMs: config.maxLifetimeMs,
      },
    });

    if (destroyed) {
      result.lifetimeDestroyed++;
    } else {
      result.errors++;
    }
  }
}

/**
 * Phase 3 — nodes the NodeLifecycle DO alarm stopped but never destroyed.
 *
 * The DO cannot destroy cloud infrastructure (credentials are encrypted in D1 and
 * need worker context), so it hands off by writing `status='stopped'`.
 */
export async function sweepStoppedHandoffNodes(
  db: CleanupDb,
  env: Env,
  now: Date,
  config: CleanupConfig,
  result: NodeCleanupResult
): Promise<void> {
  const threshold = new Date(now.getTime() - config.orphanGracePeriodMs).toISOString();
  const candidates = await env.DATABASE.prepare(
    `SELECT n.id, n.user_id, n.status, n.created_at, n.updated_at,
            COUNT(DISTINCT CASE WHEN w.status IN (${NODE_DESTRUCTIVE_ACTIVE_WORKSPACE_STATUSES_SQL}) THEN w.id END) as active_ws_count
     FROM nodes n
     INNER JOIN tasks t ON t.auto_provisioned_node_id = n.id
     LEFT JOIN workspaces w ON w.node_id = n.id
     WHERE n.status = 'stopped'
       AND n.node_role = 'workspace'
       AND n.node_class != 'user-owned'
       AND (n.runtime IS NULL OR n.runtime != 'cf-container')
       AND (n.cleanup_backoff_until IS NULL OR n.cleanup_backoff_until <= ?)
       AND n.created_at < ?
     GROUP BY n.id, n.user_id, n.status, n.created_at, n.updated_at
     ORDER BY n.created_at ASC
     LIMIT ?`
  )
    .bind(now.toISOString(), threshold, config.nodeSweepLimit)
    .all<{
      id: string;
      user_id: string;
      status: string;
      created_at: string;
      updated_at: string;
      active_ws_count: number;
    }>();

  for (const node of candidates.results) {
    if (node.active_ws_count > 0) {
      log.warn('node_cleanup.stopped_handoff_skipped_active_workspaces', {
        nodeId: node.id,
        userId: node.user_id,
        activeWorkspaces: node.active_ws_count,
        updatedAt: node.updated_at,
      });
      result.lifetimeSkipped++;
      continue;
    }

    const destroyed = await destroyNodeForCleanup(db, env, now.toISOString(), node, {
      logEvent: 'node_cleanup.destroying_stopped_handoff',
      failureLogEvent: 'node_cleanup.stopped_handoff_destroy_failed',
      successMessage: 'Destroyed stopped auto-provisioned node left by NodeLifecycle alarm',
      failureMessagePrefix: 'Failed to destroy stopped handoff node',
      recoveryType: 'stopped_node_handoff_cleanup',
      failureRecoveryType: 'stopped_node_handoff_cleanup_failure',
      failureBackoffMs: config.failureBackoffMs,
      context: {
        createdAt: node.created_at,
        updatedAt: node.updated_at,
        gracePeriodMs: config.orphanGracePeriodMs,
      },
    });

    if (destroyed) {
      result.lifetimeDestroyed++;
    } else {
      result.errors++;
    }
  }
}

/**
 * Phase 4 — incompatible managed VM nodes after a vm-agent rollout.
 *
 * Busy legacy nodes are drained by exclusion from all placement paths, but are
 * not destroyed here. Once they hold no active workspace, this bounded phase
 * retires them. Cloudflare Instant/cf-container and user-owned nodes are
 * intentionally excluded.
 */
export async function sweepIncompatibleVmAgentNodes(
  db: CleanupDb,
  env: Env,
  now: Date,
  config: CleanupConfig,
  result: NodeCleanupResult
): Promise<void> {
  const requiredVersion = env.VM_AGENT_REQUIRED_VERSION?.trim();
  if (!requiredVersion) {
    return;
  }

  const unversionedGraceThreshold = new Date(
    now.getTime() - config.orphanIdleTimeoutMs
  ).toISOString();

  const candidates = await env.DATABASE.prepare(
    `SELECT n.id, n.user_id, n.status, n.created_at, n.agent_version,
            COUNT(DISTINCT CASE WHEN w.status IN (${NODE_DESTRUCTIVE_ACTIVE_WORKSPACE_STATUSES_SQL}) THEN w.id END) as active_ws_count,
            EXISTS (
              SELECT 1 FROM tasks active
              WHERE active.auto_provisioned_node_id = n.id
                AND active.status IN ('queued', 'delegated', 'in_progress')
            ) as active_task_claim
     FROM nodes n
     LEFT JOIN workspaces w ON w.node_id = n.id
     WHERE n.status = 'running'
       AND n.node_role = 'workspace'
       AND n.node_class != 'user-owned'
       AND (n.runtime IS NULL OR n.runtime != 'cf-container')
       AND (n.cleanup_backoff_until IS NULL OR n.cleanup_backoff_until <= ?)
       AND (n.runtime IS NULL OR n.runtime = 'vm')
       AND (n.agent_version IS NULL OR n.agent_version != ?)
     GROUP BY n.id, n.user_id, n.status, n.created_at, n.agent_version
     ORDER BY n.created_at ASC
     LIMIT ?`
  )
    .bind(now.toISOString(), requiredVersion, config.nodeSweepLimit)
    .all<{
      id: string;
      user_id: string;
      status: string;
      created_at: string;
      agent_version: string | null;
      active_ws_count: number;
      active_task_claim: number;
    }>();

  for (const node of candidates.results) {
    if (node.active_task_claim > 0) {
      log.info('node_cleanup.incompatible_vm_agent_skipped_active_task', {
        nodeId: node.id,
        userId: node.user_id,
        agentVersion: node.agent_version,
        requiredVersion,
      });
      result.incompatibleSkipped++;
      continue;
    }

    // agent_version is absent during the normal pre-heartbeat boot window. Give
    // unclaimed/manual provisioning the same configurable idle grace used by the
    // orphan reaper; active TaskRunner provisioning is protected above regardless
    // of age until its bounded provisioning/readiness lifecycle terminalizes.
    if (node.agent_version === null && node.created_at >= unversionedGraceThreshold) {
      log.info('node_cleanup.incompatible_vm_agent_skipped_pre_heartbeat', {
        nodeId: node.id,
        userId: node.user_id,
        createdAt: node.created_at,
        requiredVersion,
        gracePeriodMs: config.orphanIdleTimeoutMs,
      });
      result.incompatibleSkipped++;
      continue;
    }

    if (node.active_ws_count > 0) {
      log.info('node_cleanup.incompatible_vm_agent_skipped_active_workspaces', {
        nodeId: node.id,
        userId: node.user_id,
        agentVersion: node.agent_version,
        requiredVersion,
        activeWorkspaces: node.active_ws_count,
      });
      result.incompatibleSkipped++;
      continue;
    }

    const destroyed = await destroyNodeForCleanup(db, env, now.toISOString(), node, {
      logEvent: 'node_cleanup.destroying_incompatible_vm_agent',
      failureLogEvent: 'node_cleanup.incompatible_vm_agent_destroy_failed',
      successMessage: 'Destroyed idle node running incompatible VM agent build',
      failureMessagePrefix: 'Failed to destroy incompatible VM agent node',
      recoveryType: 'incompatible_vm_agent_cleanup',
      failureRecoveryType: 'incompatible_vm_agent_cleanup_failure',
      failureBackoffMs: config.failureBackoffMs,
      level: 'warn',
      context: {
        createdAt: node.created_at,
        agentVersion: node.agent_version,
        requiredVersion,
        unversionedGracePeriodMs: config.orphanIdleTimeoutMs,
      },
    });

    if (destroyed) {
      result.incompatibleDestroyed++;
    } else {
      result.errors++;
    }
  }
}

/**
 * Phase 5 — idle orphan nodes: running, not warm, holding no active workspaces.
 *
 * This phase previously only WROTE AN OBSERVABILITY ROW and incremented a counter;
 * it never destroyed anything, so a node in this state lived forever. It also could
 * not fire at all: its predicate was `nodes.updated_at < now - grace`, and heartbeats
 * bump `updated_at` on every beat, so a healthy node never aged into the window.
 * Production confirmed both defects — recoveryType 'orphaned_node' had zero events
 * across the sweep's entire lifetime.
 *
 * It now reaps, keyed on last workspace ACTIVITY. The `created_at` guard keeps a
 * freshly provisioned node that has not yet received its first workspace safe.
 */
export async function sweepIdleOrphanNodes(
  db: CleanupDb,
  env: Env,
  now: Date,
  config: CleanupConfig,
  result: NodeCleanupResult
): Promise<void> {
  const idleThreshold = new Date(now.getTime() - config.orphanIdleTimeoutMs).toISOString();

  const candidates = await env.DATABASE.prepare(
    `SELECT n.id, n.user_id, n.status, n.created_at, n.warm_since,
            ${LAST_WORKSPACE_ACTIVITY_SQL} as last_activity
     FROM nodes n
     LEFT JOIN workspaces w ON w.node_id = n.id
     WHERE n.status = 'running'
       AND n.node_role = 'workspace'
       AND n.node_class != 'user-owned'
       AND (n.runtime IS NULL OR n.runtime != 'cf-container')
       AND (n.cleanup_backoff_until IS NULL OR n.cleanup_backoff_until <= ?)
       AND n.warm_since IS NULL
       AND n.created_at < ?
       AND NOT EXISTS (
         SELECT 1 FROM workspaces aw
         WHERE aw.node_id = n.id
           AND aw.status IN (${NODE_DESTRUCTIVE_ACTIVE_WORKSPACE_STATUSES_SQL})
       )
     GROUP BY n.id, n.user_id, n.status, n.created_at, n.warm_since
     HAVING ${LAST_WORKSPACE_ACTIVITY_SQL} < ?
     ORDER BY last_activity ASC
     LIMIT ?`
  )
    .bind(now.toISOString(), idleThreshold, idleThreshold, config.nodeSweepLimit)
    .all<{
      id: string;
      user_id: string;
      status: string;
      created_at: string;
      warm_since: string | null;
      last_activity: string;
    }>();

  for (const node of candidates.results) {
    const destroyed = await destroyNodeForCleanup(db, env, now.toISOString(), node, {
      logEvent: 'node_cleanup.destroying_idle_orphan',
      failureLogEvent: 'node_cleanup.idle_orphan_destroy_failed',
      successMessage: 'Destroyed idle orphan node (running, not warm, no active workspaces)',
      failureMessagePrefix: 'Failed to destroy idle orphan node',
      recoveryType: 'idle_orphan_node_cleanup',
      failureRecoveryType: 'idle_orphan_node_cleanup_failure',
      failureBackoffMs: config.failureBackoffMs,
      context: {
        createdAt: node.created_at,
        lastWorkspaceActivity: node.last_activity,
        idleTimeoutMs: config.orphanIdleTimeoutMs,
      },
    });

    if (destroyed) {
      result.orphanedNodesDestroyed++;
    } else {
      result.orphanedNodesSkipped++;
      result.errors++;
    }
  }
}
