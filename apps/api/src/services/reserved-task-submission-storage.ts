import type { Env } from '../env';
import { getMcpLimits } from '../routes/mcp/_helpers';
import {
  CAPACITY_PLACEMENT_SNAPSHOT_SQL_COLUMNS,
  CAPACITY_PLACEMENT_SNAPSHOT_SQL_PLACEHOLDERS,
  capacityPlacementSnapshotSqlValues,
} from './capacity-placement-snapshot';
import type {
  PreparedSubmission,
  ReservedTaskSubmissionInput,
} from './reserved-task-submission-contracts';
import {
  workflowCapacityBlocked,
  WorkflowCapacityDeferredError,
  WorkflowSubmissionGuardRejectedError,
} from './workflow-admission';

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
       resource_requirements_json, resource_requirement_plan_json, resource_requirements_source, resolved_reservation_json,
       credential_attribution_user_id, credential_attribution_project_id, credential_attribution_source,
       ${CAPACITY_PLACEMENT_SNAPSHOT_SQL_COLUMNS},
       created_by, created_at, updated_at
     )`;
  const insertTaskValues = `
       ?, ?, ?, ?, ?, ?, 'queued', 'node_selection',
       0, ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?,
       ?, ?, ?, ?,
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
    t.resourceRequirementPlanJson,
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
  const workflow = input.workflow;
  const limits = getMcpLimits(env);
  const workflowGuard = workflow
    ? `WHERE EXISTS (
    SELECT 1 FROM mission_steps s JOIN missions m ON m.id = s.mission_id
    WHERE s.mission_id = ? AND s.step_key = ? AND s.task_id = ? AND s.attempt_id = ?
      AND s.state = 'starting' AND m.status = 'active' AND m.project_id = ? AND m.user_id = ?
      AND m.workflow_deadline_at > ?
      AND ? <= COALESCE((SELECT max_dispatch_depth FROM projects WHERE id = m.project_id), ?)
  ) AND (SELECT COUNT(*) FROM tasks WHERE parent_task_id = ? AND project_id = ?
    AND status IN ('queued','in_progress','delegated','awaiting_followup')) < COALESCE((SELECT max_sub_tasks_per_task FROM projects WHERE id = ?), ?)
    AND (SELECT COUNT(*) FROM tasks WHERE project_id = ? AND dispatch_depth > 0
    AND status IN ('queued','in_progress','delegated','awaiting_followup')) < COALESCE((SELECT max_concurrent_tasks FROM projects WHERE id = ?), ?)`
    : '';
  const insertTask = workflow
    ? env.DATABASE.prepare(
        `INSERT INTO tasks ${insertTaskColumns} SELECT ${insertTaskValues} ${workflowGuard}`
      ).bind(
        ...insertTaskBindings,
        workflow.missionId,
        workflow.stepKey,
        t.taskId,
        input.source.sourceExecutionId,
        input.projectId,
        input.userId,
        Date.now(),
        workflow.dispatchDepth,
        limits.dispatchMaxDepth,
        workflow.parentTaskId,
        input.projectId,
        input.projectId,
        limits.dispatchMaxPerTask,
        input.projectId,
        input.projectId,
        limits.dispatchMaxActivePerProject
      )
    : input.source.kind === 'trigger'
      ? // An execution whose agent email SAM rejected (gave up on, or refused) never gains a
        // task: a slow attempt that outlived its lease would otherwise start one after the
        // email's run slot was released (services/agent-email/inbound-delivery.ts,
        // closeDelivery). Executions of other trigger types have no email rows.
        env.DATABASE.prepare(
          `INSERT INTO tasks ${insertTaskColumns}
           SELECT ${insertTaskValues}
            WHERE EXISTS (
              SELECT 1 FROM trigger_executions
               WHERE id = ?
                 AND trigger_id = ?
                 AND project_id = ?
                 AND (task_id IS NULL OR task_id = ?)
                 AND NOT EXISTS (
                   SELECT 1 FROM trigger_email_messages m
                    WHERE m.trigger_execution_id = trigger_executions.id
                      AND m.direction = 'inbound' AND m.status = 'rejected'
                 )
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
  // A guarded task insert may insert nothing. The rows that hang off the task are then skipped
  // too, rather than relying on foreign keys to fail the batch.
  const taskGuarded = Boolean(workflow) || input.source.kind === 'trigger';
  const insertStatus = env.DATABASE.prepare(
    `INSERT INTO task_status_events
       (id, task_id, from_status, to_status, actor_type, actor_id, reason, created_at)
     SELECT ?, ?, NULL, 'queued', ?, ?, ?, ? ${taskGuarded ? 'WHERE EXISTS (SELECT 1 FROM tasks WHERE id = ?)' : ''}`
  ).bind(
    input.identities.initialStatusEventId,
    input.identities.taskId,
    input.source.initialStatusActorType,
    input.source.initialStatusActorId,
    input.source.initialStatusReason,
    now,
    ...(taskGuarded ? [input.identities.taskId] : [])
  );
  const insertCheckpoint = env.DATABASE.prepare(
    `INSERT INTO task_submission_checkpoints
       (task_id, project_id, user_id, chat_session_id, initial_message_id,
        initial_status_event_id, source_kind, source_id, source_execution_id, triggered_by,
        intent_fingerprint, accepted_snapshot_json, branch_name, task_title,
        checkpoint_state, created_at, updated_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'd1_committed', ?, ? ${taskGuarded ? 'WHERE EXISTS (SELECT 1 FROM tasks WHERE id = ?)' : ''}`
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
    now,
    ...(taskGuarded ? [input.identities.taskId] : [])
  );

  if (input.source.kind === 'trigger') {
    const linkSource = env.DATABASE.prepare(
      `UPDATE trigger_executions
          SET task_id = ?
        WHERE id = ?
          AND trigger_id = ?
          AND project_id = ?
          AND (task_id IS NULL OR task_id = ?)
          AND EXISTS (SELECT 1 FROM tasks WHERE id = ?)`
    ).bind(
      input.identities.taskId,
      input.source.sourceExecutionId,
      input.source.sourceId,
      input.projectId,
      input.identities.taskId,
      input.identities.taskId
    );
    const [inserted] = await env.DATABASE.batch([
      insertTask,
      insertStatus,
      insertCheckpoint,
      linkSource,
    ]);
    if (!inserted?.meta.changes) {
      throw new Error(
        `Trigger execution ${input.source.sourceExecutionId} can no longer start a task: ` +
          'it is linked to another task, or its agent email was given up'
      );
    }
    return;
  }

  const lineage = workflow
    ? [
        env.DATABASE.prepare(
          'UPDATE tasks SET mission_id = ?, parent_task_id = ?, dispatch_depth = ? WHERE id = ?'
        ).bind(workflow.missionId, workflow.parentTaskId, workflow.dispatchDepth, t.taskId),
      ]
    : [];
  try {
    const results = await env.DATABASE.batch([
      insertTask,
      insertStatus,
      insertCheckpoint,
      ...lineage,
    ]);
    if (workflow && results[0]?.meta.changes === 0) {
      if (await workflowCapacityBlocked(env, input.projectId, workflow.parentTaskId))
        throw new WorkflowCapacityDeferredError('Waiting for project task capacity');
      throw new WorkflowSubmissionGuardRejectedError(
        'Workflow step submission guard rejected the task'
      );
    }
  } catch (error) {
    if (workflow && (await workflowCapacityBlocked(env, input.projectId, workflow.parentTaskId)))
      throw new WorkflowCapacityDeferredError('Waiting for project task capacity');
    throw error;
  }
}
