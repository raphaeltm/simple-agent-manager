/**
 * Phase 0 of the node cleanup sweep: cf-container nodes left behind after their
 * task reached a terminal state. Split out of `node-phases.ts`
 * (`.claude/rules/18-file-size-limits.md`); it carries the same rule-51 role and
 * class gates as every other destroying phase.
 */
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { stopNodeResources } from '../../services/nodes';
import { persistError } from '../../services/observability';
import { type CleanupConfig, markNodeCleanupBackoff, type NodeCleanupResult } from './shared';

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
    `SELECT DISTINCT n.id as node_id, n.user_id, w.id as workspace_id, t.id as task_id, t.status as task_status
     FROM nodes n
     INNER JOIN workspaces w ON w.node_id = n.id
     INNER JOIN tasks t ON t.workspace_id = w.id
     WHERE n.runtime = 'cf-container'
       AND n.status NOT IN ('deleted', 'stopped')
       AND n.node_role = 'workspace'
       AND n.node_class != 'user-owned'
       AND (n.cleanup_backoff_until IS NULL OR n.cleanup_backoff_until <= ?)
       AND w.status IN ('running', 'creating', 'recovery', 'sleeping', 'stopped')
       AND (
         t.status IN ('failed', 'cancelled')
         OR (t.status = 'completed' AND w.chat_session_id IS NULL)
       )
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
      task_id: string;
      task_status: string;
    }>();

  for (const candidate of candidates.results) {
    try {
      log.warn('node_cleanup.cf_container_terminal_task_destroying', {
        nodeId: candidate.node_id,
        workspaceId: candidate.workspace_id,
        taskId: candidate.task_id,
        taskStatus: candidate.task_status,
      });

      await stopNodeResources(candidate.node_id, candidate.user_id, env);

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
