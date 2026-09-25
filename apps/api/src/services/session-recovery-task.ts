import { eq } from 'drizzle-orm';

import * as schema from '../db/schema';
import { log } from '../lib/logger';
import { ulid } from '../lib/ulid';
import {
  CAPACITY_PLACEMENT_SNAPSHOT_SQL_COLUMNS,
  CAPACITY_PLACEMENT_SNAPSHOT_SQL_PLACEHOLDERS,
  capacityPlacementSnapshotSqlValues,
} from './capacity-placement-snapshot';
import type { RecoveryContext } from './session-recovery-context';
import type { RecoveryPlacementResolution } from './session-recovery-placement';
import { type Db, SourceTaskNotWakeableError } from './session-recovery-task-guard';
import type { SessionRecoverySourceTaskGuard } from './session-snapshots';

export const SESSION_RECOVERY_INITIAL_PROMPT =
  'Resume this sleeping conversation from the persisted transcript. Do not repeat prior work; wait for and answer the latest queued follow-up message.';

export async function createRecoveryTask(
  database: D1Database,
  db: Db,
  context: RecoveryContext,
  chatSessionId: string,
  taskId: string,
  placementResolution: RecoveryPlacementResolution,
  sourceTaskGuard?: SessionRecoverySourceTaskGuard
): Promise<schema.Task> {
  const sourceTaskId =
    sourceTaskGuard?.taskId ??
    context.sourceTask?.recoverySourceTaskId ??
    context.sourceTask?.id ??
    null;
  if (!sourceTaskId) throw new SourceTaskNotWakeableError();
  const requiresLiveSource = sourceTaskGuard ? 1 : 0;

  const existing = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get();
  if (existing) {
    if (
      existing.projectId === context.project.id &&
      existing.recoverySourceTaskId === sourceTaskId &&
      existing.chatSessionId === chatSessionId &&
      existing.triggeredBy === 'session-recovery'
    ) {
      return existing;
    }
    throw new Error('Recovery task ID is already bound to different work');
  }

  const now = new Date().toISOString();
  const capacityPlacementSnapshot = placementResolution.capacityPlacementSnapshot;
  try {
    // D1 batches are transactional. The INSERT ... SELECT is the parent-state
    // compare-and-set: if the source is terminal or no longer owns this
    // conversation when the transaction begins, every later statement is a
    // no-op because it is conditioned on that insert having succeeded.
    const results = await database.batch([
      database
        .prepare(
          `INSERT INTO tasks
             (id, project_id, user_id, chat_session_id, recovery_source_task_id,
              title, description, status, execution_step, priority,
              agent_profile_hint, skill_id, skill_hint, task_mode, output_branch,
              requested_vm_size, requested_vm_size_source,
              resource_requirements_json, resource_requirements_source,
              resolved_reservation_json, credential_attribution_user_id,
              credential_attribution_project_id, credential_attribution_source,
              ${CAPACITY_PLACEMENT_SNAPSHOT_SQL_COLUMNS},
              triggered_by, created_by, created_at, updated_at)
           SELECT ?, source.project_id, ?, NULL, source.id,
                  COALESCE(NULLIF(source.title, ''), 'Resume conversation'), ?,
                  'queued', 'node_selection', COALESCE(source.priority, 0),
                  COALESCE(source.agent_profile_hint, ?), source.skill_id,
                  source.skill_hint, 'conversation', source.output_branch, ?,
                  COALESCE(source.requested_vm_size_source, 'session-recovery'),
                  source.resource_requirements_json, source.resource_requirements_source,
                  source.resolved_reservation_json,
                  ?,
                  ?,
                  ?,
                  ${CAPACITY_PLACEMENT_SNAPSHOT_SQL_PLACEHOLDERS},
                  'session-recovery', ?, ?, ?
             FROM tasks source
            WHERE source.id = ?
              AND source.project_id = ?
              AND (
                ? = 0
                OR source.status NOT IN ('completed', 'failed', 'cancelled')
                OR (
                  source.status = 'cancelled'
                  AND source.superseded_by_task_id IS NOT NULL
                  AND EXISTS (
                    SELECT 1 FROM tasks marked_successor
                     WHERE marked_successor.id = source.superseded_by_task_id
                       AND marked_successor.project_id = source.project_id
                       AND marked_successor.chat_session_id = ?
                       AND marked_successor.triggered_by = 'session-recovery'
                       AND marked_successor.status NOT IN ('completed', 'failed', 'cancelled')
                  )
                )
              )
              AND (
                source.chat_session_id = ?
                OR EXISTS (
                  SELECT 1 FROM tasks owner
                   WHERE owner.recovery_source_task_id = source.id
                     AND owner.project_id = source.project_id
                     AND owner.chat_session_id = ?
                     AND owner.triggered_by = 'session-recovery'
                )
              )
              AND NOT EXISTS (SELECT 1 FROM tasks duplicate WHERE duplicate.id = ?)`
        )
        .bind(
          taskId,
          context.snapshot.userId,
          SESSION_RECOVERY_INITIAL_PROMPT,
          context.workspace.agentProfileHint,
          placementResolution.placement.vmSize,
          placementResolution.credentialAttributionUserId,
          placementResolution.credentialAttributionProjectId,
          placementResolution.credentialAttributionSource,
          ...capacityPlacementSnapshotSqlValues(capacityPlacementSnapshot),
          context.snapshot.userId,
          now,
          now,
          sourceTaskId,
          context.project.id,
          requiresLiveSource,
          chatSessionId,
          chatSessionId,
          chatSessionId,
          taskId
        ),
      database
        .prepare(
          `UPDATE tasks
              SET chat_session_id = NULL,
                  superseded_by_task_id = ?,
                  updated_at = ?
            WHERE EXISTS (
                SELECT 1 FROM tasks recovery
                 WHERE recovery.id = ?
                   AND recovery.recovery_source_task_id = ?
                   AND recovery.chat_session_id IS NULL
              )
              AND (
                (chat_session_id = ? AND (id = ? OR recovery_source_task_id = ?))
                OR (
                  id = ?
                  AND project_id = ?
                  AND EXISTS (
                    SELECT 1 FROM tasks owner
                     WHERE owner.recovery_source_task_id = tasks.id
                       AND owner.project_id = tasks.project_id
                       AND owner.chat_session_id = ?
                       AND owner.triggered_by = 'session-recovery'
                       AND owner.status NOT IN ('completed', 'failed', 'cancelled')
                  )
                )
              )`
        )
        .bind(
          taskId,
          now,
          taskId,
          sourceTaskId,
          chatSessionId,
          sourceTaskId,
          sourceTaskId,
          sourceTaskId,
          context.project.id,
          chatSessionId
        ),
      database
        .prepare(
          `UPDATE workspaces
              SET chat_session_id = NULL, updated_at = ?
            WHERE chat_session_id = ?
              AND EXISTS (
                SELECT 1 FROM tasks recovery
                 WHERE recovery.id = ?
                   AND recovery.recovery_source_task_id = ?
                   AND recovery.chat_session_id IS NULL
              )`
        )
        .bind(now, chatSessionId, taskId, sourceTaskId),
      database
        .prepare(
          `UPDATE tasks
              SET chat_session_id = ?, updated_at = ?
            WHERE id = ?
              AND recovery_source_task_id = ?
              AND chat_session_id IS NULL
              AND EXISTS (
                SELECT 1 FROM tasks source
                 WHERE source.id = ?
                   AND source.project_id = ?
                   AND (
                     ? = 0
                     OR source.status NOT IN ('completed', 'failed', 'cancelled')
                     OR (
                       source.status = 'cancelled'
                       AND (
                         source.superseded_by_task_id = ?
                         OR (
                           source.superseded_by_task_id IS NOT NULL
                           AND EXISTS (
                             SELECT 1 FROM tasks marked_successor
                              WHERE marked_successor.id = source.superseded_by_task_id
                                AND marked_successor.project_id = source.project_id
                                AND marked_successor.chat_session_id = ?
                                AND marked_successor.triggered_by = 'session-recovery'
                                AND marked_successor.status NOT IN ('completed', 'failed', 'cancelled')
                           )
                         )
                       )
                     )
                   )
              )`
        )
        .bind(
          chatSessionId,
          now,
          taskId,
          sourceTaskId,
          sourceTaskId,
          context.project.id,
          requiresLiveSource,
          taskId,
          chatSessionId
        ),
      database
        .prepare(
          `INSERT INTO task_status_events
             (id, task_id, from_status, to_status, actor_type, actor_id, reason, created_at)
           SELECT ?, recovery.id, NULL, 'queued', 'system', NULL,
                  'Sleeping conversation wake claimed', ?
             FROM tasks recovery
            WHERE recovery.id = ?
              AND recovery.recovery_source_task_id = ?
              AND recovery.chat_session_id = ?`
        )
        .bind(ulid(), now, taskId, sourceTaskId, chatSessionId),
    ]);
    if ((results[0]?.meta.changes ?? 0) === 0) throw new SourceTaskNotWakeableError();
  } catch (error) {
    // A concurrent retry may have observed the claimed task ID and completed
    // this exact insert. Re-read before treating the batch error as terminal.
    const winner = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get();
    if (
      winner?.projectId === context.project.id &&
      winner.recoverySourceTaskId === sourceTaskId &&
      winner.chatSessionId === chatSessionId &&
      winner.triggeredBy === 'session-recovery'
    ) {
      return winner;
    }
    throw error;
  }

  const created = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get();
  if (
    !created ||
    created.recoverySourceTaskId !== sourceTaskId ||
    created.chatSessionId !== chatSessionId
  ) {
    throw new Error('Recovery task was not durably bound after its creation batch');
  }
  return created;
}

export async function abandonRecoveryHandoff(
  database: D1Database,
  context: RecoveryContext,
  task: schema.Task,
  chatSessionId: string,
  reason: string
): Promise<void> {
  if (!task.recoverySourceTaskId) return;
  const now = new Date().toISOString();
  const sourceTaskId = task.recoverySourceTaskId;
  const results = await database.batch([
    database
      .prepare(
        `UPDATE tasks
            SET status = 'cancelled', execution_step = NULL, chat_session_id = NULL,
                error_message = ?, completed_at = ?, updated_at = ?
          WHERE id = ?
            AND recovery_source_task_id = ?
            AND status NOT IN ('completed', 'failed', 'cancelled')`
      )
      .bind(reason.slice(0, 2048), now, now, task.id, sourceTaskId),
    database
      .prepare(
        `UPDATE tasks
            SET chat_session_id = ?,
                superseded_by_task_id = NULL,
                updated_at = ?
          WHERE id = ?
            AND project_id = ?
            AND chat_session_id IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM tasks owner WHERE owner.chat_session_id = ?
            )`
      )
      .bind(chatSessionId, now, sourceTaskId, context.project.id, chatSessionId),
    database
      .prepare(
        `UPDATE workspaces
            SET chat_session_id = ?, updated_at = ?
          WHERE id = ?
            AND chat_session_id IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM workspaces owner WHERE owner.chat_session_id = ?
            )`
      )
      .bind(chatSessionId, now, context.workspace.id, chatSessionId),
    database
      .prepare(
        `INSERT INTO task_status_events
           (id, task_id, from_status, to_status, actor_type, actor_id, reason, created_at)
         SELECT ?, task.id, 'queued', 'cancelled', 'system', NULL, ?, ?
           FROM tasks task
          WHERE task.id = ? AND task.status = 'cancelled'`
      )
      .bind(ulid(), reason.slice(0, 2048), now, task.id),
  ]);
  if ((results[0]?.meta.changes ?? 0) > 0) {
    log.info('session_recovery.handoff_abandoned', {
      projectId: context.project.id,
      chatSessionId,
      taskId: task.id,
      sourceTaskId,
    });
  }
}
