/**
 * State machine helpers for the TaskRunner DO.
 *
 * Handles session linking, task status transitions (in_progress, failed),
 * cleanup on failure, and D1 execution step updates.
 */
import { log } from '../../lib/logger';
import { syncTriggerExecutionStatus } from '../../services/trigger-execution-sync';
import type { TaskRunnerContext, TaskRunnerState } from './types';

// =========================================================================
// Session linking
// =========================================================================

/**
 * TDF-6: Ensure the chat session is linked to the workspace in both D1 and the
 * ProjectData DO. This is idempotent — safe to call on every retry/recovery.
 *
 * D1 update is done FIRST and separately because:
 * - D1 chat_session_id on workspace is used by idle cleanup and task completion hooks
 * - Even if the DO call fails, D1 must have the link for downstream correctness
 */
export async function ensureSessionLinked(
  state: TaskRunnerState,
  workspaceId: string,
  rc: TaskRunnerContext,
): Promise<void> {
  if (!state.stepResults.chatSessionId) return;

  const now = new Date().toISOString();

  // Step 1: Update D1 workspace record (critical — used by idle cleanup, task hooks)
  // This is idempotent: setting chat_session_id to the same value is fine.
  try {
    await rc.env.DATABASE.prepare(
      `UPDATE workspaces SET chat_session_id = ?, updated_at = ? WHERE id = ?`
    ).bind(state.stepResults.chatSessionId, now, workspaceId).run();

    log.info('task_runner_do.session_d1_linked', {
      taskId: state.taskId,
      sessionId: state.stepResults.chatSessionId,
      workspaceId,
    });
  } catch (err) {
    // D1 link failure is blocking — without chatSessionId in D1, the message
    // ingestion endpoint will reject all messages for this workspace.
    log.error('task_runner_do.session_d1_link_failed', {
      taskId: state.taskId,
      sessionId: state.stepResults.chatSessionId,
      workspaceId,
      error: err instanceof Error ? err.message : String(err),
    });
    // Mark as permanent so the task runner fails immediately rather than
    // burning all retry budget on a non-retryable D1 constraint violation.
    const permanentError = new Error(
      `Failed to link chatSessionId to workspace ${workspaceId} in D1: ${err instanceof Error ? err.message : String(err)}`
    );
    (permanentError as Error & { permanent: boolean }).permanent = true;
    throw permanentError;
  }

  // Step 2: Update ProjectData DO session record (best-effort — enriches session data)
  // linkSessionToWorkspace in the DO is also idempotent (updates workspace_id).
  try {
    const projectDataService = await import('../../services/project-data');
    await projectDataService.linkSessionToWorkspace(
      rc.env,
      state.projectId,
      state.stepResults.chatSessionId,
      workspaceId,
    );

    log.info('task_runner_do.session_linked_to_workspace', {
      taskId: state.taskId,
      sessionId: state.stepResults.chatSessionId,
      workspaceId,
    });
  } catch (err) {
    // DO link failure is best-effort — session still works without workspace_id
    // in the DO's SQLite. The D1 link above handles downstream needs.
    log.error('task_runner_do.session_do_link_failed', {
      taskId: state.taskId,
      sessionId: state.stepResults.chatSessionId,
      workspaceId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// =========================================================================
// Task status transitions
// =========================================================================

/**
 * Transition the task to in_progress and mark the DO as done.
 */
export async function transitionToInProgress(
  state: TaskRunnerState,
  rc: TaskRunnerContext,
): Promise<void> {
  const now = new Date().toISOString();

  // Optimistic lock: only transition if still delegated
  const result = await rc.env.DATABASE.prepare(
    `UPDATE tasks SET status = 'in_progress', started_at = ?, execution_step = 'running', updated_at = ? WHERE id = ? AND status = 'delegated'`
  ).bind(now, now, state.taskId).run();

  if (!result.meta.changes || result.meta.changes === 0) {
    log.warn('task_runner_do.aborted_by_recovery', {
      taskId: state.taskId,
      step: 'in_progress_transition',
    });
    state.completed = true;
    await rc.ctx.storage.put('state', state);
    return;
  }

  // Record status event
  const { ulid } = await import('../../lib/ulid');
  await rc.env.DATABASE.prepare(
    `INSERT INTO task_status_events (id, task_id, from_status, to_status, actor_type, actor_id, reason, created_at)
     VALUES (?, ?, 'delegated', 'in_progress', 'system', NULL, ?, ?)`
  ).bind(
    ulid(),
    state.taskId,
    `Agent session ${state.stepResults.agentSessionId} created. Task execution started.`,
    now,
  ).run();

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
  rc: TaskRunnerContext,
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
    `SELECT status, mission_id FROM tasks WHERE id = ?`
  ).bind(state.taskId).first<{ status: string; mission_id: string | null }>();

  const currentStatus = task?.status;
  if (currentStatus === 'failed' || currentStatus === 'completed' || currentStatus === 'cancelled') {
    // Already terminal — skip
    state.completed = true;
    await rc.ctx.storage.put('state', state);
    return;
  }

  // Fail the task
  await rc.env.DATABASE.prepare(
    `UPDATE tasks SET status = 'failed', execution_step = NULL, error_message = ?, completed_at = ?, updated_at = ? WHERE id = ?`
  ).bind(errorMessage, now, now, state.taskId).run();

  // Sync trigger execution status (best-effort) — without this, cron triggers
  // with skipIfRunning=true permanently stop firing because the execution stays 'running'.
  await syncTriggerExecutionStatus(rc.env.DATABASE, state.taskId, 'failed', errorMessage);

  const { ulid } = await import('../../lib/ulid');
  await rc.env.DATABASE.prepare(
    `INSERT INTO task_status_events (id, task_id, from_status, to_status, actor_type, actor_id, reason, created_at)
     VALUES (?, ?, ?, 'failed', 'system', NULL, ?, ?)`
  ).bind(ulid(), state.taskId, currentStatus || 'queued', errorMessage, now).run();

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

  // Write to observability database
  try {
    await rc.env.OBSERVABILITY_DATABASE.prepare(
      `INSERT INTO errors (id, source, level, message, stack, context, user_id, node_id, workspace_id, ip_address, user_agent, timestamp)
       VALUES (?, 'api', 'error', ?, NULL, ?, ?, ?, ?, NULL, NULL, ?)`
    ).bind(
      ulid(),
      `Task ${state.taskId} failed at step ${state.currentStep}: ${errorMessage}`,
      JSON.stringify({
        taskId: state.taskId,
        projectId: state.projectId,
        step: state.currentStep,
        retryCount: state.retryCount,
      }),
      state.userId,
      state.stepResults.nodeId,
      state.stepResults.workspaceId,
      now,
    ).run();
  } catch (err) {
    log.error('task_runner_do.observability_write_failed', {
      taskId: state.taskId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Best-effort: inject error into chat session and stop the session so the UI
  // shows the failure. Without stopSession, the session stays "active" in the
  // sidebar even though the task has failed.
  if (state.stepResults.chatSessionId && state.projectId) {
    try {
      const { persistMessage, stopSession } = await import('../../services/project-data');
      await persistMessage(
        rc.env,
        state.projectId,
        state.stepResults.chatSessionId,
        'system',
        `Task failed at step "${state.currentStep}": ${errorMessage}`,
        null
      );
      await stopSession(
        rc.env,
        state.projectId,
        state.stepResults.chatSessionId
      );
    } catch (chatErr) {
      log.error('task_runner_do.chat_error_inject_failed', {
        taskId: state.taskId,
        sessionId: state.stepResults.chatSessionId,
        error: chatErr instanceof Error ? chatErr.message : String(chatErr),
      });
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

  // Best-effort cleanup
  await cleanupOnFailure(state, rc);

  state.completed = true;
  await rc.ctx.storage.put('state', state);
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
): Promise<void> {
  const now = new Date().toISOString();

  // Stop workspace if one was created
  if (state.stepResults.workspaceId && state.stepResults.nodeId) {
    try {
      const { stopWorkspaceOnNode } = await import('../../services/node-agent');
      await stopWorkspaceOnNode(
        state.stepResults.nodeId,
        state.stepResults.workspaceId,
        rc.env,
        state.userId,
      );
    } catch (err) {
      log.error('task_runner_do.cleanup.workspace_stop_failed', {
        taskId: state.taskId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    await rc.env.DATABASE.prepare(
      `UPDATE workspaces SET status = 'stopped', updated_at = ? WHERE id = ?`
    ).bind(now, state.stepResults.workspaceId).run();

    // Stop compute usage metering (best-effort)
    try {
      const { drizzle } = await import('drizzle-orm/d1');
      const dbSchema = await import('../../db/schema');
      const { stopComputeTracking } = await import('../../services/compute-usage');
      const db = drizzle(rc.env.DATABASE, { schema: dbSchema });
      await stopComputeTracking(db, state.stepResults.workspaceId);
    } catch (err) {
      log.error('task_runner_do.cleanup.compute_tracking_stop_failed', {
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
        const stub = rc.env.NODE_LIFECYCLE.get(doId) as DurableObjectStub<import('../node-lifecycle').NodeLifecycle>;
        await stub.markIdle(state.stepResults.nodeId, state.userId, state.config.projectScaling?.warmNodeTimeoutMs);

        log.info('task_runner_do.cleanup.node_marked_warm_direct', {
          taskId: state.taskId,
          nodeId: state.stepResults.nodeId,
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
