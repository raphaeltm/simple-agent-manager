/**
 * Workspace-mutating phases of the cleanup sweep.
 *
 * Both phases here previously selected workspaces WITHOUT joining `nodes` at all,
 * so a workspace running on a user-owned BYO node was stopped/deleted by SAM's own
 * sweep. The destroy-service chokepoints stopped the user's cloud VM from being
 * deleted, but the D1 rows were still terminally mutated. Rule 51 requires the
 * class guard on every terminal-mutate candidate query, so both now LEFT JOIN
 * `nodes` and exclude `node_class = 'user-owned'`.
 *
 * The join is a LEFT JOIN because `workspaces.node_id` is nullable (FK is
 * ON DELETE SET NULL — the workspace row survives as history when its node dies).
 * A workspace with no node has no owning machine to protect, so it stays eligible.
 */
import { and, eq } from 'drizzle-orm';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { deleteWorkspaceOnNode, stopWorkspaceOnNode } from '../../services/node-agent';
import { persistError } from '../../services/observability';
import * as projectDataService from '../../services/project-data';
import type { CleanupConfig, CleanupDb, NodeCleanupResult } from './shared';

/**
 * Phase 4 — task-created workspaces still active after their task ended.
 *
 * Only workspaces that were EVER associated with a task are considered. User-created
 * workspaces (never referenced by any task) are intentionally long-lived.
 */
export async function sweepOrphanedWorkspaces(
  db: CleanupDb,
  env: Env,
  now: Date,
  config: CleanupConfig,
  result: NodeCleanupResult
): Promise<void> {
  const candidates = await env.DATABASE.prepare(
    `SELECT w.id, w.node_id, w.user_id, w.status, w.created_at, w.project_id, w.chat_session_id
     FROM workspaces w
     LEFT JOIN nodes n ON n.id = w.node_id
     WHERE w.status IN ('running', 'creating', 'recovery')
       AND (n.id IS NULL OR n.node_class != 'user-owned')
       AND EXISTS (
         SELECT 1 FROM tasks t
         WHERE t.workspace_id = w.id
           AND t.status IN ('completed', 'failed', 'cancelled')
       )
       AND NOT EXISTS (
         SELECT 1 FROM tasks t
         WHERE t.workspace_id = w.id
           AND t.status IN ('queued', 'delegated', 'in_progress')
       )
       AND w.created_at < ?
     ORDER BY w.created_at ASC
     LIMIT ?`
  )
    .bind(
      new Date(now.getTime() - config.orphanGracePeriodMs).toISOString(),
      config.workspaceSweepLimit
    )
    .all<{
      id: string;
      node_id: string | null;
      user_id: string;
      status: string;
      created_at: string;
      project_id: string | null;
      chat_session_id: string | null;
    }>();

  for (const ws of candidates.results) {
    log.warn('node_cleanup.orphaned_workspace_stopping', {
      workspaceId: ws.id,
      nodeId: ws.node_id,
      userId: ws.user_id,
      createdAt: ws.created_at,
    });

    try {
      // Best-effort stop on the VM agent, on the BACKGROUND timeout (rule 47) —
      // an unreachable node must cost ~5s here, not the interactive 30s. This
      // call is exactly what made the unbounded sweep blow the Worker budget.
      if (ws.node_id) {
        await stopWorkspaceOnNode(ws.node_id, ws.id, env, ws.user_id, {
          requestTimeoutMs: config.agentTimeoutMs,
        }).catch((e) => {
          log.warn('node_cleanup.orphan_stop_on_node_failed', {
            workspaceId: ws.id,
            error: String(e),
          });
        });
      }

      // Mark stopped in D1. This is the candidate's escape path (rule 47): it no
      // longer matches the `status IN ('running','creating','recovery')` predicate,
      // so a workspace whose VM agent is permanently unreachable is not retried
      // on every subsequent sweep.
      await db
        .update(schema.workspaces)
        .set({ status: 'stopped', updatedAt: new Date().toISOString() })
        .where(eq(schema.workspaces.id, ws.id));

      if (ws.project_id && ws.chat_session_id) {
        await projectDataService.stopSession(env, ws.project_id, ws.chat_session_id).catch((e) => {
          log.warn('node_cleanup.orphan_session_stop_failed', {
            workspaceId: ws.id,
            error: String(e),
          });
        });
        await projectDataService.cleanupWorkspaceActivity(env, ws.project_id, ws.id).catch((e) => {
          log.warn('node_cleanup.orphan_activity_cleanup_failed', {
            workspaceId: ws.id,
            error: String(e),
          });
        });
      }

      await persistError(env.OBSERVABILITY_DATABASE, {
        source: 'api',
        level: 'warn',
        message: 'Orphaned workspace stopped: was running with no active task',
        context: {
          recoveryType: 'orphaned_workspace',
          workspaceId: ws.id,
          nodeId: ws.node_id,
          createdAt: ws.created_at,
        },
        userId: ws.user_id,
        nodeId: ws.node_id,
        workspaceId: ws.id,
      });

      result.orphanedWorkspacesFlagged++;
    } catch (e) {
      log.error('node_cleanup.orphan_workspace_stop_failed', {
        workspaceId: ws.id,
        error: String(e),
      });
      result.errors++;
    }
  }
}

/**
 * Phase 6 — safety net for stopped workspaces the DO alarm never deleted.
 */
export async function sweepStaleStoppedWorkspaces(
  db: CleanupDb,
  env: Env,
  now: Date,
  config: CleanupConfig,
  result: NodeCleanupResult
): Promise<void> {
  // 2x buffer so the DO alarm gets first attempt.
  const threshold = new Date(now.getTime() - config.stoppedTtlMs * 2).toISOString();

  const candidates = await env.DATABASE.prepare(
    `SELECT w.id, w.node_id, w.user_id
     FROM workspaces w
     LEFT JOIN nodes n ON n.id = w.node_id
     WHERE w.status = 'stopped'
       AND (n.id IS NULL OR n.node_class != 'user-owned')
       AND w.updated_at < ?
     ORDER BY w.updated_at ASC
     LIMIT ?`
  )
    .bind(threshold, config.workspaceSweepLimit)
    .all<{
      id: string;
      node_id: string | null;
      user_id: string;
    }>();

  for (const ws of candidates.results) {
    try {
      if (ws.node_id) {
        await deleteWorkspaceOnNode(ws.node_id, ws.id, env, ws.user_id, {
          requestTimeoutMs: config.agentTimeoutMs,
        }).catch((e) => {
          log.warn('node_cleanup.stale_stopped_delete_on_node_failed', {
            workspaceId: ws.id,
            error: String(e),
          });
        });
      }

      // Status guard prevents a TOCTOU race if the workspace was restarted. Also
      // the escape path: on success the row no longer matches `status='stopped'`.
      await db
        .update(schema.workspaces)
        .set({ status: 'deleted', updatedAt: new Date().toISOString() })
        .where(and(eq(schema.workspaces.id, ws.id), eq(schema.workspaces.status, 'stopped')));

      result.stoppedWorkspacesDeleted++;
    } catch (e) {
      log.error('node_cleanup.stale_stopped_workspace_delete_failed', {
        workspaceId: ws.id,
        error: String(e),
      });
      result.errors++;
    }
  }
}
