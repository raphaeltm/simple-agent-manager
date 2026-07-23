/**
 * Cron handler: expire stale pending / ready trials and reap expired trial
 * infrastructure that is still owned by the anonymous sentinel account.
 *
 * The TrialCounter DO is NOT decremented: the slot was genuinely consumed for
 * the month. Cleanup is deliberately fail-closed around third-party VM APIs; D1
 * rows are only marked deleted after the matching external resource was removed
 * or the whole node was destroyed.
 */
import { TRIAL_ANONYMOUS_USER_ID } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { log, serializeError } from '../lib/logger';
import { deleteWorkspaceOnNode } from '../services/node-agent';
import { deleteNodeResourcesStrict } from '../services/nodes';
import { persistError } from '../services/observability';
import * as projectDataService from '../services/project-data';

const DEFAULT_TRIAL_EXPIRE_BATCH_SIZE = 1000;
const DEFAULT_TRIAL_CLEANUP_BATCH_SIZE = 25;
const DEFAULT_TRIAL_CLEANUP_DEADLINE_MS = 45_000;
const DEFAULT_TRIAL_NODE_DELETION_LOCK_STALE_MS = 10 * 60_000;
const MAX_TRIAL_EXPIRE_BATCH_SIZE = 5000;
const MAX_TRIAL_CLEANUP_BATCH_SIZE = 100;
const MAX_TRIAL_CLEANUP_DEADLINE_MS = 120_000;
const MAX_TRIAL_NODE_DELETION_LOCK_STALE_MS = 60 * 60_000;
const ACTIVE_WORKSPACE_STATUS_SQL = "'running', 'creating', 'recovery'";

export interface TrialExpireResult {
  expired: number;
  projectsLinked: number;
  workspacesDeleted: number;
  nodesDeleted: number;
  cleanupErrors: number;
}

interface ExpiredTrialProjectRow {
  trial_id: string;
  project_id: string;
}

interface TrialWorkspaceCleanupRow {
  id: string;
  node_id: string | null;
  user_id: string;
  project_id: string | null;
  chat_session_id: string | null;
  status: string;
}

interface NodeDeletionClaimRow {
  status: string;
  updated_at: string;
}

type NodeDeletionClaimResult = 'claimed' | 'concurrent' | 'terminal' | 'failed';

interface CountRow {
  active_count: number;
}

type CleanupContext = Record<string, string | number | null | undefined>;

function resolveAnonymousUserId(env: Env): string {
  return env.TRIAL_ANONYMOUS_USER_ID ?? TRIAL_ANONYMOUS_USER_ID;
}

function parsePositiveInt(
  value: string | undefined,
  fallback: number,
  options: { name: string; max: number }
): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  if (parsed > options.max) {
    log.warn('trial_expire.config_clamped', {
      name: options.name,
      requested: parsed,
      max: options.max,
    });
    return options.max;
  }
  return parsed;
}

function getRunChanges(result: unknown): number {
  const meta = (result as { meta?: { changes?: number } } | null | undefined)?.meta;
  return typeof meta?.changes === 'number' ? meta.changes : 0;
}

export async function runTrialExpireSweep(
  env: Env,
  now: number = Date.now()
): Promise<TrialExpireResult> {
  const expireBatchSize = parsePositiveInt(
    env.TRIAL_EXPIRE_BATCH_SIZE,
    DEFAULT_TRIAL_EXPIRE_BATCH_SIZE,
    { name: 'TRIAL_EXPIRE_BATCH_SIZE', max: MAX_TRIAL_EXPIRE_BATCH_SIZE }
  );
  const expireResult = await env.DATABASE.prepare(
    `UPDATE trials
     SET status = 'expired'
     WHERE id IN (
       SELECT id
       FROM trials
       WHERE status IN ('pending', 'ready')
         AND claimed_by_user_id IS NULL
         AND expires_at < ?
       LIMIT ?
     )`
  )
    .bind(now, expireBatchSize)
    .run();

  const cleanup = await cleanupExpiredTrialResources(env, now);

  return { expired: getRunChanges(expireResult), ...cleanup };
}

async function cleanupExpiredTrialResources(
  env: Env,
  now: number
): Promise<Omit<TrialExpireResult, 'expired'>> {
  const anonymousUserId = resolveAnonymousUserId(env);
  const nowIso = new Date(now).toISOString();
  const cleanupBatchSize = parsePositiveInt(
    env.TRIAL_CLEANUP_BATCH_SIZE,
    DEFAULT_TRIAL_CLEANUP_BATCH_SIZE,
    { name: 'TRIAL_CLEANUP_BATCH_SIZE', max: MAX_TRIAL_CLEANUP_BATCH_SIZE }
  );
  const deadlineMs = parsePositiveInt(
    env.TRIAL_CLEANUP_DEADLINE_MS,
    DEFAULT_TRIAL_CLEANUP_DEADLINE_MS,
    { name: 'TRIAL_CLEANUP_DEADLINE_MS', max: MAX_TRIAL_CLEANUP_DEADLINE_MS }
  );
  const deadlineAt = Date.now() + deadlineMs;
  const result = {
    projectsLinked: 0,
    workspacesDeleted: 0,
    nodesDeleted: 0,
    cleanupErrors: 0,
  };

  const expiredProjects = await env.DATABASE.prepare(
    `WITH resolved_trials AS (
       SELECT
         t.id AS trial_id,
         COALESCE(t.project_id, p.id) AS project_id
       FROM trials t
       LEFT JOIN projects p
         ON t.project_id IS NULL
        AND p.normalized_name = ('trial-' || lower(t.id))
        AND p.created_by = ?
       WHERE t.status IN ('expired', 'claimed')
         AND t.expires_at < ?
     )
     SELECT r.trial_id, r.project_id
     FROM resolved_trials r
     WHERE r.project_id IS NOT NULL
       AND EXISTS (
         SELECT 1
         FROM workspaces w
         WHERE w.project_id = r.project_id
           AND w.user_id = ?
           AND w.status != 'deleted'
       )
     LIMIT ?`
  )
    .bind(anonymousUserId, now, anonymousUserId, cleanupBatchSize)
    .all<ExpiredTrialProjectRow>();

  for (const row of expiredProjects.results) {
    if (Date.now() >= deadlineAt) {
      log.info('trial_expire.cleanup_deadline_reached', {
        cleanupBatchSize,
        deadlineMs,
      });
      break;
    }

    try {
      const linkResult = await env.DATABASE.prepare(
        `UPDATE trials
         SET project_id = ?
         WHERE id = ?
           AND project_id IS NULL
           AND status IN ('expired', 'claimed')
           AND expires_at < ?`
      )
        .bind(row.project_id, row.trial_id, now)
        .run();
      result.projectsLinked += getRunChanges(linkResult);

      const workspaces = await env.DATABASE.prepare(
        `SELECT id, node_id, user_id, project_id, chat_session_id, status
         FROM workspaces
         WHERE project_id = ?
           AND user_id = ?
           AND status != 'deleted'
           AND EXISTS (
             SELECT 1
             FROM trials t
             WHERE t.id = ?
               AND t.status IN ('expired', 'claimed')
               AND t.expires_at < ?
               AND (t.project_id = ? OR t.project_id IS NULL)
           )`
      )
        .bind(row.project_id, anonymousUserId, row.trial_id, now, row.project_id)
        .all<TrialWorkspaceCleanupRow>();

      const byNode = new Map<string, TrialWorkspaceCleanupRow[]>();
      for (const workspace of workspaces.results) {
        if (!workspace.node_id) {
          const deleted = await markWorkspaceDeletedIfTrialStillExpired(
            env,
            row,
            workspace,
            anonymousUserId,
            now,
            nowIso
          );
          result.workspacesDeleted += deleted;
          if (deleted > 0) {
            await cleanupWorkspaceReferences(env, row.trial_id, workspace, nowIso);
          }
          continue;
        }

        const nodeWorkspaces = byNode.get(workspace.node_id) ?? [];
        nodeWorkspaces.push(workspace);
        byNode.set(workspace.node_id, nodeWorkspaces);
      }

      for (const [nodeId, nodeWorkspaces] of byNode.entries()) {
        if (Date.now() >= deadlineAt) {
          log.info('trial_expire.cleanup_deadline_reached', {
            cleanupBatchSize,
            deadlineMs,
          });
          break;
        }

        const cleanupWorkspaceIds = nodeWorkspaces.map((workspace) => workspace.id);
        const activeOtherCount = await countActiveWorkspacesExcluding(
          env,
          nodeId,
          cleanupWorkspaceIds
        );

        if (activeOtherCount > 0) {
          const sharedResult = await cleanupWorkspacesOnLiveNode(
            env,
            row,
            nodeWorkspaces,
            anonymousUserId,
            now,
            nowIso,
            deadlineAt,
            cleanupBatchSize,
            deadlineMs
          );
          result.workspacesDeleted += sharedResult.workspacesDeleted;
          result.cleanupErrors += sharedResult.cleanupErrors;
          continue;
        }

        const nodeClaimResult = await claimNodeForDeletion(
          env,
          nodeId,
          anonymousUserId,
          cleanupWorkspaceIds,
          now,
          nowIso
        );

        if (nodeClaimResult !== 'claimed') {
          if (nodeClaimResult === 'concurrent' || nodeClaimResult === 'terminal') {
            log.info(
              nodeClaimResult === 'concurrent'
                ? 'trial_expire.node_deletion_already_claimed'
                : 'trial_expire.node_deletion_already_terminal',
              {
                trialId: row.trial_id,
                projectId: row.project_id,
                nodeId,
              }
            );
            continue;
          }
          const freshActiveOtherCount = await countActiveWorkspacesExcluding(
            env,
            nodeId,
            cleanupWorkspaceIds
          );
          if (freshActiveOtherCount > 0) {
            const sharedResult = await cleanupWorkspacesOnLiveNode(
              env,
              row,
              nodeWorkspaces,
              anonymousUserId,
              now,
              nowIso,
              deadlineAt,
              cleanupBatchSize,
              deadlineMs
            );
            result.workspacesDeleted += sharedResult.workspacesDeleted;
            result.cleanupErrors += sharedResult.cleanupErrors;
            continue;
          }

          result.cleanupErrors++;
          await recordCleanupError(
            env,
            anonymousUserId,
            'trial_expire.node_deletion_claim_failed',
            {
              trialId: row.trial_id,
              projectId: row.project_id,
              nodeId,
            },
            new Error('Node could not be claimed for strict trial cleanup')
          );
          continue;
        }

        try {
          await deleteNodeResourcesStrict(nodeId, anonymousUserId, env);
        } catch (err) {
          result.cleanupErrors++;
          await releaseNodeDeletionClaim(env, nodeId, anonymousUserId, nowIso, err);
          await recordCleanupError(
            env,
            anonymousUserId,
            'trial_expire.strict_node_delete_failed',
            {
              trialId: row.trial_id,
              projectId: row.project_id,
              nodeId,
            },
            err
          );
          continue;
        }

        for (const workspace of nodeWorkspaces) {
          const deleted = await markWorkspaceDeletedIfTrialStillExpired(
            env,
            row,
            workspace,
            anonymousUserId,
            now,
            nowIso
          );
          result.workspacesDeleted += deleted;
          if (deleted > 0) {
            await cleanupWorkspaceReferences(env, row.trial_id, workspace, nowIso);
          }
        }

        const activeAfterCleanup = await countActiveWorkspaces(env, nodeId);
        if (activeAfterCleanup === 0) {
          const nodeDeleteResult = await env.DATABASE.prepare(
            `UPDATE nodes
             SET status = 'deleted',
                 warm_since = NULL,
                 health_status = 'stale',
                 error_message = NULL,
                 updated_at = ?
             WHERE id = ?
               AND user_id = ?
               AND status = 'destroying'
               AND NOT EXISTS (
                 SELECT 1
                 FROM workspaces
                 WHERE node_id = ?
                   AND status IN (${ACTIVE_WORKSPACE_STATUS_SQL})
               )`
          )
            .bind(nowIso, nodeId, anonymousUserId, nodeId)
            .run();
          result.nodesDeleted += getRunChanges(nodeDeleteResult);
        }
      }
    } catch (err) {
      result.cleanupErrors++;
      await recordCleanupError(
        env,
        anonymousUserId,
        'trial_expire.resource_cleanup_failed',
        {
          trialId: row.trial_id,
          projectId: row.project_id,
        },
        err
      );
    }
  }

  return result;
}

async function cleanupWorkspacesOnLiveNode(
  env: Env,
  row: ExpiredTrialProjectRow,
  workspaces: TrialWorkspaceCleanupRow[],
  anonymousUserId: string,
  now: number,
  nowIso: string,
  deadlineAt: number,
  cleanupBatchSize: number,
  deadlineMs: number
): Promise<{ workspacesDeleted: number; cleanupErrors: number }> {
  const result = { workspacesDeleted: 0, cleanupErrors: 0 };

  for (const workspace of workspaces) {
    if (Date.now() >= deadlineAt) {
      log.info('trial_expire.cleanup_deadline_reached', {
        cleanupBatchSize,
        deadlineMs,
      });
      break;
    }

    if (!workspace.node_id) continue;

    try {
      await deleteWorkspaceOnNode(workspace.node_id, workspace.id, env, workspace.user_id);
    } catch (err) {
      result.cleanupErrors++;
      await recordCleanupError(
        env,
        anonymousUserId,
        'trial_expire.delete_workspace_on_node_failed',
        {
          trialId: row.trial_id,
          projectId: row.project_id,
          workspaceId: workspace.id,
          nodeId: workspace.node_id,
        },
        err
      );
      continue;
    }

    const deleted = await markWorkspaceDeletedIfTrialStillExpired(
      env,
      row,
      workspace,
      anonymousUserId,
      now,
      nowIso
    );
    result.workspacesDeleted += deleted;
    if (deleted > 0) {
      await cleanupWorkspaceReferences(env, row.trial_id, workspace, nowIso);
    }
  }

  return result;
}

async function markWorkspaceDeletedIfTrialStillExpired(
  env: Env,
  row: ExpiredTrialProjectRow,
  workspace: TrialWorkspaceCleanupRow,
  anonymousUserId: string,
  now: number,
  nowIso: string
): Promise<number> {
  const updateResult = await env.DATABASE.prepare(
    `UPDATE workspaces
     SET status = 'deleted',
         updated_at = ?
     WHERE id = ?
       AND user_id = ?
       AND project_id = ?
       AND status != 'deleted'
       AND EXISTS (
         SELECT 1
         FROM trials t
         WHERE t.id = ?
           AND t.status IN ('expired', 'claimed')
           AND t.expires_at < ?
           AND (t.project_id = ? OR t.project_id IS NULL)
       )`
  )
    .bind(nowIso, workspace.id, anonymousUserId, row.project_id, row.trial_id, now, row.project_id)
    .run();

  return getRunChanges(updateResult);
}

async function cleanupWorkspaceReferences(
  env: Env,
  trialId: string,
  workspace: TrialWorkspaceCleanupRow,
  nowIso: string
): Promise<void> {
  try {
    await env.DATABASE.prepare(
      `UPDATE agent_sessions
       SET status = 'completed',
           updated_at = ?
       WHERE workspace_id = ?
         AND status NOT IN ('completed', 'failed')`
    )
      .bind(nowIso, workspace.id)
      .run();
  } catch (err) {
    log.warn('trial_expire.agent_sessions_cleanup_failed', {
      trialId,
      workspaceId: workspace.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    await env.DATABASE.prepare(
      `UPDATE compute_usage
       SET ended_at = ?
       WHERE workspace_id = ?
         AND ended_at IS NULL`
    )
      .bind(nowIso, workspace.id)
      .run();
  } catch (err) {
    log.warn('trial_expire.compute_usage_cleanup_failed', {
      trialId,
      workspaceId: workspace.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (!workspace.project_id || !workspace.chat_session_id) {
    return;
  }

  await projectDataService
    .stopSession(env, workspace.project_id, workspace.chat_session_id)
    .catch((err) => {
      log.warn('trial_expire.stop_session_failed', {
        trialId,
        projectId: workspace.project_id,
        workspaceId: workspace.id,
        chatSessionId: workspace.chat_session_id,
        error: err instanceof Error ? err.message : String(err),
      });
    });

  await projectDataService
    .cleanupWorkspaceActivity(env, workspace.project_id, workspace.id)
    .catch((err) => {
      log.warn('trial_expire.cleanup_workspace_activity_failed', {
        trialId,
        projectId: workspace.project_id,
        workspaceId: workspace.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
}

async function countActiveWorkspaces(env: Env, nodeId: string): Promise<number> {
  const active = await env.DATABASE.prepare(
    `SELECT COUNT(*) as active_count
     FROM workspaces
     WHERE node_id = ?
       AND status IN (${ACTIVE_WORKSPACE_STATUS_SQL})`
  )
    .bind(nodeId)
    .first<CountRow>();

  return active?.active_count ?? 0;
}

async function countActiveWorkspacesExcluding(
  env: Env,
  nodeId: string,
  excludedWorkspaceIds: string[]
): Promise<number> {
  if (excludedWorkspaceIds.length === 0) {
    return countActiveWorkspaces(env, nodeId);
  }

  const placeholders = excludedWorkspaceIds.map(() => '?').join(', ');
  const active = await env.DATABASE.prepare(
    `SELECT COUNT(*) as active_count
     FROM workspaces
     WHERE node_id = ?
       AND status IN (${ACTIVE_WORKSPACE_STATUS_SQL})
       AND id NOT IN (${placeholders})`
  )
    .bind(nodeId, ...excludedWorkspaceIds)
    .first<CountRow>();

  return active?.active_count ?? 0;
}

async function claimNodeForDeletion(
  env: Env,
  nodeId: string,
  anonymousUserId: string,
  cleanupWorkspaceIds: string[],
  now: number,
  nowIso: string
): Promise<NodeDeletionClaimResult> {
  const staleLockMs = parsePositiveInt(
    env.TRIAL_NODE_DELETION_LOCK_STALE_MS,
    DEFAULT_TRIAL_NODE_DELETION_LOCK_STALE_MS,
    { name: 'TRIAL_NODE_DELETION_LOCK_STALE_MS', max: MAX_TRIAL_NODE_DELETION_LOCK_STALE_MS }
  );
  const staleDestroyingCutoffIso = new Date(now - staleLockMs).toISOString();
  const placeholders = cleanupWorkspaceIds.map(() => '?').join(', ');
  const exclusionClause = cleanupWorkspaceIds.length > 0 ? `AND id NOT IN (${placeholders})` : '';
  const bindValues =
    cleanupWorkspaceIds.length > 0
      ? [nowIso, nodeId, anonymousUserId, staleDestroyingCutoffIso, nodeId, ...cleanupWorkspaceIds]
      : [nowIso, nodeId, anonymousUserId, staleDestroyingCutoffIso, nodeId];

  const updateResult = await env.DATABASE.prepare(
    `UPDATE nodes
     SET status = 'destroying',
         updated_at = ?
     WHERE id = ?
       AND user_id = ?
       AND node_class != 'user-owned'
       AND (
         status NOT IN ('deleted', 'destroyed', 'destroying')
         OR (status = 'destroying' AND updated_at < ?)
       )
       AND NOT EXISTS (
         SELECT 1
         FROM workspaces
         WHERE node_id = ?
           AND status IN (${ACTIVE_WORKSPACE_STATUS_SQL})
           ${exclusionClause}
       )`
  )
    .bind(...bindValues)
    .run();

  if (getRunChanges(updateResult) > 0) return 'claimed';

  const existingClaim = await env.DATABASE.prepare(
    `SELECT status, updated_at
     FROM nodes
     WHERE id = ?
       AND user_id = ?`
  )
    .bind(nodeId, anonymousUserId)
    .first<NodeDeletionClaimRow>();

  if (
    existingClaim?.status === 'destroying' &&
    existingClaim.updated_at >= staleDestroyingCutoffIso
  ) {
    return 'concurrent';
  }
  if (existingClaim?.status === 'deleted' || existingClaim?.status === 'destroyed') {
    return 'terminal';
  }
  return 'failed';
}

async function releaseNodeDeletionClaim(
  env: Env,
  nodeId: string,
  anonymousUserId: string,
  nowIso: string,
  err: unknown
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const truncated = message.length > 500 ? `${message.slice(0, 500)}...` : message;
  await env.DATABASE.prepare(
    `UPDATE nodes
     SET status = 'error',
         health_status = 'unhealthy',
         error_message = ?,
         updated_at = ?
     WHERE id = ?
       AND user_id = ?
       AND status = 'destroying'`
  )
    .bind(`Trial cleanup failed: ${truncated}`, nowIso, nodeId, anonymousUserId)
    .run();
}

async function recordCleanupError(
  env: Env,
  anonymousUserId: string,
  eventName: string,
  context: CleanupContext,
  err: unknown
): Promise<void> {
  log.error(eventName, {
    ...context,
    ...serializeError(err),
  });

  try {
    await persistError(env.OBSERVABILITY_DATABASE, {
      source: 'api',
      level: 'error',
      message: `Expired trial resource cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
      stack: err instanceof Error ? err.stack : undefined,
      context: {
        recoveryType: 'expired_trial_resource_cleanup_failure',
        ...context,
      },
      userId: anonymousUserId,
    });
  } catch (persistErr) {
    log.error('trial_expire.persist_error_failed', {
      originalEvent: eventName,
      ...context,
      ...serializeError(persistErr),
    });
  }
}
