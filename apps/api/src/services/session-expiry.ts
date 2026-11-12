import { SNAPSHOT_EXPIRED_REASON } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { log } from '../lib/logger';
import * as projectDataService from './project-data';
import { resolveProjectDataSessionLocation } from './project-data-archive-routing';
import { transitionTaskToTerminal } from './task-terminal-transition';

/** Point lookup used by the sweep before a legacy sleep can be mistaken for death. */
export async function expireSleepingConversation(
  env: Env,
  projectId: string,
  sessionId: string,
  now: Date = new Date()
): Promise<boolean> {
  const snapshot = await env.DATABASE.prepare(
    `SELECT id FROM session_snapshots
     WHERE project_id = ? AND chat_session_id = ? AND expires_at <= ?
       AND sleeping_at IS NOT NULL AND sleep_status IN ('sleeping', 'purging')
       AND status IN ('available', 'degraded', 'expired')
       AND (recovery_status IS NULL OR recovery_status != 'waking')`
  )
    .bind(projectId, sessionId, now.toISOString())
    .first<{ id: string }>();
  if (!snapshot) return false;

  const tasks = await env.DATABASE.prepare(
    `SELECT id, status FROM tasks WHERE project_id = ? AND chat_session_id = ?
       AND status IN ('sleeping', 'in_progress', 'queued', 'delegated')`
  )
    .bind(projectId, sessionId)
    .all<{ id: string; status: string }>();
  if (tasks.results.some((task) => task.status === 'queued' || task.status === 'delegated'))
    return false;
  for (const task of tasks.results) {
    const outcome = await transitionTaskToTerminal(env, {
      taskId: task.id,
      projectId,
      status: 'cancelled',
      reason: SNAPSHOT_EXPIRED_REASON,
      terminalReason: SNAPSHOT_EXPIRED_REASON,
      lifecycleOutcome: true,
      expiredSnapshotId: snapshot.id,
      now,
      expectedChatSessionId: sessionId,
      source: 'session_snapshot_expiry',
      stopWorkspace: false,
    });
    if (outcome !== 'transitioned' && outcome !== 'already_terminal') return false;
  }
  // A session whose transcript has moved off the root object (archived, or mid-migration) was
  // terminal before the archive could select it, so there is nothing left to stop, and
  // `stopSession` would be refused by the archive write fence. Without this branch such a
  // snapshot failed every sweep and sat at the head of the batch (staging, 2026-11-12).
  const location = await resolveProjectDataSessionLocation(env, projectId, sessionId);
  if (location.state !== 'root') return true;
  // Retried independently of task CAS: a failed DO write must leave metadata for retry.
  await projectDataService.stopSession(env, projectId, sessionId);
  return true;
}

/**
 * Metadata-only pass: legacy degraded snapshots keep their R2 artifacts.
 *
 * Selects every expired degraded sleeper, whatever state its task is in. A sleeper whose task
 * already finished is the commonest case: until 2026-11-12 an open-task requirement here left
 * 296 production conversations `sleeping` forever, which also kept them out of the archive
 * drain. `expireSleepingConversation` cancels any open task and then stops the session, and
 * with no open task it just stops it.
 *
 * The one state it declines, a queued or delegated task, is excluded here too. Otherwise those
 * rows would come back every sweep and, ordered by expiry, fill the batch ahead of rows that
 * can make progress (`.claude/rules/47`).
 */
export async function expireDegradedSleepingConversations(
  env: Env,
  now: Date,
  batchSize: number
): Promise<void> {
  const rows = await env.DATABASE.prepare(
    `SELECT id, project_id, chat_session_id FROM session_snapshots
     WHERE expires_at <= ? AND sleeping_at IS NOT NULL AND sleep_status = 'sleeping'
       AND status = 'degraded' AND sleep_fallback_json IS NULL
       AND NOT EXISTS (SELECT 1 FROM tasks t
         WHERE t.project_id = session_snapshots.project_id
           AND t.chat_session_id = session_snapshots.chat_session_id
           AND t.status IN ('queued', 'delegated'))
       AND (recovery_status IS NULL OR recovery_status != 'waking')
     ORDER BY expires_at, id LIMIT ?`
  )
    .bind(now.toISOString(), batchSize)
    .all<{
      id: string;
      project_id: string | null;
      chat_session_id: string;
    }>();
  for (const row of rows.results) {
    if (!row.project_id) continue;
    try {
      if (await expireSleepingConversation(env, row.project_id, row.chat_session_id, now)) {
        await env.DATABASE.prepare(
          `UPDATE session_snapshots SET status = 'expired', updated_at = ?
         WHERE id = ? AND status = 'degraded' AND sleep_status = 'sleeping'
           AND expires_at <= ? AND (recovery_status IS NULL OR recovery_status != 'waking')`
        )
          .bind(now.toISOString(), row.id, now.toISOString())
          .run();
      }
    } catch (error) {
      log.warn('session_expiry.failed', { snapshotId: row.id, error: String(error) });
    }
  }
}
