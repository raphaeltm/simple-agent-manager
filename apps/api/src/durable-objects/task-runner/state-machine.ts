/**
 * State machine helpers for the TaskRunner DO.
 *
 * Handles session linking, task status transitions (in_progress, failed),
 * cleanup on failure, and D1 execution step updates.
 */
import { log } from '../../lib/logger';
import { persistError, redactSensitiveData } from '../../services/observability';
import { recordTaskLifecycleEventBestEffort } from '../../services/project-lifecycle-events';
import { restoreSessionRecoveryHandoff } from '../../services/session-recovery-authority';
import {
  createProjectEventTaskTerminalTransitionHook,
  createTaskWaitTerminalTransitionHook,
  runTaskTerminalTransitionHooks,
} from '../../services/task-terminal-transition-hooks';
import { syncTriggerExecutionStatus } from '../../services/trigger-execution-sync';
import { cancelVmTaskAdmission, wakeVmAdmissionWaiters } from '../../services/vm-admission-control';
import { finalizeWorkspaceLifecycleClosure } from '../../services/workspace-lifecycle-finalizer';
import { releaseClaimedWarmNode } from './node-selection';
import {
  canMutateProjectDataFailureSession,
  projectDataGuardForReservedSubmission,
} from './reserved-project-data-guard';
import { ensureSessionLinked as ensureSessionLinkedImpl } from './session-linking';
import type { TaskRunnerContext, TaskRunnerState } from './types';
import { notifyWakeSettled } from './wake-progress-notifier';
import { recoverReservedWorkspaceAllocationForCleanup } from './workspace-reserved-allocation';

// =========================================================================
// Session linking
// =========================================================================

export async function ensureSessionLinked(
  state: TaskRunnerState,
  workspaceId: string,
  rc: TaskRunnerContext
): Promise<void> {
  await ensureSessionLinkedImpl(state, workspaceId, rc);
}

// =========================================================================
// Task status transitions
// =========================================================================

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

  // Optimistic lock: only transition if still delegated. Guarded snapshot
  // recovery also proves the exact source and snapshot claim are live in the
  // same D1 statement that commits the replacement to in_progress.
  const result = await rc.env.DATABASE.prepare(
    `UPDATE tasks
        SET status = 'in_progress', started_at = ?, execution_step = 'running', updated_at = ?
      WHERE id = ? AND status = 'delegated'
        AND (
          ? IS NULL
          OR EXISTS (
            SELECT 1
              FROM tasks recovery
              JOIN tasks source
                ON source.id = recovery.recovery_source_task_id
               AND source.project_id = recovery.project_id
              JOIN session_snapshots snapshot
                ON snapshot.chat_session_id = recovery.chat_session_id
               AND snapshot.project_id = recovery.project_id
               AND snapshot.recovery_task_id = recovery.id
             WHERE recovery.id = ?
               AND recovery.recovery_source_task_id = ?
               AND recovery.project_id = ?
               AND recovery.chat_session_id = ?
               AND recovery.triggered_by = 'session-recovery'
               AND source.status NOT IN ('completed', 'failed', 'cancelled')
               AND snapshot.recovery_status IN ('waking', 'restored')
          )
        )`
  )
    .bind(
      now,
      now,
      state.taskId,
      recoverySourceTaskId,
      state.taskId,
      recoverySourceTaskId,
      state.projectId,
      recoveryChatSessionId
    )
    .run();

  if (!result.meta.changes || result.meta.changes === 0) {
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
        })
      );
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
    })
  );

  state.currentStep = 'running';
  state.completed = true;
  await rc.ctx.storage.put('state', state);
}

/**
 * Fail the task, clean up resources, record error, mark DO as complete.
 */
export async function failTask(
  state: TaskRunnerState,
  errorMessage: string,
  rc: TaskRunnerContext
): Promise<void> {
  const now = new Date().toISOString();

  log.error('task_runner_do.task_failed', {
    taskId: state.taskId,
    step: state.currentStep,
    errorMessage,
    totalDurationMs: Date.now() - state.createdAt,
  });

  // Check current status before failing (idempotent)
  const task = await rc.env.DATABASE.prepare(
    `SELECT status, mission_id, parent_task_id FROM tasks WHERE id = ?`
  )
    .bind(state.taskId)
    .first<{ status: string; mission_id: string | null; parent_task_id: string | null }>();

  const currentStatus = task?.status;
  if (
    currentStatus === 'failed' ||
    currentStatus === 'completed' ||
    currentStatus === 'cancelled'
  ) {
    await recoverReservedWorkspaceAllocationForCleanup(state, rc);
    if (state.config.resumeSnapshotChatSessionId) {
      await failRecoveryLifecycle(state, errorMessage, rc);
    }
    await cleanupOnFailure(state, rc, currentStatus === 'cancelled' ? 'cancelled' : 'task_failed');
    // Already terminal — preserve the winning terminal task status.
    state.completed = true;
    await rc.ctx.storage.put('state', state);
    return;
  }

  // Fail the task. The status predicate makes this idempotent against a
  // concurrent terminal transition that lands between the check above and this
  // write — never clobber an already-terminal row (completed/failed/cancelled).
  const failureTransition = await rc.env.DATABASE.prepare(
    `UPDATE tasks SET status = 'failed', execution_step = NULL, error_message = ?, completed_at = ?, updated_at = ?
     WHERE id = ? AND status NOT IN ('completed', 'failed', 'cancelled')`
  )
    .bind(errorMessage, now, now, state.taskId)
    .run();

  if (!failureTransition.meta.changes) {
    await recoverReservedWorkspaceAllocationForCleanup(state, rc);
    if (state.config.resumeSnapshotChatSessionId) {
      await failRecoveryLifecycle(state, errorMessage, rc);
    }
    await cleanupOnFailure(state, rc);
    state.completed = true;
    await rc.ctx.storage.put('state', state);
    return;
  }

  // Sync trigger execution status (best-effort) — without this, cron triggers
  // with skipIfRunning=true permanently stop firing because the execution stays 'running'.
  await syncTriggerExecutionStatus(rc.env.DATABASE, state.taskId, 'failed', errorMessage);

  const { ulid } = await import('../../lib/ulid');
  const failureEventId = ulid();
  await rc.env.DATABASE.prepare(
    `INSERT INTO task_status_events (id, task_id, from_status, to_status, actor_type, actor_id, reason, created_at)
     VALUES (?, ?, ?, 'failed', 'system', NULL, ?, ?)`
  )
    .bind(failureEventId, state.taskId, currentStatus || 'queued', errorMessage, now)
    .run();

  await runTaskTerminalTransitionHooks(
    {
      transitionId: failureEventId,
      taskId: state.taskId,
      projectId: state.projectId,
      parentTaskId: task?.parent_task_id ?? null,
      status: 'failed',
      reason: errorMessage,
      occurredAt: now,
      source: 'task_runner.fail_task',
    },
    [
      createTaskWaitTerminalTransitionHook(rc.env),
      createProjectEventTaskTerminalTransitionHook(rc.env, { captureAtHook: true }),
    ]
  );

  // Notify orchestrator of task failure (best-effort) — triggers scheduling cycle
  // so dependent tasks can react to the failure (e.g., unblock blocked_dependency tasks)
  if (task?.mission_id && state.projectId) {
    try {
      const { notifyTaskEvent } = await import('../../services/project-orchestrator');
      await notifyTaskEvent(rc.env, state.projectId, {
        taskId: state.taskId,
        missionId: task.mission_id,
        event: 'failed',
        timestamp: Date.now(),
      });
    } catch (err) {
      log.warn('task_runner_do.orchestrator_notify_failed', {
        taskId: state.taskId,
        missionId: task.mission_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Write bounded, redacted diagnostics without allowing observability to affect task failure.
  const safeError = redactSensitiveData({
    message: `Task ${state.taskId} failed at step ${state.currentStep}: ${errorMessage}`,
    context: {
      taskId: state.taskId,
      projectId: state.projectId,
      step: state.currentStep,
      retryCount: state.retryCount,
    },
  });
  await persistError(
    rc.env.OBSERVABILITY_DATABASE,
    {
      source: 'api',
      level: 'error',
      message: safeError.message,
      context: safeError.context,
      userId: state.userId,
      nodeId: state.stepResults.nodeId,
      workspaceId: state.stepResults.workspaceId,
      taskId: state.taskId,
      sessionId: state.stepResults.chatSessionId,
    },
    rc.env
  );

  const recoverySessionId = state.config.resumeSnapshotChatSessionId ?? null;
  if (recoverySessionId) {
    await failRecoveryLifecycle(state, errorMessage, rc);
  } else if (state.stepResults.chatSessionId && state.projectId) {
    // Ordinary task failures are terminal for their chat. The UI also
    // cross-references task.status, but update ProjectData for consistency.
    const sessionId = state.stepResults.chatSessionId;
    const projectId = state.projectId;
    if (await canMutateProjectDataFailureSession(state, rc, sessionId)) {
      const maxAttempts = 2;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const { persistMessage, failSession } = await import('../../services/project-data');
          const sessionGuard = projectDataGuardForReservedSubmission(state);
          await persistMessage(
            rc.env,
            projectId,
            sessionId,
            'system',
            `Task failed at step "${state.currentStep}": ${errorMessage}`,
            null,
            undefined,
            sessionGuard
          );
          await failSession(rc.env, projectId, sessionId, errorMessage, sessionGuard);
          break; // success
        } catch (chatErr) {
          log.error('task_runner_do.chat_session_fail_attempt', {
            taskId: state.taskId,
            sessionId,
            attempt,
            maxAttempts,
            error: chatErr instanceof Error ? chatErr.message : String(chatErr),
          });
          if (attempt < maxAttempts) {
            await new Promise((r) => setTimeout(r, 100));
          }
        }
      }
    }
  }

  // Revoke MCP token so it cannot be used after task failure
  if (state.stepResults.mcpToken) {
    try {
      const { revokeMcpToken } = await import('../../services/mcp-token');
      await revokeMcpToken(rc.env.KV, state.stepResults.mcpToken);
    } catch (err) {
      log.warn('task_runner_do.mcp_token_revoke_failed', {
        taskId: state.taskId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    state.stepResults.mcpToken = null;
  }

  await recoverReservedWorkspaceAllocationForCleanup(state, rc);

  // Best-effort cleanup
  await cleanupOnFailure(state, rc);

  state.completed = true;
  await rc.ctx.storage.put('state', state);
}

async function failRecoveryLifecycle(
  state: TaskRunnerState,
  errorMessage: string,
  rc: TaskRunnerContext
): Promise<void> {
  const recoverySessionId = state.config.resumeSnapshotChatSessionId;
  if (!recoverySessionId) return;

  // Ownership restoration is a correctness boundary, not best-effort cleanup:
  // if D1 is temporarily unavailable, let the DO alarm retry instead of
  // completing with a terminal replacement still owning the durable chat.
  await restoreSessionRecoveryHandoff(rc.env.DATABASE, state.taskId, recoverySessionId);
  const { drizzle } = await import('drizzle-orm/d1');
  const schema = await import('../../db/schema');
  const { failSessionSnapshotRecovery } = await import('../../services/session-snapshots');
  await failSessionSnapshotRecovery(
    drizzle(rc.env.DATABASE, { schema }),
    rc.env,
    recoverySessionId,
    state.taskId,
    errorMessage
  );

  // The failed task owns only the replacement runtime. Preserve the original
  // conversation as sleeping so another bounded wake attempt can reuse the
  // verified snapshot. This also compensates if ProjectData accepted the wake
  // immediately before a later D1 recovery-commit failure.
  try {
    const { sleepSession } = await import('../../services/project-data');
    await sleepSession(rc.env, state.projectId, recoverySessionId);
  } catch (chatErr) {
    log.warn('task_runner_do.session_recovery_resleep_failed', {
      taskId: state.taskId,
      sessionId: recoverySessionId,
      error: chatErr instanceof Error ? chatErr.message : String(chatErr),
    });
  }
}

// =========================================================================
// Cleanup
// =========================================================================

/**
 * Best-effort cleanup: stop workspace, mark node warm if auto-provisioned.
 */
export async function cleanupOnFailure(
  state: TaskRunnerState,
  rc: TaskRunnerContext,
  admissionCancelReason: 'task_failed' | 'cancelled' = 'task_failed'
): Promise<void> {
  const now = new Date().toISOString();

  await cancelVmTaskAdmission(rc.env, state.taskId, admissionCancelReason).catch((err) => {
    log.warn('task_runner_do.cleanup.admission_cancel_failed', {
      taskId: state.taskId,
      error: err instanceof Error ? err.message : String(err),
    });
  });
  state.admissionScopeKey = null;
  state.admissionLeaseToken = null;

  const persistedWarmClaim = await rc.env.DATABASE.prepare(
    `SELECT claimed_warm_node_id FROM tasks WHERE id = ?`
  )
    .bind(state.taskId)
    .first<{ claimed_warm_node_id: string | null }>()
    .catch(() => null);
  const claimedWarmNodeId =
    state.stepResults.claimedWarmNodeId ?? persistedWarmClaim?.claimed_warm_node_id ?? null;
  if (claimedWarmNodeId) {
    await releaseClaimedWarmNode(state, rc, claimedWarmNodeId).catch((error) => {
      log.error('task_runner_do.cleanup.warm_claim_release_failed', {
        taskId: state.taskId,
        nodeId: claimedWarmNodeId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  let workspaceNeedsRuntimeStop = Boolean(
    state.stepResults.workspaceId && state.stepResults.nodeId
  );
  if (state.stepResults.workspaceId && state.stepResults.nodeId) {
    const workspace = await rc.env.DATABASE.prepare(
      `SELECT status, dispatched_at AS dispatchedAt FROM workspaces WHERE id = ?`
    )
      .bind(state.stepResults.workspaceId)
      .first<{ status: string; dispatchedAt: string | null }>();

    if (workspace?.status === 'creating' && !workspace.dispatchedAt) {
      await rc.env.DATABASE.prepare(
        `UPDATE workspaces SET status = 'stopped', error_message = ?, updated_at = ? WHERE id = ?`
      )
        .bind(
          `Task ended before workspace dispatch during ${state.currentStep}`,
          now,
          state.stepResults.workspaceId
        )
        .run();
      workspaceNeedsRuntimeStop = false;
    }
  }

  if (workspaceNeedsRuntimeStop && state.stepResults.workspaceId && state.stepResults.nodeId) {
    const node = await rc.env.DATABASE.prepare(
      `SELECT runtime FROM nodes WHERE id = ? AND user_id = ?`
    )
      .bind(state.stepResults.nodeId, state.userId)
      .first<{ runtime: string | null }>();

    if (node?.runtime === 'cf-container') {
      try {
        const { cleanupTaskRun } = await import('../../services/task-runner');
        await cleanupTaskRun(state.taskId, rc.env, state.config.projectScaling?.warmNodeTimeoutMs);
      } catch (err) {
        log.error('task_runner_do.cleanup.cf_container_cleanup_failed', {
          taskId: state.taskId,
          nodeId: state.stepResults.nodeId,
          workspaceId: state.stepResults.workspaceId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }
  }

  // Stop workspace if one was created
  if (workspaceNeedsRuntimeStop && state.stepResults.workspaceId && state.stepResults.nodeId) {
    try {
      const { stopWorkspaceOnNode } = await import('../../services/node-agent');
      await stopWorkspaceOnNode(
        state.stepResults.nodeId,
        state.stepResults.workspaceId,
        rc.env,
        state.userId
      );
    } catch (err) {
      log.error('task_runner_do.cleanup.workspace_stop_failed', {
        taskId: state.taskId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    await rc.env.DATABASE.prepare(
      `UPDATE workspaces SET status = 'stopped', updated_at = ? WHERE id = ?`
    )
      .bind(now, state.stepResults.workspaceId)
      .run();

    try {
      await finalizeWorkspaceLifecycleClosure(rc.env, {
        workspaceIds: [state.stepResults.workspaceId],
        userId: state.userId,
        agentSessionStatus: 'failed',
        errorMessage:
          state.workspaceErrorMessage ?? `Task failed during ${state.currentStep} cleanup`,
        nowIso: now,
        reason: 'task_runner_do_cleanup_on_failure',
      });
    } catch (err) {
      log.error('task_runner_do.cleanup.lifecycle_finalizer_failed', {
        taskId: state.taskId,
        workspaceId: state.stepResults.workspaceId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Schedule automatic deletion after TTL (best-effort)
    try {
      const doId = rc.env.NODE_LIFECYCLE.idFromName(state.stepResults.nodeId);
      const stub = rc.env.NODE_LIFECYCLE.get(doId);
      await (
        stub as unknown as import('../node-lifecycle').NodeLifecycle
      ).scheduleWorkspaceDeletion(
        state.stepResults.nodeId,
        state.stepResults.workspaceId,
        state.userId
      );
    } catch (err) {
      log.warn('task_runner_do.cleanup.schedule_deletion_failed', {
        taskId: state.taskId,
        workspaceId: state.stepResults.workspaceId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Clean up auto-provisioned node. If a workspace exists, cleanupTaskRun
  // handles checking for other workspaces and marking the node warm.
  // If no workspace was created (failure during provisioning), we still need
  // to mark the auto-provisioned node as warm directly via NodeLifecycle DO.
  if (state.stepResults.autoProvisioned && state.stepResults.nodeId) {
    if (state.config.resumeSnapshotChatSessionId && !state.stepResults.workspaceId) {
      try {
        const { deleteNodeResourcesStrict } = await import('../../services/nodes');
        await deleteNodeResourcesStrict(state.stepResults.nodeId, state.userId, rc.env);
        log.info('task_runner_do.cleanup.revoked_recovery_node_destroyed', {
          taskId: state.taskId,
          nodeId: state.stepResults.nodeId,
        });
      } catch (err) {
        log.error('task_runner_do.cleanup.revoked_recovery_node_destroy_failed', {
          taskId: state.taskId,
          nodeId: state.stepResults.nodeId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }
    if (state.stepResults.workspaceId) {
      try {
        const { cleanupTaskRun } = await import('../../services/task-runner');
        await cleanupTaskRun(state.taskId, rc.env, state.config.projectScaling?.warmNodeTimeoutMs);
      } catch (err) {
        log.error('task_runner_do.cleanup.node_cleanup_failed', {
          taskId: state.taskId,
          nodeId: state.stepResults.nodeId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      // No workspace — mark node warm directly since cleanupTaskRun
      // expects a workspace_id on the task to work properly.
      // Use markIdle(nodeId, userId) which transitions to warm state.
      try {
        const { NodeLifecycle } = await import('../node-lifecycle');
        void NodeLifecycle; // imported for type only; DO stub is from env binding
        const doId = rc.env.NODE_LIFECYCLE.idFromName(state.stepResults.nodeId);
        const stub = rc.env.NODE_LIFECYCLE.get(doId) as DurableObjectStub<
          import('../node-lifecycle').NodeLifecycle
        >;
        await stub.markIdle(
          state.stepResults.nodeId,
          state.userId,
          state.config.projectScaling?.warmNodeTimeoutMs
        );

        log.info('task_runner_do.cleanup.node_marked_warm_direct', {
          taskId: state.taskId,
          nodeId: state.stepResults.nodeId,
        });
        await wakeVmAdmissionWaiters(rc.env, {
          userId: state.userId,
          reason: 'node_marked_warm_direct',
        });
      } catch (err) {
        log.error('task_runner_do.cleanup.node_warm_failed', {
          taskId: state.taskId,
          nodeId: state.stepResults.nodeId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
