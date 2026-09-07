import type { Env } from '../env';
import {
  CAPACITY_PLACEMENT_SNAPSHOT_SQL_COLUMNS,
  CAPACITY_PLACEMENT_SNAPSHOT_SQL_PLACEHOLDERS,
  capacityPlacementSnapshotSqlValues,
} from './capacity-placement-snapshot';
import type {
  PreparedSubmission,
  ReservedTaskSubmissionInput,
} from './reserved-task-submission-contracts';

export async function commitD1Submission(
  env: Env,
  input: ReservedTaskSubmissionInput,
  fingerprint: string,
  prepared: PreparedSubmission,
  now: string
): Promise<void> {
  const t = prepared.snapshot.task;
  const insertTaskColumns = `(
       id, project_id, user_id, chat_session_id, title, description, status, execution_step,
       priority, agent_profile_hint, skill_id, skill_hint, task_mode, output_branch,
       triggered_by, trigger_id, trigger_execution_id, requested_vm_size, requested_vm_size_source,
       resource_requirements_json, resource_requirements_source, resolved_reservation_json,
       credential_attribution_user_id, credential_attribution_project_id, credential_attribution_source,
       ${CAPACITY_PLACEMENT_SNAPSHOT_SQL_COLUMNS},
       created_by, created_at, updated_at
     )`;
  const insertTaskValues = `
       ?, ?, ?, ?, ?, ?, 'queued', 'node_selection',
       0, ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?,
       ?, ?, ?,
       ?, ?, ?,
       ${CAPACITY_PLACEMENT_SNAPSHOT_SQL_PLACEHOLDERS},
       ?, ?, ?`;
  const insertTaskBindings = [
    t.taskId,
    t.projectId,
    t.userId,
    t.chatSessionId,
    t.title,
    t.description,
    t.agentProfileHint,
    t.skillId,
    t.skillHint,
    t.taskMode,
    t.outputBranch,
    t.triggeredBy,
    t.triggerId,
    t.triggerExecutionId,
    t.requestedVmSize,
    t.requestedVmSizeSource,
    t.resourceRequirementsJson,
    t.resourceRequirementsSource,
    t.resolvedReservationJson,
    t.credentialAttributionUserId,
    t.credentialAttributionProjectId,
    t.credentialAttributionSource,
    ...capacityPlacementSnapshotSqlValues(t.capacityPlacementSnapshot),
    t.userId,
    now,
    now,
  ];
  const insertTask =
    input.source.kind === 'trigger'
      ? env.DATABASE.prepare(
          `INSERT INTO tasks ${insertTaskColumns}
           SELECT ${insertTaskValues}
            WHERE EXISTS (
              SELECT 1 FROM trigger_executions
               WHERE id = ?
                 AND trigger_id = ?
                 AND project_id = ?
                 AND (task_id IS NULL OR task_id = ?)
            )`
        ).bind(
          ...insertTaskBindings,
          input.source.sourceExecutionId,
          input.source.sourceId,
          input.projectId,
          input.identities.taskId
        )
      : env.DATABASE.prepare(
          `INSERT INTO tasks ${insertTaskColumns}
           VALUES (${insertTaskValues})`
        ).bind(...insertTaskBindings);
  const insertStatus = env.DATABASE.prepare(
    `INSERT INTO task_status_events
       (id, task_id, from_status, to_status, actor_type, actor_id, reason, created_at)
     VALUES (?, ?, NULL, 'queued', ?, ?, ?, ?)`
  ).bind(
    input.identities.initialStatusEventId,
    input.identities.taskId,
    input.source.initialStatusActorType,
    input.source.initialStatusActorId,
    input.source.initialStatusReason,
    now
  );
  const insertCheckpoint = env.DATABASE.prepare(
    `INSERT INTO task_submission_checkpoints
       (task_id, project_id, user_id, chat_session_id, initial_message_id,
        initial_status_event_id, source_kind, source_id, source_execution_id, triggered_by,
        intent_fingerprint, accepted_snapshot_json, branch_name, task_title,
        checkpoint_state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'd1_committed', ?, ?)`
  ).bind(
    input.identities.taskId,
    input.projectId,
    input.userId,
    input.identities.chatSessionId,
    input.identities.initialMessageId,
    input.identities.initialStatusEventId,
    input.source.kind,
    input.source.sourceId,
    input.source.sourceExecutionId,
    input.source.triggeredBy,
    fingerprint,
    prepared.acceptedSnapshotJson,
    prepared.snapshot.task.outputBranch,
    prepared.snapshot.task.title,
    now,
    now
  );

  if (input.source.kind === 'trigger') {
    const linkSource = env.DATABASE.prepare(
      `UPDATE trigger_executions
          SET task_id = ?
        WHERE id = ?
          AND trigger_id = ?
          AND project_id = ?
          AND (task_id IS NULL OR task_id = ?)`
    ).bind(
      input.identities.taskId,
      input.source.sourceExecutionId,
      input.source.sourceId,
      input.projectId,
      input.identities.taskId
    );
    await env.DATABASE.batch([insertTask, insertStatus, insertCheckpoint, linkSource]);
    return;
  }

  await env.DATABASE.batch([insertTask, insertStatus, insertCheckpoint]);
}
