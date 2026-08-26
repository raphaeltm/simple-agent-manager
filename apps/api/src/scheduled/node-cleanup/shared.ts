/**
 * Shared types, config resolution, and destroy helpers for the node cleanup sweep.
 *
 * Rule 47 (control-loop I/O budget) applies to every phase in this directory:
 * - every candidate query is bounded by a configurable LIMIT
 * - VM-agent calls use the BACKGROUND timeout, never the interactive one
 * - every selected candidate has an escape path out of the candidate set
 *
 * Rule 51 (server-side node-class gates) applies to every destroy/flag query:
 * - `node_class != 'user-owned'` — SAM never touches a machine it does not own
 * - `node_role = 'workspace'`   — deployment nodes host live user applications and
 *   legitimately hold zero workspaces forever; reaping them destroys running apps
 */
import {
  DEFAULT_MAX_AUTO_NODE_LIFETIME_MS,
  DEFAULT_NODE_ABSOLUTE_MAX_LIFETIME_MS,
  DEFAULT_NODE_CLEANUP_FAILURE_BACKOFF_MS,
  DEFAULT_NODE_CLEANUP_SWEEP_LIMIT,
  DEFAULT_NODE_ORPHAN_IDLE_TIMEOUT_MS,
  DEFAULT_NODE_WARM_GRACE_PERIOD_MS,
  DEFAULT_NODE_WARM_TIMEOUT_MS,
  DEFAULT_ORPHANED_WORKSPACE_GRACE_PERIOD_MS,
  DEFAULT_WORKSPACE_CLEANUP_SWEEP_LIMIT,
  DEFAULT_WORKSPACE_STOPPED_TTL_MS,
} from '@simple-agent-manager/shared';
import { eq } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { getNodeAgentBackgroundRequestTimeoutMs } from '../../services/node-agent';
import { deleteNodeResourcesStrict } from '../../services/nodes';
import { persistError } from '../../services/observability';
import { finalizeWorkspaceLifecycleClosure } from '../../services/workspace-lifecycle-finalizer';

export const DEFAULT_CF_CONTAINER_TERMINAL_TASK_SWEEP_LIMIT = 25;

export type CleanupDb = ReturnType<typeof drizzle<typeof schema>>;

export interface NodeCleanupResult {
  staleDestroyed: number;
  lifetimeDestroyed: number;
  lifetimeSkipped: number;
  orphanedWorkspacesFlagged: number;
  /**
   * Orphaned running nodes actually destroyed. Replaces the old
   * `orphanedNodesFlagged`, which only ever counted observability rows — the
   * phase detected orphans and then left them running forever.
   */
  orphanedNodesDestroyed: number;
  orphanedNodesSkipped: number;
  stoppedWorkspacesDeleted: number;
  cfContainersDestroyed: number;
  incompatibleDestroyed: number;
  incompatibleSkipped: number;
  errors: number;
}

export function emptyResult(): NodeCleanupResult {
  return {
    staleDestroyed: 0,
    lifetimeDestroyed: 0,
    lifetimeSkipped: 0,
    orphanedWorkspacesFlagged: 0,
    orphanedNodesDestroyed: 0,
    orphanedNodesSkipped: 0,
    stoppedWorkspacesDeleted: 0,
    cfContainersDestroyed: 0,
    incompatibleDestroyed: 0,
    incompatibleSkipped: 0,
    errors: 0,
  };
}

export function parseMs(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export interface CleanupConfig {
  gracePeriodMs: number;
  maxLifetimeMs: number;
  absoluteMaxLifetimeMs: number;
  orphanGracePeriodMs: number;
  orphanIdleTimeoutMs: number;
  stoppedTtlMs: number;
  nodeSweepLimit: number;
  workspaceSweepLimit: number;
  cfContainerSweepLimit: number;
  failureBackoffMs: number;
  /** VM-agent timeout for background calls — see rule 47. */
  agentTimeoutMs: number;
}

/**
 * Warn when overrides invert the intended threshold ordering.
 *
 * The shipped defaults are monotonic (warm 30m < warm-grace 35m < orphan-idle 45m <
 * max-lifetime 4h < absolute-ceiling 24h), but nothing stops an operator from
 * overriding one into a nonsensical relationship. That would not throw — it would
 * silently make a phase unreachable or trivially satisfiable, reproducing exactly the
 * "guard that never fires looks identical to a guard with nothing to do" failure this
 * whole change exists to fix. See `.claude/rules/53-…`.
 *
 * Deliberately a warning, not a hard failure: a misordered threshold degrades reaping
 * precision, and refusing to sweep at all would be strictly worse than sweeping with
 * odd timings.
 */
function warnOnInvertedThresholds(config: CleanupConfig, env: Env): void {
  const warmTimeoutMs = parseMs(env.NODE_WARM_TIMEOUT_MS, DEFAULT_NODE_WARM_TIMEOUT_MS);
  const problems: string[] = [];

  if (config.orphanIdleTimeoutMs < warmTimeoutMs) {
    problems.push(
      `NODE_ORPHAN_IDLE_TIMEOUT_MS (${config.orphanIdleTimeoutMs}) is below NODE_WARM_TIMEOUT_MS (${warmTimeoutMs}); idle reaping may destroy nodes the warm pool intends to reuse`
    );
  }
  if (config.absoluteMaxLifetimeMs < config.maxLifetimeMs) {
    problems.push(
      `NODE_ABSOLUTE_MAX_LIFETIME_MS (${config.absoluteMaxLifetimeMs}) is below MAX_AUTO_NODE_LIFETIME_MS (${config.maxLifetimeMs}); the absolute ceiling is satisfied for every max-lifetime candidate`
    );
  }
  if (config.gracePeriodMs < warmTimeoutMs) {
    problems.push(
      `NODE_WARM_GRACE_PERIOD_MS (${config.gracePeriodMs}) is below NODE_WARM_TIMEOUT_MS (${warmTimeoutMs}); warm nodes may be swept before their warm window expires`
    );
  }

  if (problems.length > 0) {
    log.warn('node_cleanup.threshold_ordering_inverted', { problems });
  }
}

export function resolveCleanupConfig(env: Env): CleanupConfig {
  const config = buildCleanupConfig(env);
  warnOnInvertedThresholds(config, env);
  return config;
}

function buildCleanupConfig(env: Env): CleanupConfig {
  return {
    gracePeriodMs: parseMs(env.NODE_WARM_GRACE_PERIOD_MS, DEFAULT_NODE_WARM_GRACE_PERIOD_MS),
    maxLifetimeMs: parseMs(env.MAX_AUTO_NODE_LIFETIME_MS, DEFAULT_MAX_AUTO_NODE_LIFETIME_MS),
    absoluteMaxLifetimeMs: parseMs(
      env.NODE_ABSOLUTE_MAX_LIFETIME_MS,
      DEFAULT_NODE_ABSOLUTE_MAX_LIFETIME_MS
    ),
    orphanGracePeriodMs: parseMs(
      env.ORPHANED_WORKSPACE_GRACE_PERIOD_MS,
      DEFAULT_ORPHANED_WORKSPACE_GRACE_PERIOD_MS
    ),
    orphanIdleTimeoutMs: parseMs(
      env.NODE_ORPHAN_IDLE_TIMEOUT_MS,
      DEFAULT_NODE_ORPHAN_IDLE_TIMEOUT_MS
    ),
    stoppedTtlMs: parseMs(env.WORKSPACE_STOPPED_TTL_MS, DEFAULT_WORKSPACE_STOPPED_TTL_MS),
    nodeSweepLimit: parsePositiveInt(
      env.NODE_CLEANUP_SWEEP_LIMIT,
      DEFAULT_NODE_CLEANUP_SWEEP_LIMIT
    ),
    workspaceSweepLimit: parsePositiveInt(
      env.WORKSPACE_CLEANUP_SWEEP_LIMIT,
      DEFAULT_WORKSPACE_CLEANUP_SWEEP_LIMIT
    ),
    cfContainerSweepLimit: parsePositiveInt(
      env.CF_CONTAINER_TERMINAL_TASK_SWEEP_LIMIT,
      DEFAULT_CF_CONTAINER_TERMINAL_TASK_SWEEP_LIMIT
    ),
    failureBackoffMs: parseMs(
      env.NODE_CLEANUP_FAILURE_BACKOFF_MS,
      DEFAULT_NODE_CLEANUP_FAILURE_BACKOFF_MS
    ),
    agentTimeoutMs: getNodeAgentBackgroundRequestTimeoutMs(env),
  };
}

export type CleanupContext = Record<string, string | number | null | undefined>;
export type NodeCleanupDestroyResult = 'destroyed' | 'skipped' | 'failed';
type CleanupNode = { id: string; user_id: string; status: string };

interface DestroyNodeForCleanupOptions {
  logEvent: string;
  failureLogEvent: string;
  successMessage: string;
  failureMessagePrefix: string;
  recoveryType: string;
  failureRecoveryType: string;
  level?: 'info' | 'warn';
  failureBackoffMs: number;
  allowActiveWorkspaces?: boolean;
  context: CleanupContext;
}

export async function claimNodeForCleanup(
  env: Env,
  node: CleanupNode,
  nowIso: string,
  options: { allowActiveWorkspaces?: boolean } = {}
): Promise<boolean> {
  const activeWorkspaceGuard = options.allowActiveWorkspaces
    ? ''
    : `AND NOT EXISTS (
         SELECT 1
         FROM workspaces active_workspace
         WHERE active_workspace.node_id = nodes.id
           AND active_workspace.status IN ('running', 'creating', 'recovery')
       )`;
  const result = await env.DATABASE.prepare(
    `UPDATE nodes
     SET status = 'destroying', updated_at = ?
     WHERE id = ?
       AND user_id = ?
       AND status = ?
       AND node_role = 'workspace'
       AND node_class != 'user-owned'
       ${activeWorkspaceGuard}
       AND NOT EXISTS (
         SELECT 1
         FROM tasks active_task
         WHERE active_task.auto_provisioned_node_id = nodes.id
           AND active_task.status IN ('queued', 'delegated', 'in_progress')
       )`
  )
    .bind(nowIso, node.id, node.user_id, node.status)
    .run();

  return (result.meta.changes ?? 0) > 0;
}

async function releaseNodeCleanupClaim(
  env: Env,
  node: CleanupNode,
  nowIso: string,
  backoffUntil: string
): Promise<void> {
  await env.DATABASE.prepare(
    `UPDATE nodes
     SET status = ?, cleanup_backoff_until = ?, updated_at = ?
     WHERE id = ?
       AND user_id = ?
       AND status = 'destroying'`
  )
    .bind(node.status, backoffUntil, nowIso, node.id, node.user_id)
    .run();
}

export async function markNodeCleanupBackoff(
  env: Env,
  nodeId: string,
  backoffUntil: string
): Promise<void> {
  try {
    await env.DATABASE.prepare(
      'UPDATE nodes SET cleanup_backoff_until = ?, updated_at = ? WHERE id = ?'
    )
      .bind(backoffUntil, new Date().toISOString(), nodeId)
      .run();
    log.warn('node_cleanup.candidate_backed_off', { nodeId, backoffUntil });
  } catch (err) {
    // Preserve the original cleanup error; a backoff-write failure is surfaced
    // separately and must not abort the remaining bounded candidate page.
    log.error('node_cleanup.candidate_backoff_failed', {
      nodeId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * SQL fragment computing a node's last workspace activity.
 *
 * MUST be used instead of `nodes.updated_at` for any idleness decision. Heartbeats
 * write `updated_at` on every beat (verified in production: `updated_at` is
 * byte-identical to `last_heartbeat_at` on every running node), so `updated_at`
 * measures liveness. A predicate like `updated_at < now - grace` is therefore
 * unsatisfiable for exactly the healthy-but-idle nodes it is meant to catch — the
 * bug that let orphan detection report zero hits for its entire lifetime.
 *
 * Falls back to `nodes.created_at` so a freshly provisioned node that has not yet
 * received its first workspace ages from creation rather than looking infinitely idle.
 *
 * Counts workspaces in ALL states, including `deleted`. Cleaning a workspace up is
 * itself recent activity on the node, so the clock legitimately restarts when the
 * stale-stopped-workspace phase deletes a row. That delays reaping by at most one
 * phase-6 window and cannot repeat, since a workspace is deleted only once.
 */
export const LAST_WORKSPACE_ACTIVITY_SQL = 'COALESCE(MAX(w.updated_at), n.created_at)';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function persistCleanupSuccess(
  env: Env,
  node: CleanupNode,
  options: DestroyNodeForCleanupOptions
): Promise<void> {
  try {
    await persistError(
      env.OBSERVABILITY_DATABASE,
      {
        source: 'api',
        level: options.level ?? 'warn',
        message: options.successMessage,
        context: {
          recoveryType: options.recoveryType,
          nodeId: node.id,
          ...options.context,
        },
        userId: node.user_id,
        nodeId: node.id,
      },
      env
    );
  } catch (error) {
    log.error('node_cleanup.success_observability_write_failed', {
      nodeId: node.id,
      error: errorMessage(error),
    });
  }
}

async function releaseCleanupClaimAfterFailure(
  env: Env,
  node: CleanupNode,
  nowIso: string,
  backoffUntil: string
): Promise<void> {
  try {
    await releaseNodeCleanupClaim(env, node, nowIso, backoffUntil);
    log.warn('node_cleanup.candidate_backed_off', { nodeId: node.id, backoffUntil });
  } catch (error) {
    log.error('node_cleanup.candidate_claim_release_failed', {
      nodeId: node.id,
      error: errorMessage(error),
    });
  }
}

async function persistCleanupFailure(
  env: Env,
  node: CleanupNode,
  options: DestroyNodeForCleanupOptions,
  error: unknown,
  backoffUntil: string
): Promise<void> {
  try {
    await persistError(
      env.OBSERVABILITY_DATABASE,
      {
        source: 'api',
        level: 'error',
        message: `${options.failureMessagePrefix}: ${errorMessage(error)}`,
        stack: error instanceof Error ? error.stack : undefined,
        context: {
          recoveryType: options.failureRecoveryType,
          nodeId: node.id,
          backoffUntil,
          ...options.context,
        },
        userId: node.user_id,
        nodeId: node.id,
      },
      env
    );
  } catch (persistErrorValue) {
    log.error('node_cleanup.failure_observability_write_failed', {
      nodeId: node.id,
      error: errorMessage(persistErrorValue),
    });
  }
}

async function handleCleanupFailure(
  env: Env,
  node: CleanupNode,
  nowIso: string,
  options: DestroyNodeForCleanupOptions,
  error: unknown
): Promise<void> {
  log.error(options.failureLogEvent, {
    nodeId: node.id,
    userId: node.user_id,
    error: errorMessage(error),
  });

  const backoffUntil = new Date(
    new Date(nowIso).getTime() + options.failureBackoffMs
  ).toISOString();
  await releaseCleanupClaimAfterFailure(env, node, nowIso, backoffUntil);
  await persistCleanupFailure(env, node, options, error, backoffUntil);
}

export async function destroyNodeForCleanup(
  db: CleanupDb,
  env: Env,
  nowIso: string,
  node: CleanupNode,
  options: DestroyNodeForCleanupOptions
): Promise<NodeCleanupDestroyResult> {
  const claimed = await claimNodeForCleanup(env, node, nowIso, {
    allowActiveWorkspaces: options.allowActiveWorkspaces,
  });
  if (!claimed) {
    log.info('node_cleanup.candidate_claim_lost', {
      nodeId: node.id,
      userId: node.user_id,
      expectedStatus: node.status,
      ...options.context,
    });
    return 'skipped';
  }

  try {
    log.info(options.logEvent, {
      nodeId: node.id,
      userId: node.user_id,
      ...options.context,
    });

    await deleteNodeResourcesStrict(node.id, node.user_id, env);

    await db
      .update(schema.nodes)
      .set({
        status: 'deleted',
        warmSince: null,
        healthStatus: 'stale',
        cleanupBackoffUntil: null,
        updatedAt: nowIso,
      })
      .where(eq(schema.nodes.id, node.id));

    await finalizeWorkspaceLifecycleClosure(env, {
      nodeId: node.id,
      userId: node.user_id,
      agentSessionStatus: 'completed',
      nowIso,
      reason: 'node_cleanup_destroy_node_for_cleanup',
    });

    await persistCleanupSuccess(env, node, options);

    return 'destroyed';
  } catch (error) {
    await handleCleanupFailure(env, node, nowIso, options, error);
    return 'failed';
  }
}
