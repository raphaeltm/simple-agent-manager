import { TASK_TERMINAL_STATUSES, type TaskTerminalStatus } from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import type {
  AcceptedSnapshot,
  CheckpointRow,
  ReservedTaskSubmissionDependencies,
  ReservedTaskSubmissionIdentities,
  ReservedTaskSubmissionInput,
  ReservedTaskSubmissionResult,
  ResolvedReservedTaskSubmissionDependencies,
} from './reserved-task-submission-contracts';
import { commitD1Submission } from './reserved-task-submission-storage';
export type {
  ReservedTaskSubmissionConflictReason,
  ReservedTaskSubmissionDependencies,
  ReservedTaskSubmissionIdentities,
  ReservedTaskSubmissionInput,
  ReservedTaskSubmissionResult,
  ReservedTaskSubmissionSourceKind,
  ReservedTaskSubmissionSourceProvenance,
  ReservedTaskSubmissionStartState,
} from './reserved-task-submission-contracts';
import * as projectDataService from './project-data';
import {
  parseAcceptedSnapshot,
  prepareNewSubmission,
  reservedSubmissionGuardFromSnapshot,
  reservedTaskSubmissionConflict as conflict,
  revalidateBeforePhysicalStart,
  startInputFromSnapshot,
  submissionFingerprint,
  validateReservedTaskSubmissionInput,
} from './reserved-task-submission-intent';
import { ensureTaskRunnerStarted, startTaskRunnerDO } from './task-runner-do';
import {
  assertTaskRunnerStartGuard,
  TaskRunnerCreatorAuthorityRevokedError,
  TaskRunnerStartGuardRevokedError,
} from './task-runner-start-guard';
import { generateTaskTitle } from './task-title';

const TERMINAL_STATUSES = new Set<string>(TASK_TERMINAL_STATUSES);
const ALREADY_STARTED_STATUSES = new Set<string>(['delegated', 'in_progress']);

type Db = ReturnType<typeof drizzle<typeof schema>>;

function dbForEnv(env: Env): Db {
  return drizzle(env.DATABASE, { schema });
}

function dependencySet(
  deps: ReservedTaskSubmissionDependencies
): ResolvedReservedTaskSubmissionDependencies {
  const requireRepositoryAccess: ResolvedReservedTaskSubmissionDependencies['requireRepositoryAccess'] =
    deps.requireRepositoryAccess ??
    (async (...args) => {
      const { requireRepositoryOwnerAccess } = await import('../routes/projects/_helpers');
      return requireRepositoryOwnerAccess(...args);
    });

  return {
    startTaskRunner: deps.startTaskRunner ?? startTaskRunnerDO,
    ensureTaskRunnerStarted: deps.ensureTaskRunnerStarted ?? ensureTaskRunnerStarted,
    requireRepositoryAccess,
    now: deps.now ?? (() => new Date().toISOString()),
    generateTitle: deps.generateTitle ?? generateTaskTitle,
    afterD1Commit: deps.afterD1Commit ?? (() => undefined),
    afterProjectDataCommit: deps.afterProjectDataCommit ?? (() => undefined),
    afterRunnerStartConfirmed: deps.afterRunnerStartConfirmed ?? (() => undefined),
  };
}

async function readCheckpoint(db: D1Database, taskId: string): Promise<CheckpointRow | null> {
  return db
    .prepare(
      `SELECT c.task_id, c.project_id, c.user_id, c.chat_session_id, c.initial_message_id,
              c.initial_status_event_id, c.source_kind, c.source_id, c.source_execution_id,
              c.triggered_by, c.intent_fingerprint, c.accepted_snapshot_json, c.branch_name,
              c.task_title, c.checkpoint_state, c.project_data_committed_at,
              c.runner_start_attempted_at, c.runner_started_at,
              t.status AS task_status, t.error_message AS task_error_message,
              t.chat_session_id AS task_chat_session_id
         FROM task_submission_checkpoints c
         INNER JOIN tasks t ON t.id = c.task_id
        WHERE c.task_id = ?
        LIMIT 1`
    )
    .bind(taskId)
    .first<CheckpointRow>();
}

async function readTaskByIdentity(
  db: D1Database,
  input: ReservedTaskSubmissionInput
): Promise<{
  id: string;
  project_id: string;
  user_id: string;
  status: string;
  chat_session_id: string | null;
  error_message: string | null;
} | null> {
  return db
    .prepare(
      `SELECT id, project_id, user_id, status, chat_session_id, error_message
         FROM tasks
        WHERE id = ?
        LIMIT 1`
    )
    .bind(input.identities.taskId)
    .first<{
      id: string;
      project_id: string;
      user_id: string;
      status: string;
      chat_session_id: string | null;
      error_message: string | null;
    }>();
}

async function readCheckpointByReservedIdentity(
  db: D1Database,
  input: ReservedTaskSubmissionInput
): Promise<Pick<
  CheckpointRow,
  'task_id' | 'branch_name' | 'source_kind' | 'source_id' | 'source_execution_id'
> | null> {
  return db
    .prepare(
      `SELECT task_id, branch_name, source_kind, source_id, source_execution_id
         FROM task_submission_checkpoints
        WHERE chat_session_id = ?
           OR initial_message_id = ?
           OR initial_status_event_id = ?
           OR (
             project_id = ?
             AND source_kind = ?
             AND source_id = ?
             AND source_execution_id = ?
           )
        LIMIT 1`
    )
    .bind(
      input.identities.chatSessionId,
      input.identities.initialMessageId,
      input.identities.initialStatusEventId,
      input.projectId,
      input.source.kind,
      input.source.sourceId,
      input.source.sourceExecutionId
    )
    .first<
      Pick<
        CheckpointRow,
        'task_id' | 'branch_name' | 'source_kind' | 'source_id' | 'source_execution_id'
      >
    >();
}

async function validateTriggerReservation(
  db: D1Database,
  input: ReservedTaskSubmissionInput
): Promise<ReservedTaskSubmissionResult | null> {
  if (input.source.kind !== 'trigger') return null;
  const row = await db
    .prepare(
      `SELECT task_id
         FROM trigger_executions
        WHERE id = ?
          AND trigger_id = ?
          AND project_id = ?
        LIMIT 1`
    )
    .bind(input.source.sourceExecutionId, input.source.sourceId, input.projectId)
    .first<{ task_id: string | null }>();
  if (!row) {
    return conflict(
      input,
      'source_reservation_missing',
      `Trigger execution ${input.source.sourceExecutionId} is not reserved`
    );
  }
  if (row.task_id && row.task_id !== input.identities.taskId) {
    return conflict(
      input,
      'source_reservation_conflict',
      `Trigger execution ${input.source.sourceExecutionId} is already linked to task ${row.task_id}`
    );
  }
  return null;
}

async function markProjectDataCommitted(env: Env, taskId: string, now: string): Promise<void> {
  await env.DATABASE.prepare(
    `UPDATE task_submission_checkpoints
        SET checkpoint_state = CASE
              WHEN checkpoint_state = 'd1_committed' THEN 'project_data_committed'
              ELSE checkpoint_state
            END,
            project_data_committed_at = COALESCE(project_data_committed_at, ?),
            updated_at = ?
      WHERE task_id = ?`
  )
    .bind(now, now, taskId)
    .run();
}

async function markRunnerStartAttempted(env: Env, taskId: string, now: string): Promise<void> {
  await env.DATABASE.prepare(
    `UPDATE task_submission_checkpoints
        SET checkpoint_state = 'start_pending',
            runner_start_attempted_at = COALESCE(runner_start_attempted_at, ?),
            updated_at = ?
      WHERE task_id = ?`
  )
    .bind(now, now, taskId)
    .run();
}

async function markRunnerStarted(env: Env, taskId: string, now: string): Promise<void> {
  await env.DATABASE.prepare(
    `UPDATE task_submission_checkpoints
        SET checkpoint_state = 'start_confirmed',
            runner_started_at = COALESCE(runner_started_at, ?),
            updated_at = ?
      WHERE task_id = ?`
  )
    .bind(now, now, taskId)
    .run();
}

async function markTerminalObserved(env: Env, taskId: string, now: string): Promise<void> {
  await env.DATABASE.prepare(
    `UPDATE task_submission_checkpoints
        SET terminal_observed_at = COALESCE(terminal_observed_at, ?),
            updated_at = ?
      WHERE task_id = ?`
  )
    .bind(now, now, taskId)
    .run();
}

async function ensureProjectDataBoundary(
  env: Env,
  input: ReservedTaskSubmissionInput,
  snapshot: AcceptedSnapshot,
  deps: ResolvedReservedTaskSubmissionDependencies,
  reused: boolean
): Promise<ReservedTaskSubmissionResult | null> {
  try {
    const result = await projectDataService.createReservedTaskSessionWithInitialMessage(
      env,
      input.projectId,
      {
        sessionId: input.identities.chatSessionId,
        workspaceId: null,
        topic: snapshot.task.title,
        taskId: input.identities.taskId,
        createdByUserId: input.userId,
        initialMessageId: input.identities.initialMessageId,
        initialMessageRole: 'user',
        initialMessageContent: input.prompt,
        initialMessageToolMetadata: null,
      }
    );
    if (result.outcome === 'conflict') {
      return conflict(input, 'project_data_conflict', result.message, snapshot.task.outputBranch);
    }
    await markProjectDataCommitted(env, input.identities.taskId, deps.now());
    return null;
  } catch (error) {
    log.warn('reserved_task_submission.project_data_pending', {
      taskId: input.identities.taskId,
      projectId: input.projectId,
      sourceKind: input.source.kind,
      sourceId: input.source.sourceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      outcome: 'pending',
      taskId: input.identities.taskId,
      sessionId: input.identities.chatSessionId,
      branchName: snapshot.task.outputBranch,
      pendingAt: 'project_data',
      reason: 'ProjectData session/message commit could not be confirmed',
      reused,
    };
  }
}

function pendingUnconfirmedRunner(
  input: ReservedTaskSubmissionInput,
  snapshot: AcceptedSnapshot,
  reason: string,
  reused: boolean
): ReservedTaskSubmissionResult {
  return {
    outcome: 'pending',
    taskId: input.identities.taskId,
    sessionId: input.identities.chatSessionId,
    branchName: snapshot.task.outputBranch,
    pendingAt: 'task_runner_start',
    reason,
    reused,
  };
}

async function classifyUnconfirmedStart(
  env: Env,
  input: ReservedTaskSubmissionInput,
  snapshot: AcceptedSnapshot,
  reason: string,
  now: string,
  reused: boolean
): Promise<ReservedTaskSubmissionResult> {
  const observedOutcome = await classifyPersistedTaskOutcome(env, input, snapshot, now, reused);
  if (observedOutcome) return observedOutcome;

  try {
    await assertTaskRunnerStartGuard(env, reservedSubmissionGuardFromSnapshot(snapshot), {
      requireQueuedTask: true,
    });
  } catch (error) {
    if (error instanceof TaskRunnerStartGuardRevokedError) {
      const winner = await classifyPersistedTaskOutcome(env, input, snapshot, now, reused);
      if (winner) return winner;
      // A lost response plus a negative probe does not prove a dispatched start
      // never committed. Keep its slot until the durable runner/task reconciles.
      if (error instanceof TaskRunnerCreatorAuthorityRevokedError) {
        return pendingUnconfirmedRunner(input, snapshot, error.message, reused);
      }
      return conflict(input, 'authority_unavailable', error.message, snapshot.task.outputBranch);
    }
    return {
      outcome: 'pending',
      taskId: input.identities.taskId,
      sessionId: input.identities.chatSessionId,
      branchName: snapshot.task.outputBranch,
      pendingAt: 'task_runner_start',
      reason: error instanceof Error ? error.message : String(error),
      reused,
    };
  }
  return {
    outcome: 'pending',
    taskId: input.identities.taskId,
    sessionId: input.identities.chatSessionId,
    branchName: snapshot.task.outputBranch,
    pendingAt: 'task_runner_start',
    reason,
    reused,
  };
}

async function classifyPersistedTaskOutcome(
  env: Env,
  input: ReservedTaskSubmissionInput,
  snapshot: AcceptedSnapshot,
  now: string,
  reused: boolean
): Promise<ReservedTaskSubmissionResult | null> {
  const task = await readTaskByIdentity(env.DATABASE, input);
  if (
    task &&
    (task.project_id !== input.projectId ||
      task.user_id !== input.userId ||
      task.chat_session_id !== input.identities.chatSessionId)
  ) {
    return null;
  }
  if (task && TERMINAL_STATUSES.has(task.status)) {
    await markTerminalObserved(env, input.identities.taskId, now);
    return {
      outcome: 'terminal',
      taskId: input.identities.taskId,
      sessionId: input.identities.chatSessionId,
      branchName: snapshot.task.outputBranch,
      status: task.status as TaskTerminalStatus,
      reason: task.error_message,
      reused,
    };
  }
  if (task && ALREADY_STARTED_STATUSES.has(task.status)) {
    await markRunnerStarted(env, input.identities.taskId, now);
    return {
      outcome: 'admitted',
      taskId: input.identities.taskId,
      sessionId: input.identities.chatSessionId,
      branchName: snapshot.task.outputBranch,
      startState: 'already_started',
      reused,
    };
  }
  return null;
}

async function startOrConfirmRunner(
  env: Env,
  input: ReservedTaskSubmissionInput,
  snapshot: AcceptedSnapshot,
  deps: ResolvedReservedTaskSubmissionDependencies,
  reused: boolean,
  existingStartAttempted: boolean
): Promise<ReservedTaskSubmissionResult> {
  if (existingStartAttempted) {
    try {
      if (await deps.ensureTaskRunnerStarted(env, input.identities.taskId)) {
        await markRunnerStarted(env, input.identities.taskId, deps.now());
        return {
          outcome: 'admitted',
          taskId: input.identities.taskId,
          sessionId: input.identities.chatSessionId,
          branchName: snapshot.task.outputBranch,
          startState: 'confirmed_after_lost_ack',
          reused,
        };
      }
    } catch (error) {
      return {
        outcome: 'pending',
        taskId: input.identities.taskId,
        sessionId: input.identities.chatSessionId,
        branchName: snapshot.task.outputBranch,
        pendingAt: 'task_runner_start',
        reason: error instanceof Error ? error.message : String(error),
        reused,
      };
    }
  }

  await markRunnerStartAttempted(env, input.identities.taskId, deps.now());
  try {
    await deps.startTaskRunner(env, startInputFromSnapshot(snapshot));
    await markRunnerStarted(env, input.identities.taskId, deps.now());
    return {
      outcome: 'admitted',
      taskId: input.identities.taskId,
      sessionId: input.identities.chatSessionId,
      branchName: snapshot.task.outputBranch,
      startState: 'started',
      reused,
    };
  } catch (startError) {
    let durableStart: boolean;
    try {
      durableStart = await deps.ensureTaskRunnerStarted(env, input.identities.taskId);
    } catch (statusError) {
      log.warn('reserved_task_submission.task_runner_status_check_failed', {
        taskId: input.identities.taskId,
        projectId: input.projectId,
        sourceKind: input.source.kind,
        sourceId: input.source.sourceId,
        error: statusError instanceof Error ? statusError.message : String(statusError),
      });
      return {
        outcome: 'pending',
        taskId: input.identities.taskId,
        sessionId: input.identities.chatSessionId,
        branchName: snapshot.task.outputBranch,
        pendingAt: 'task_runner_start',
        reason: 'TaskRunner start confirmation is unavailable',
        reused,
      };
    }
    if (durableStart) {
      await markRunnerStarted(env, input.identities.taskId, deps.now());
      log.warn('reserved_task_submission.task_runner_start_ack_lost', {
        taskId: input.identities.taskId,
        projectId: input.projectId,
        sourceKind: input.source.kind,
        sourceId: input.source.sourceId,
      });
      return {
        outcome: 'admitted',
        taskId: input.identities.taskId,
        sessionId: input.identities.chatSessionId,
        branchName: snapshot.task.outputBranch,
        startState: 'confirmed_after_lost_ack',
        reused,
      };
    }
    const message = startError instanceof Error ? startError.message : String(startError);
    return classifyUnconfirmedStart(
      env,
      input,
      snapshot,
      `Task runner startup could not be confirmed: ${message}`,
      deps.now(),
      reused
    );
  }
}

async function runTaskRunnerBoundary(
  env: Env,
  input: ReservedTaskSubmissionInput,
  snapshot: AcceptedSnapshot,
  deps: ResolvedReservedTaskSubmissionDependencies,
  reused: boolean,
  existingStartAttempted: boolean
): Promise<ReservedTaskSubmissionResult> {
  const result = await startOrConfirmRunner(
    env,
    input,
    snapshot,
    deps,
    reused,
    existingStartAttempted
  );
  if (result.outcome === 'admitted' && result.startState !== 'already_started') {
    await deps.afterRunnerStartConfirmed();
  }
  return result;
}

async function reconcileCheckpoint(
  env: Env,
  db: Db,
  input: ReservedTaskSubmissionInput,
  row: CheckpointRow,
  fingerprint: string,
  deps: ResolvedReservedTaskSubmissionDependencies
): Promise<ReservedTaskSubmissionResult> {
  if (row.intent_fingerprint !== fingerprint) {
    return conflict(
      input,
      'intent_fingerprint_mismatch',
      `Task identity ${input.identities.taskId} is already reserved for a different submission intent`,
      row.branch_name
    );
  }
  if (
    row.project_id !== input.projectId ||
    row.user_id !== input.userId ||
    row.chat_session_id !== input.identities.chatSessionId ||
    row.initial_message_id !== input.identities.initialMessageId ||
    row.initial_status_event_id !== input.identities.initialStatusEventId ||
    row.source_kind !== input.source.kind ||
    row.source_id !== input.source.sourceId ||
    row.source_execution_id !== input.source.sourceExecutionId ||
    row.triggered_by !== input.source.triggeredBy ||
    row.task_chat_session_id !== input.identities.chatSessionId
  ) {
    return conflict(
      input,
      'identity_reuse_conflict',
      `Task identity ${input.identities.taskId} checkpoint does not match the reserved identities`,
      row.branch_name
    );
  }
  const snapshot = parseAcceptedSnapshot(row);
  if (!snapshot) {
    return conflict(
      input,
      'malformed_checkpoint',
      `Task identity ${input.identities.taskId} has a malformed submission checkpoint`,
      row.branch_name
    );
  }
  if (TERMINAL_STATUSES.has(row.task_status)) {
    await markTerminalObserved(env, input.identities.taskId, deps.now());
    return {
      outcome: 'terminal',
      taskId: input.identities.taskId,
      sessionId: input.identities.chatSessionId,
      branchName: row.branch_name,
      status: row.task_status as TaskTerminalStatus,
      reason: row.task_error_message,
      reused: true,
    };
  }
  if (ALREADY_STARTED_STATUSES.has(row.task_status)) {
    return {
      outcome: 'admitted',
      taskId: input.identities.taskId,
      sessionId: input.identities.chatSessionId,
      branchName: row.branch_name,
      startState: 'already_started',
      reused: true,
    };
  }

  const existingStartAttempted =
    row.runner_start_attempted_at !== null || row.runner_started_at !== null;
  if (existingStartAttempted) {
    // Reconcile an existing receipt before enforcing authority for NEW work.
    try {
      if (await deps.ensureTaskRunnerStarted(env, input.identities.taskId)) {
        await markRunnerStarted(env, input.identities.taskId, deps.now());
        return {
          outcome: 'admitted',
          taskId: input.identities.taskId,
          sessionId: input.identities.chatSessionId,
          branchName: row.branch_name,
          startState: 'confirmed_after_lost_ack',
          reused: true,
        };
      }
    } catch (error) {
      return pendingUnconfirmedRunner(
        input,
        snapshot,
        error instanceof Error ? error.message : String(error),
        true
      );
    }
  }

  const projectDataPending = await ensureProjectDataBoundary(env, input, snapshot, deps, true);
  if (projectDataPending) return projectDataPending;
  await deps.afterProjectDataCommit();

  const revalidationConflict = await revalidateBeforePhysicalStart(
    env,
    db,
    input,
    snapshot,
    deps,
    true
  );
  if (revalidationConflict) {
    if (
      existingStartAttempted &&
      input.source.kind !== 'trigger' &&
      revalidationConflict.outcome === 'conflict' &&
      revalidationConflict.reason === 'authority_unavailable'
    ) {
      return pendingUnconfirmedRunner(input, snapshot, revalidationConflict.message, true);
    }
    return revalidationConflict;
  }

  return runTaskRunnerBoundary(env, input, snapshot, deps, true, existingStartAttempted);
}

async function reconcileD1InsertConflict(
  env: Env,
  db: Db,
  input: ReservedTaskSubmissionInput,
  fingerprint: string,
  deps: ResolvedReservedTaskSubmissionDependencies,
  error: unknown
): Promise<ReservedTaskSubmissionResult> {
  const row = await readCheckpoint(env.DATABASE, input.identities.taskId);
  if (row) return reconcileCheckpoint(env, db, input, row, fingerprint, deps);

  const identityCheckpoint = await readCheckpointByReservedIdentity(env.DATABASE, input);
  if (identityCheckpoint) {
    const sourceMatches =
      identityCheckpoint.source_kind === input.source.kind &&
      identityCheckpoint.source_id === input.source.sourceId &&
      identityCheckpoint.source_execution_id === input.source.sourceExecutionId;
    return conflict(
      input,
      sourceMatches ? 'source_reservation_conflict' : 'identity_reuse_conflict',
      sourceMatches
        ? `Source reservation ${input.source.kind}:${input.source.sourceExecutionId} is already linked to task ${identityCheckpoint.task_id}`
        : 'One or more reserved identities already belong to a different task submission',
      identityCheckpoint.branch_name
    );
  }

  const task = await readTaskByIdentity(env.DATABASE, input);
  if (task) {
    return conflict(
      input,
      'identity_reuse_conflict',
      `Task identity ${input.identities.taskId} already exists without a reserved submission checkpoint`,
      null
    );
  }
  throw error;
}

export async function submitReservedTask(
  env: Env,
  input: ReservedTaskSubmissionInput,
  dependencyOverrides: ReservedTaskSubmissionDependencies = {}
): Promise<ReservedTaskSubmissionResult> {
  const validationError = validateReservedTaskSubmissionInput(input, env);
  if (validationError) return conflict(input, 'invalid_input', validationError);

  const deps = dependencySet(dependencyOverrides);
  const db = dbForEnv(env);
  const fingerprint = await submissionFingerprint(input);

  const existing = await readCheckpoint(env.DATABASE, input.identities.taskId);
  if (existing) {
    return reconcileCheckpoint(env, db, input, existing, fingerprint, deps);
  }

  const sourceConflict = await validateTriggerReservation(env.DATABASE, input);
  if (sourceConflict) return sourceConflict;

  const prepared = await prepareNewSubmission(env, db, input, fingerprint, deps);
  if ('outcome' in prepared) return prepared;

  try {
    await commitD1Submission(env, input, fingerprint, prepared, deps.now());
  } catch (error) {
    return reconcileD1InsertConflict(env, db, input, fingerprint, deps, error);
  }
  await deps.afterD1Commit();

  const projectDataPending = await ensureProjectDataBoundary(
    env,
    input,
    prepared.snapshot,
    deps,
    false
  );
  if (projectDataPending) return projectDataPending;
  await deps.afterProjectDataCommit();

  const revalidationConflict = await revalidateBeforePhysicalStart(
    env,
    db,
    input,
    prepared.snapshot,
    deps,
    false
  );
  if (revalidationConflict) return revalidationConflict;

  return runTaskRunnerBoundary(env, input, prepared.snapshot, deps, false, false);
}

export function reservedIdentitiesForTriggerExecution(
  triggerExecutionId: string
): ReservedTaskSubmissionIdentities {
  return {
    taskId: triggerExecutionId,
    chatSessionId: `chat_${triggerExecutionId}`,
    initialMessageId: `msg_${triggerExecutionId}`,
    initialStatusEventId: `status_${triggerExecutionId}`,
  };
}
