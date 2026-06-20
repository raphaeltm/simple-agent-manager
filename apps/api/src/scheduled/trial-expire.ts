/**
 * Cron handler: expire stale pending / ready trials.
 *
 * Runs on the 5-minute operational sweep. Any `trials` row whose
 * status is still `pending` or `ready` and whose `expires_at` is in
 * the past is transitioned to `expired`. Unclaimed expired trials still owned
 * by the anonymous sentinel user also have their workspaces/nodes cleaned up.
 * The TrialCounter DO is NOT decremented — the slot was genuinely consumed for
 * the month.
 *
 * Returns a summary for the `cron.completed` log message.
 */
import { TRIAL_ANONYMOUS_USER_ID } from '@simple-agent-manager/shared';
import { and, inArray, lt } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log, serializeError } from '../lib/logger';
import { deleteWorkspaceOnNode } from '../services/node-agent';
import { deleteNodeResources } from '../services/nodes';
import { persistError } from '../services/observability';
import * as projectDataService from '../services/project-data';

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

interface CountRow {
  active_count: number;
}

function resolveAnonymousUserId(env: Env): string {
  return env.TRIAL_ANONYMOUS_USER_ID ?? TRIAL_ANONYMOUS_USER_ID;
}

export async function runTrialExpireSweep(
  env: Env,
  now: number = Date.now()
): Promise<TrialExpireResult> {
  const db = drizzle(env.DATABASE, { schema });

  // D1 supports UPDATE ... RETURNING; we use an explicit SELECT/UPDATE pair
  // so we can count rows without relying on provider-specific affected-row
  // counts.
  const candidates = await db
    .select({ id: schema.trials.id })
    .from(schema.trials)
    .where(
      and(
        inArray(schema.trials.status, ['pending', 'ready']),
        lt(schema.trials.expiresAt, now)
      )
    )
    .limit(1000);

  if (candidates.length > 0) {
    await db
      .update(schema.trials)
      .set({ status: 'expired' })
      .where(
        inArray(
          schema.trials.id,
          candidates.map((r) => r.id)
        )
      );

    // We deliberately DO NOT also `eq(status, ...)` here — the candidate
    // IDs are scoped to the snapshot we just read, and overriding a concurrent
    // status transition would be wrong. The subsequent cron invocation will
    // re-evaluate any rows we skipped.
  }

  const cleanup = await cleanupExpiredTrialResources(env, now);

  return { expired: candidates.length, ...cleanup };
}

async function cleanupExpiredTrialResources(
  env: Env,
  now: number
): Promise<Omit<TrialExpireResult, 'expired'>> {
  const anonymousUserId = resolveAnonymousUserId(env);
  const nowIso = new Date(now).toISOString();
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
         ON p.normalized_name = ('trial-' || lower(t.id))
       WHERE t.status = 'expired'
         AND t.claimed_by_user_id IS NULL
         AND t.expires_at < ?
     )
     SELECT r.trial_id, r.project_id
     FROM resolved_trials r
     INNER JOIN projects p ON p.id = r.project_id
     WHERE p.user_id = ?
       AND EXISTS (
         SELECT 1 FROM workspaces w
         WHERE w.project_id = r.project_id
           AND w.status != 'deleted'
       )
     LIMIT 1000`
  ).bind(now, anonymousUserId).all<ExpiredTrialProjectRow>();

  for (const row of expiredProjects.results) {
    try {
      await env.DATABASE.prepare(
        `UPDATE trials
         SET project_id = ?
         WHERE id = ?
           AND project_id IS NULL`
      ).bind(row.project_id, row.trial_id).run();
      result.projectsLinked++;

      const workspaces = await env.DATABASE.prepare(
        `SELECT id, node_id, user_id, project_id, chat_session_id, status
         FROM workspaces
         WHERE project_id = ?
           AND user_id = ?
           AND status != 'deleted'`
      ).bind(row.project_id, anonymousUserId).all<TrialWorkspaceCleanupRow>();

      const touchedNodeIds = new Set<string>();
      for (const workspace of workspaces.results) {
        if (workspace.node_id) {
          touchedNodeIds.add(workspace.node_id);
          await deleteWorkspaceOnNode(
            workspace.node_id,
            workspace.id,
            env,
            workspace.user_id
          ).catch((err) => {
            log.warn('trial_expire.delete_workspace_on_node_failed', {
              trialId: row.trial_id,
              projectId: row.project_id,
              workspaceId: workspace.id,
              nodeId: workspace.node_id,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }

        await env.DATABASE.prepare(
          `UPDATE workspaces
           SET status = 'deleted',
               updated_at = ?
           WHERE id = ?
             AND user_id = ?
             AND status != 'deleted'`
        ).bind(nowIso, workspace.id, workspace.user_id).run();
        result.workspacesDeleted++;

        if (workspace.project_id && workspace.chat_session_id) {
          await projectDataService.stopSession(
            env,
            workspace.project_id,
            workspace.chat_session_id
          ).catch((err) => {
            log.warn('trial_expire.stop_session_failed', {
              trialId: row.trial_id,
              projectId: workspace.project_id,
              workspaceId: workspace.id,
              chatSessionId: workspace.chat_session_id,
              error: err instanceof Error ? err.message : String(err),
            });
          });
          await projectDataService.cleanupWorkspaceActivity(
            env,
            workspace.project_id,
            workspace.id
          ).catch((err) => {
            log.warn('trial_expire.cleanup_workspace_activity_failed', {
              trialId: row.trial_id,
              projectId: workspace.project_id,
              workspaceId: workspace.id,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }
      }

      for (const nodeId of touchedNodeIds) {
        const active = await env.DATABASE.prepare(
          `SELECT COUNT(*) as active_count
           FROM workspaces
           WHERE node_id = ?
             AND user_id = ?
             AND status IN ('running', 'creating', 'recovery')`
        ).bind(nodeId, anonymousUserId).first<CountRow>();

        if ((active?.active_count ?? 0) > 0) {
          continue;
        }

        await deleteNodeResources(nodeId, anonymousUserId, env);
        await env.DATABASE.prepare(
          `UPDATE nodes
           SET status = 'deleted',
               warm_since = NULL,
               health_status = 'stale',
               updated_at = ?
           WHERE id = ?
             AND user_id = ?
             AND status NOT IN ('deleted', 'destroyed', 'destroying', 'error')`
        ).bind(nowIso, nodeId, anonymousUserId).run();
        result.nodesDeleted++;
      }
    } catch (err) {
      result.cleanupErrors++;
      log.error('trial_expire.resource_cleanup_failed', {
        trialId: row.trial_id,
        projectId: row.project_id,
        ...serializeError(err),
      });
      await persistError(env.OBSERVABILITY_DATABASE, {
        source: 'api',
        level: 'error',
        message: `Expired trial resource cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
        stack: err instanceof Error ? err.stack : undefined,
        context: {
          recoveryType: 'expired_trial_resource_cleanup_failure',
          trialId: row.trial_id,
          projectId: row.project_id,
        },
        userId: anonymousUserId,
      });
    }
  }

  return result;
}
