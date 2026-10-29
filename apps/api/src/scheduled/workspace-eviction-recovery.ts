import type { Env } from '../env';
import { log } from '../lib/logger';
import { resolveAdminSettingDetailsMany } from '../services/admin-settings';
import { ensureSessionRecovery } from '../services/session-recovery';
import { sessionRecoveryMaxAttempts } from '../services/session-snapshot-recovery-budget';

interface FailedEvictionRecovery {
  taskId: string;
  projectId: string;
  chatSessionId: string;
  workspaceId: string;
  nodeId: string;
  generation: string | null;
  recoveryAttemptId: string;
  interruptedWork: number | null;
}

/** Retry failed accepted eviction wakes without requiring another VM callback.
 * Selection is bounded; the snapshot claim rechecks the exact attempt, source,
 * ownership and non-decaying budget. Normal wake preserves replacement deletion
 * proof and profile/reservation placement. Spent budgets stay visible as failed.
 */
export async function runWorkspaceEvictionRecovery(
  env: Env,
  waitUntil: (promise: Promise<unknown>) => void,
  now = new Date()
): Promise<{ selected: number }> {
  const maxAttempts = sessionRecoveryMaxAttempts(env);
  const settings = await resolveAdminSettingDetailsMany(env, [
    'operations.evictionRecoveryRetryBatchSize',
    'operations.evictionRecoveryRetryWallMs',
    'operations.evictionRecoveryRetryDelayMs',
  ]);
  const [batchSetting, wallSetting, delaySetting] = settings;
  if (!batchSetting || !wallSetting || !delaySetting) {
    throw new Error('Eviction recovery retry settings are unavailable');
  }
  const batchSize = Number(batchSetting.value);
  const wallMs = Number(wallSetting.value);
  const delayMs = Number(delaySetting.value);
  const rows = await env.DATABASE.prepare(
    `SELECT task.id AS taskId, snapshot.project_id AS projectId,
            snapshot.chat_session_id AS chatSessionId, source.id AS workspaceId,
            source.node_id AS nodeId, source.eviction_generation AS generation,
            snapshot.recovery_attempt_id AS recoveryAttemptId,
            snapshot.eviction_recovery_interrupted_work AS interruptedWork
       FROM session_snapshots snapshot
       JOIN workspaces source ON source.id = snapshot.workspace_id
       JOIN tasks task ON task.id = snapshot.recovery_task_id
      WHERE snapshot.runtime = 'vm' AND snapshot.sleeping_at IS NOT NULL
        AND snapshot.recovery_status = 'failed'
        AND snapshot.recovery_attempt_id IS NOT NULL
        AND snapshot.recovery_attempts < ? AND snapshot.expires_at > ?
        AND snapshot.recovery_failed_at <= ? AND snapshot.updated_at <= ?
        AND ((snapshot.status = 'available' AND snapshot.degradation = 'none')
          OR (snapshot.status = 'degraded' AND snapshot.degradation IS NOT NULL
              AND snapshot.degradation != 'none'))
        AND source.status = 'evicted'
        AND source.id = snapshot.eviction_recovery_workspace_id
        AND source.node_id = snapshot.eviction_recovery_node_id
        AND source.eviction_generation IS snapshot.eviction_recovery_generation
        AND source.user_id = snapshot.user_id AND source.project_id = snapshot.project_id
        AND (source.chat_session_id IS NULL OR source.chat_session_id = snapshot.chat_session_id)
        AND task.status = 'sleeping' AND task.user_id = snapshot.user_id
        AND task.project_id = snapshot.project_id AND task.chat_session_id = snapshot.chat_session_id
      ORDER BY snapshot.updated_at ASC, snapshot.id ASC LIMIT ?`
  )
    .bind(
      maxAttempts,
      now.toISOString(),
      new Date(now.getTime() - delayMs).toISOString(),
      new Date(now.getTime() - delayMs).toISOString(),
      batchSize
    )
    .all<FailedEvictionRecovery>();
  const selected = rows.results ?? [];
  if (selected.length > 0) {
    waitUntil(
      (async () => {
        const deadline = Date.now() + wallMs;
        for (const row of selected) {
          if (Date.now() >= deadline) break;
          let deferred = true;
          try {
            const result = await ensureSessionRecovery(
              env,
              row.projectId,
              row.chatSessionId,
              {
                taskId: row.taskId,
                projectId: row.projectId,
                chatSessionId: row.chatSessionId,
                evictionRecoveryRetry: {
                  workspaceId: row.workspaceId,
                  nodeId: row.nodeId,
                  generation: row.generation,
                  recoveryAttemptId: row.recoveryAttemptId,
                  maxAttempts,
                },
              },
              {
                excludedNodeId: row.nodeId,
                evictionFence: {
                  workspaceId: row.workspaceId,
                  nodeId: row.nodeId,
                  generation: row.generation,
                },
                wakeCause: 'runtime_lost',
                interruptedWork:
                  row.interruptedWork === null ? undefined : row.interruptedWork === 1,
              }
            );
            deferred = result.status === 'unavailable';
            log.info('workspace_eviction_recovery.retry', { taskId: row.taskId, ...result });
          } catch (error) {
            log.error('workspace_eviction_recovery.retry_failed', {
              taskId: row.taskId,
              error: error instanceof Error ? error.message : String(error),
            });
          } finally {
            if (deferred) {
              try {
                await rotateDeferredRecovery(env, row, now.toISOString());
              } catch (error) {
                log.error('workspace_eviction_recovery.rotation_failed', {
                  taskId: row.taskId,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            }
          }
        }
      })()
    );
  }
  return { selected: selected.length };
}

/** Rotate a still-identical failed attempt without resetting its clean-failure anchor. */
async function rotateDeferredRecovery(
  env: Env,
  row: FailedEvictionRecovery,
  now: string
): Promise<void> {
  await env.DATABASE.prepare(
    `UPDATE session_snapshots AS snapshot SET updated_at = MAX(updated_at, ?)
    WHERE snapshot.chat_session_id = ? AND snapshot.project_id = ?
      AND snapshot.recovery_task_id = ? AND snapshot.recovery_attempt_id = ?
      AND snapshot.recovery_status = 'failed' AND snapshot.sleeping_at IS NOT NULL
      AND snapshot.workspace_id = ? AND snapshot.eviction_recovery_workspace_id = ?
      AND snapshot.eviction_recovery_node_id = ? AND snapshot.eviction_recovery_generation IS ?
      AND EXISTS (SELECT 1 FROM workspaces source JOIN tasks task ON task.id = snapshot.recovery_task_id
        WHERE source.id = snapshot.workspace_id AND source.node_id = snapshot.eviction_recovery_node_id
          AND source.eviction_generation IS snapshot.eviction_recovery_generation
          AND source.status = 'evicted' AND source.user_id = snapshot.user_id
          AND source.project_id = snapshot.project_id
          AND (source.chat_session_id IS NULL OR source.chat_session_id = snapshot.chat_session_id)
          AND task.user_id = snapshot.user_id AND task.project_id = snapshot.project_id
          AND task.chat_session_id = snapshot.chat_session_id AND task.status = 'sleeping')`
  )
    .bind(
      now,
      row.chatSessionId,
      row.projectId,
      row.taskId,
      row.recoveryAttemptId,
      row.workspaceId,
      row.workspaceId,
      row.nodeId,
      row.generation
    )
    .run();
}
