/**
 * The TaskRunner's commit of a delegated task to `in_progress`, split out of
 * `state-machine.ts` (`.claude/rules/18-file-size-limits.md`). For a wake, the same D1 batch
 * records the restore on the retired source's preservation receipt.
 */
import { log } from '../../lib/logger';
import { recordTaskLifecycleEventBestEffort } from '../../services/project-lifecycle-events';
import { restoredSourceReceiptStampStatement } from '../../services/workspace-preservation-receipt';
import { recordRunnerPhase } from './phase-timings';
import { failRecoveryLifecycle } from './recovery-failure-cleanup';
import { failTask } from './state-machine';
import type { TaskRunnerContext, TaskRunnerState } from './types';
import { notifyWakeSettled } from './wake-progress-notifier';

/**
 * Transition the task to in_progress and mark the DO as done.
 */
export async function transitionToInProgress(
  state: TaskRunnerState,
  rc: TaskRunnerContext
): Promise<void> {
  const now = new Date().toISOString();
  const recoverySourceTaskId = state.config.recoverySourceTaskId ?? null;
  const recoveryChatSessionId = state.config.resumeSnapshotChatSessionId ?? null;
  const readiness =
    recoveryChatSessionId &&
    state.config.recoveryAttemptId &&
    state.stepResults.workspaceId &&
    state.stepResults.agentSessionId
      ? {
          projectId: state.projectId,
          chatSessionId: recoveryChatSessionId,
          workspaceId: state.stepResults.workspaceId,
          agentSessionId: state.stepResults.agentSessionId,
          fence: {
            runtime: 'vm' as const,
            taskId: state.taskId,
            recoveryAttemptId: state.config.recoveryAttemptId,
          },
        }
      : undefined;

  // Optimistic lock: only transition if still delegated. Guarded snapshot
  // recovery also proves the exact source and snapshot claim are live in the
  // same D1 statement that commits the replacement to in_progress.
  const transition = rc.env.DATABASE.prepare(
    `UPDATE tasks
        SET status = 'in_progress', started_at = ?, execution_step = 'running', updated_at = ?
      WHERE id = ? AND status = 'delegated'
        AND (
          ? IS NULL
          OR EXISTS (
            SELECT 1
              FROM tasks recovery
              JOIN tasks source
                ON source.id = ?
               AND (source.id = recovery.id OR source.id = recovery.recovery_source_task_id)
               AND source.project_id = recovery.project_id
              JOIN session_snapshots snapshot
                ON snapshot.chat_session_id = recovery.chat_session_id
               AND snapshot.project_id = recovery.project_id
               AND snapshot.recovery_task_id = recovery.id
             WHERE recovery.id = ?
               AND recovery.project_id = ?
               AND recovery.chat_session_id = ?
               AND (source.id = recovery.id OR recovery.triggered_by = 'session-recovery')
               AND source.status NOT IN ('completed', 'failed', 'cancelled')
               AND snapshot.recovery_status IN ('waking', 'restored')
          )
        )
        AND (? IS NULL OR EXISTS (
          SELECT 1 FROM session_snapshots snapshot
           WHERE snapshot.chat_session_id = ? AND snapshot.project_id = ?
             AND snapshot.recovery_task_id = tasks.id AND snapshot.recovery_attempt_id = ?
        ))`
  ).bind(
    now,
    now,
    state.taskId,
    recoverySourceTaskId,
    recoverySourceTaskId,
    state.taskId,
    state.projectId,
    recoveryChatSessionId,
    state.config.recoveryAttemptId ?? null,
    recoveryChatSessionId,
    state.projectId,
    state.config.recoveryAttemptId ?? null
  );
  // A wake's commit also records the restore on the retired source's receipt, in the same
  // transaction: a source is released only by a committed wake whose restore brought back the
  // snapshot's files, and the record cannot be lost before the release
  // (`releaseRestoredSourceWorkspaces`).
  const [result] =
    recoveryChatSessionId &&
    state.stepResults.workspaceId &&
    state.stepResults.snapshotRestoreComplete === true
      ? await rc.env.DATABASE.batch([
          transition,
          restoredSourceReceiptStampStatement(
            rc.env.DATABASE,
            {
              chatSessionId: recoveryChatSessionId,
              restoredWorkspaceId: state.stepResults.workspaceId,
              snapshotGeneration: state.stepResults.restoredSnapshotGeneration,
            },
            now,
            { taskId: state.taskId, startedAt: now }
          ),
        ])
      : [await transition.run()];

  if (!result?.meta.changes || result.meta.changes === 0) {
    const authoritative = await rc.env.DATABASE.prepare(`SELECT status FROM tasks WHERE id = ?`)
      .bind(state.taskId)
      .first<{ status: string }>();
    log.warn('task_runner_do.aborted_by_recovery', {
      taskId: state.taskId,
      step: 'in_progress_transition',
      authoritativeStatus: authoritative?.status ?? null,
    });
    if (authoritative?.status === 'in_progress') {
      // Another runner already committed the handoff. The wake is still over from
      // the watcher's point of view, so clear the banner here too.
      rc.ctx.waitUntil(
        notifyWakeSettled({
          env: rc.env,
          projectId: state.projectId,
          chatSessionId: recoveryChatSessionId,
          status: 'restored',
          readiness,
          attemptId: state.config.recoveryAttemptId,
        })
      );
      recordRunnerPhase(state, 'success');
      state.currentStep = 'running';
      state.completed = true;
      await rc.ctx.storage.put('state', state);
      return;
    }
    if (!authoritative || ['completed', 'failed', 'cancelled'].includes(authoritative.status)) {
      if (recoveryChatSessionId) {
        await failRecoveryLifecycle(
          state,
          'Session recovery authority was revoked before agent handoff committed.',
          rc
        );
        // A wake that will never finish must not leave a spinner running.
        rc.ctx.waitUntil(
          notifyWakeSettled({
            env: rc.env,
            projectId: state.projectId,
            chatSessionId: recoveryChatSessionId,
            status: 'failed',
            attemptId: state.config.recoveryAttemptId,
          })
        );
      }
      state.completed = true;
      await rc.ctx.storage.put('state', state);
      return;
    }
    await failTask(state, 'Task orchestration was superseded before agent handoff completed.', rc);
    return;
  }

  // The agent session is live, so the wake is over. This is the ONLY terminal
  // emit on the happy path: the raw guarded UPDATE above bypasses
  // `updateD1ExecutionStep`, and the alarm dispatcher treats `running` as a
  // terminal no-op step, so the intermediate-phase choke point never fires here.
  rc.ctx.waitUntil(
    notifyWakeSettled({
      env: rc.env,
      projectId: state.projectId,
      chatSessionId: recoveryChatSessionId,
      status: 'restored',
      readiness,
      attemptId: state.config.recoveryAttemptId,
    })
  );

  // Record status event
  const { ulid } = await import('../../lib/ulid');
  await rc.env.DATABASE.prepare(
    `INSERT INTO task_status_events (id, task_id, from_status, to_status, actor_type, actor_id, reason, created_at)
     VALUES (?, ?, 'delegated', 'in_progress', 'system', NULL, ?, ?)`
  )
    .bind(
      ulid(),
      state.taskId,
      `Agent session ${state.stepResults.agentSessionId} created. Task execution started.`,
      now
    )
    .run();

  rc.ctx.waitUntil(
    recordTaskLifecycleEventBestEffort(rc.env, {
      projectId: state.projectId,
      taskId: state.taskId,
      status: 'in_progress',
      fromStatus: 'delegated',
      workspaceId: state.stepResults.workspaceId,
      sessionId: state.stepResults.chatSessionId,
      nodeId: state.stepResults.nodeId,
      agentSessionId: state.stepResults.agentSessionId,
      source: 'task_runner.transition_to_in_progress',
      occurredAt: now,
    })
  );

  log.info('task_runner_do.step.in_progress', {
    taskId: state.taskId,
    workspaceId: state.stepResults.workspaceId,
    nodeId: state.stepResults.nodeId,
    agentSessionId: state.stepResults.agentSessionId,
    autoProvisioned: state.stepResults.autoProvisioned,
    totalDurationMs: Date.now() - state.createdAt,
  });

  // Best-effort: inject "started" message into chat so user gets feedback
  if (state.stepResults.chatSessionId && state.projectId) {
    try {
      const { persistMessage } = await import('../../services/project-data');
      await persistMessage(
        rc.env,
        state.projectId,
        state.stepResults.chatSessionId,
        'system',
        'Task execution started — the agent is working on your request.',
        null
      );
    } catch (chatErr) {
      log.error('task_runner_do.chat_started_inject_failed', {
        taskId: state.taskId,
        sessionId: state.stepResults.chatSessionId,
        error: chatErr instanceof Error ? chatErr.message : String(chatErr),
      });
    }
  }

  recordRunnerPhase(state, 'success');
  state.currentStep = 'running';
  state.completed = true;
  await rc.ctx.storage.put('state', state);
}
