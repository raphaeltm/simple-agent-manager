import { resolveProjectDataSessionLocation } from '@simple-agent-manager/project-data';
import { SNAPSHOT_EXPIRED_REASON } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { log } from '../lib/logger';
import * as projectDataService from './project-data';
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
  // A PUBLISHED archive location proves the session was terminal and its transcript moved, so
  // there is nothing left to stop, and `stopSession` would be refused by the archive write
  // fence. Without this branch such a snapshot failed every sweep (staging, 2026-11-12).
  // `migrating` and `frozen` prove nothing: `createCandidateJournal` fences the location
  // before the root has checked eligibility, and a refusal unwinds it to `root`. Leave those
  // for a later sweep rather than expire a snapshot on an unverified archive.
  const location = await resolveProjectDataSessionLocation(env, projectId, sessionId);
  if (location.state === 'archive_shard') return true;
  if (location.state !== 'root') return false;
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
 * A row whose project was deleted (`project_id` is set NULL on delete) has no conversation to
 * stop and is skipped by the loop, so it is excluded before the LIMIT as well.
 *
 * The states it declines are excluded here too: a queued or delegated task, and an archive
 * fence that is not yet published (`migrating`, `frozen`). Otherwise those rows would come back
 * every sweep and, ordered by expiry, fill the batch ahead of rows that can make progress
 * (`.claude/rules/47`).
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
       AND project_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM tasks t
         WHERE t.project_id = session_snapshots.project_id
           AND t.chat_session_id = session_snapshots.chat_session_id
           AND t.status IN ('queued', 'delegated'))
       AND NOT EXISTS (SELECT 1 FROM project_data_session_locations loc
         WHERE loc.project_id = session_snapshots.project_id
           AND loc.session_id = session_snapshots.chat_session_id
           AND loc.location_state IN ('migrating', 'frozen'))
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
