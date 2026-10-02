/**
 * MCP stop_subtask — gracefully stops a direct child agent's session with an
 * optional warning message, then records the cancellation.
 */
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { ulid } from '../../lib/ulid';
import { sendPromptToAgentOnNode, stopAgentSessionOnNode } from '../../services/node-agent';
import { cleanupTerminalTaskResources } from '../../services/task-terminal-cleanup';
import { syncTriggerExecutionStatus } from '../../services/trigger-execution-sync';
import {
  ACTIVE_STATUSES,
  getMcpLimits,
  INTERNAL_ERROR,
  INVALID_PARAMS,
  jsonRpcError,
  type JsonRpcResponse,
  jsonRpcSuccess,
  type McpTokenData,
  sanitizeUserInput,
} from './_helpers';
import { denyWhenMcpActorLacksCurrentProjectCapability } from './orchestration-authority';
import { isError, resolveAgentTarget } from './orchestration-target';

export async function handleStopSubtask(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env
): Promise<JsonRpcResponse> {
  const limits = getMcpLimits(env);

  // Validate params
  const taskId = typeof params.taskId === 'string' ? params.taskId.trim() : '';
  if (!taskId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'taskId is required');
  }

  const reason =
    typeof params.reason === 'string'
      ? sanitizeUserInput(params.reason.trim()).slice(0, limits.orchestratorMessageMaxLength)
      : undefined;

  // Resolve child agent. stop_subtask is destructive, so it intentionally keeps
  // the direct-parent restriction while send_message_to_subtask is project-scoped.
  const db = drizzle(env.DATABASE, { schema });

  // Same current-authority gate as retry_subtask (rule 61: one guard, every
  // entry point in the destructive child-control class). Runs before the
  // warning prompt, the hard agent stop, and the terminal task transition.
  const staleActor = await denyWhenMcpActorLacksCurrentProjectCapability(
    requestId,
    db,
    tokenData,
    'task:write',
    'stop_subtask'
  );
  if (staleActor) return staleActor;

  const resolution = await resolveAgentTarget(requestId, taskId, tokenData, db, {
    authorization: 'direct-child-control',
    targetLabel: 'Child task',
  });
  if (isError(resolution)) {
    return resolution;
  }

  const { task, workspace, agentSession } = resolution;

  // If reason provided, inject a final warning message (best-effort)
  if (reason) {
    try {
      await sendPromptToAgentOnNode(
        workspace.nodeId,
        workspace.id,
        agentSession.id,
        `[STOP REQUESTED BY PARENT] ${reason}`,
        env,
        tokenData.userId
      );
    } catch (err) {
      // Best-effort — don't fail the stop if the message can't be delivered (e.g., 409 busy)
      log.warn('mcp.stop_subtask.warning_message_failed', {
        parentTaskId: tokenData.taskId,
        childTaskId: taskId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Grace period to let the agent process the warning (capped at 30s to prevent misconfiguration)
    const gracePeriodMs = Math.min(limits.orchestratorStopGraceMs, 30_000);
    await new Promise((resolve) => setTimeout(resolve, gracePeriodMs));
  }

  // Hard stop the agent session
  try {
    await stopAgentSessionOnNode(
      workspace.nodeId,
      workspace.id,
      agentSession.id,
      env,
      tokenData.userId
    );
  } catch (err) {
    log.error('mcp.stop_subtask.stop_failed', {
      parentTaskId: tokenData.taskId,
      childTaskId: taskId,
      agentSessionId: agentSession.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return jsonRpcError(
      requestId,
      INTERNAL_ERROR,
      `Failed to stop child agent session: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // An intentional parent stop is a cancellation, not a runtime failure. Use a
  // compare-and-set transition so a concurrent fatal callback keeps the actual
  // failure as the authoritative terminal story.
  const now = new Date().toISOString();
  const stopReason = reason ? `Stopped by parent: ${reason}` : 'Stopped by parent';

  let preservedTerminalStatus: string | null = null;
  try {
    const cancelFromStatus = async (fromStatus: string): Promise<boolean> => {
      const [transition] = await env.DATABASE.batch([
        env.DATABASE.prepare(
          `UPDATE tasks
              SET status = 'cancelled', error_message = ?, completed_at = ?, updated_at = ?
            WHERE id = ? AND status = ?`
        ).bind(stopReason, now, now, taskId, fromStatus),
        env.DATABASE.prepare(
          `INSERT INTO task_status_events
             (id, task_id, from_status, to_status, actor_type, actor_id, reason, created_at)
           SELECT ?, ?, ?, 'cancelled', 'agent', ?, ?, ?
            WHERE EXISTS (
              SELECT 1 FROM tasks
               WHERE id = ? AND status = 'cancelled' AND completed_at = ?
            )`
        ).bind(ulid(), taskId, fromStatus, tokenData.workspaceId, stopReason, now, taskId, now),
      ]);
      if (!transition) {
        throw new Error('Task cancellation returned no transition result');
      }
      return Boolean(transition.meta.changes);
    };

    let cancelled = false;
    let fromStatus = task.status;
    for (let attempt = 1; attempt <= limits.orchestratorStopCasMaxAttempts; attempt += 1) {
      cancelled = await cancelFromStatus(fromStatus);
      if (cancelled) break;

      const current = await env.DATABASE.prepare('SELECT status FROM tasks WHERE id = ?')
        .bind(taskId)
        .first<{ status: string }>();
      if (!current) throw new Error('Child task disappeared during cancellation');
      if (
        current.status === 'completed' ||
        current.status === 'failed' ||
        current.status === 'cancelled'
      ) {
        log.info('mcp.stop_subtask.terminal_state_preserved', {
          parentTaskId: tokenData.taskId,
          childTaskId: taskId,
          attemptedFromStatus: fromStatus,
          currentStatus: current.status,
        });
        preservedTerminalStatus = current.status;
        break;
      }
      if (!ACTIVE_STATUSES.includes(current.status)) {
        throw new Error(
          `Child task entered unexpected status '${current.status}' during cancellation`
        );
      }
      if (attempt === limits.orchestratorStopCasMaxAttempts) {
        throw new Error(
          `Child task remained active after ${limits.orchestratorStopCasMaxAttempts} cancellation attempts`
        );
      }
      log.warn('mcp.stop_subtask.status_cas_retry', {
        parentTaskId: tokenData.taskId,
        childTaskId: taskId,
        attempt,
        maxAttempts: limits.orchestratorStopCasMaxAttempts,
        attemptedFromStatus: fromStatus,
        currentStatus: current.status,
      });
      fromStatus = current.status;
    }
    if (!cancelled && !preservedTerminalStatus) {
      throw new Error('Task cancellation did not reach a terminal state');
    }
  } catch (err) {
    log.error('mcp.stop_subtask.status_update_failed', {
      parentTaskId: tokenData.taskId,
      childTaskId: taskId,
      error: err instanceof Error ? err.message : String(err),
    });
    return jsonRpcError(
      requestId,
      INTERNAL_ERROR,
      'Child agent stopped, but task cancellation failed'
    );
  }

  if (preservedTerminalStatus) {
    return jsonRpcSuccess(requestId, {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            stopped: true,
            taskId,
            terminalStatePreserved: true,
            status: preservedTerminalStatus,
          }),
        },
      ],
    });
  }

  await syncTriggerExecutionStatus(env.DATABASE, taskId, 'cancelled');
  try {
    await cleanupTerminalTaskResources(env, taskId, {
      status: 'cancelled',
      errorMessage: stopReason,
      requiredUserId: tokenData.userId,
      logContext: { projectId: task.projectId, source: 'mcp.stop_subtask' },
    });
  } catch (err) {
    log.error('mcp.stop_subtask.terminal_cleanup_failed', {
      parentTaskId: tokenData.taskId,
      childTaskId: taskId,
      error: err instanceof Error ? err.message : String(err),
    });
    return jsonRpcError(
      requestId,
      INTERNAL_ERROR,
      'Task was cancelled, but runtime cleanup failed'
    );
  }

  log.info('mcp.stop_subtask.completed', {
    parentTaskId: tokenData.taskId,
    childTaskId: taskId,
    workspaceId: workspace.id,
    agentSessionId: agentSession.id,
    reason: stopReason,
  });

  return jsonRpcSuccess(requestId, {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ stopped: true, taskId }),
      },
    ],
  });
}
